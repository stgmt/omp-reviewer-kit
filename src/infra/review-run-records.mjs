import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  REVIEW_RUN_RECORD_SCHEMA,
  TERMINAL_RUN_STATES,
  pidLiveness,
  resolveRunsDir,
} from './filesystem-telemetry-adapter.mjs';

/** A live run silent for longer than this is reported as quiet. It is never stopped for being quiet. */
export const DEFAULT_QUIET_MS = 10 * 60 * 1000;

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const VERDICT_BY_STATE = Object.freeze({
  passed: 'PASS',
  blocked: 'BLOCK',
  failed: 'FAILED',
  skipped: 'SKIPPED',
  interrupted: 'INTERRUPTED',
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} OMP_REVIEW_KIT_QUIET_MS when it is a positive number, else the default.
 */
export function quietThresholdMs(env = process.env) {
  const raw = Number(env.OMP_REVIEW_KIT_QUIET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUIET_MS;
}

/**
 * Reads one per-run record. Anything that is not a run record (missing, partly
 * written, foreign) yields null, so one bad file never hides the other runs.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {Promise<object|null>}
 */
export async function readRunRecord(runsDir, runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return null;
  try {
    const record = JSON.parse(await readFile(path.join(runsDir, `${runId}.json`), 'utf8'));
    return record?.schema === REVIEW_RUN_RECORD_SCHEMA && typeof record.runId === 'string' ? record : null;
  } catch {
    return null;
  }
}

/**
 * Whether the record file of `runId` exists, even while it cannot be read yet.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
export async function runRecordExists(runsDir, runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return false;
  try {
    await stat(path.join(runsDir, `${runId}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every run record in `runsDir`, newest start first.
 *
 * @param {string} [runsDir]
 * @returns {Promise<object[]>}
 */
export async function readRunRecords(runsDir = resolveRunsDir()) {
  let names;
  try {
    names = await readdir(runsDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readRunRecord(runsDir, name.slice(0, -'.json'.length));
    if (record) records.push(record);
  }
  return records.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
}

/**
 * Record files that cannot be read and were written within `windowMs`. Such a file may be a run that is being
 * written right now, so a lookup must not conclude that no run exists. An older unreadable file is a torn
 * leftover and is not waited for.
 *
 * @param {string} runsDir
 * @param {{ now?: number, windowMs?: number }} [options]
 * @returns {Promise<number>}
 */
export async function recentlyUnreadableRunFiles(runsDir, { now = Date.now(), windowMs = DEFAULT_QUIET_MS } = {}) {
  let names;
  try {
    names = await readdir(runsDir);
  } catch {
    return 0;
  }
  let recent = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -'.json'.length);
    if (!RUN_ID_PATTERN.test(runId) || (await readRunRecord(runsDir, runId))) continue;
    try {
      if (now - (await stat(path.join(runsDir, name))).mtimeMs < windowMs) recent += 1;
    } catch {
      // Pruned between the listing and the stat: there is nothing to wait for.
    }
  }
  return recent;
}

/**
 * The latest moment the run showed life: its OMP child wrote to its log, a stage
 * changed, or the run started. The runner heartbeat is not counted, because it
 * keeps ticking while the model is silent.
 *
 * @param {object} record
 * @returns {number|null} epoch milliseconds
 */
export function lastActivityMs(record) {
  const stamps = [record.childLogAt, record.progressAt, record.startedAt]
    .map((value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * How a run looks right now. Read-only: a quiet or orphaned run is reported,
 * never stopped or changed here.
 *
 * @param {object} record
 * @param {{ now?: number, quietMs?: number, liveness?: (pid: unknown) => string }} [options]
 * @returns {'done'|'orphaned'|'quiet'|'active'}
 */
export function classifyRun(record, { now = Date.now(), quietMs = DEFAULT_QUIET_MS, liveness = pidLiveness } = {}) {
  if (TERMINAL_RUN_STATES.has(record.state)) return 'done';
  if (liveness(record.runnerPid) === 'dead') return 'orphaned';
  const last = lastActivityMs(record);
  return last !== null && now - last > quietMs ? 'quiet' : 'active';
}

/**
 * @param {object} record
 * @param {{ now?: number, quietMs?: number, liveness?: (pid: unknown) => string }} [options]
 * @returns {object} the fields the CLI, the extension and the session summary print
 */
export function summarizeRun(record, options = {}) {
  const now = options.now ?? Date.now();
  const last = lastActivityMs(record);
  return {
    runId: record.runId,
    repoRoot: typeof record.repoRoot === 'string' ? record.repoRoot : null,
    tag: typeof record.tag === 'string' ? record.tag : null,
    state: typeof record.state === 'string' ? record.state : 'unknown',
    classification: classifyRun(record, { ...options, now }),
    verdict: VERDICT_BY_STATE[record.state] ?? null,
    stage: typeof record.stage === 'string' ? record.stage : null,
    stagesCompleted: Number.isInteger(record.stagesCompleted) ? record.stagesCompleted : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    silentForMs: last === null ? null : Math.max(0, now - last),
    runnerPid: Number.isInteger(record.runnerPid) ? record.runnerPid : null,
    childPid: Number.isInteger(record.pid) ? record.pid : null,
    diffHash: typeof record.diffHash === 'string' ? record.diffHash : null,
    parentSha: typeof record.parentSha === 'string' ? record.parentSha : null,
    excludedPaths: Array.isArray(record.excludedPaths) ? record.excludedPaths : [],
    reportPath: typeof record.reportPath === 'string' ? record.reportPath : null,
    cached: record.cached === true,
  };
}

/**
 * Repository paths compare equal when they name the same folder. Windows paths
 * are case-insensitive, so both sides are lowered there.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameRepo(a, b) {
  const left = normalizeRepoPath(a);
  return left !== null && left === normalizeRepoPath(b);
}

function normalizeRepoPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Picks the records a view shows. Precedence: one run, then this session's tag
 * across repositories, then every run, then the runs of one repository.
 *
 * @param {object[]} records
 * @param {{ repoRoot?: string|null, tag?: string|null, runId?: string|null, all?: boolean }} [scope]
 * @returns {object[]}
 */
export function selectRuns(records, { repoRoot = null, tag = null, runId = null, all = false } = {}) {
  if (runId) return records.filter((record) => record.runId === runId);
  if (tag) return records.filter((record) => record.tag === tag);
  if (all) return records;
  return records.filter((record) => sameRepo(record.repoRoot, repoRoot));
}

/**
 * Runs whose reviewed diff is the diff of one commit. The commit's diff must be
 * hashed with each run's own excluded paths, so `diffHashOf` takes them.
 *
 * @param {object[]} records
 * @param {{ parentSha: string|null, diffHashOf: (excludedPaths: string[]) => Promise<string|null> }} query
 * @returns {Promise<object[]>}
 */
export async function runsForCommit(records, { parentSha, diffHashOf }) {
  const hashes = new Map();
  const matches = [];
  for (const record of records) {
    if ((record.parentSha ?? null) !== (parentSha ?? null) || typeof record.diffHash !== 'string') continue;
    const excluded = Array.isArray(record.excludedPaths) ? record.excludedPaths : [];
    const key = JSON.stringify(excluded);
    if (!hashes.has(key)) hashes.set(key, await diffHashOf(excluded));
    if (hashes.get(key) === record.diffHash) matches.push(record);
  }
  return matches;
}

/** @param {number|null} ms */
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Column-aligned text table. The last column is not padded.
 *
 * @param {string[][]} rows first row is the header
 * @returns {string}
 */
export function formatTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column] ?? '').length)));
  return rows
    .map((row) => row
      .map((cell, column) => (column === row.length - 1 ? String(cell ?? '') : String(cell ?? '').padEnd(widths[column])))
      .join('  ')
      .trimEnd())
    .join('\n');
}

/**
 * @param {object[]} summaries from summarizeRun
 * @param {{ withRepo?: boolean }} [options]
 * @returns {string}
 */
export function formatRunTable(summaries, { withRepo = false } = {}) {
  if (summaries.length === 0) return 'No review runs.';
  const header = ['RUN', 'STATE', 'STAGE', 'SILENT', 'VERDICT', 'TAG'];
  if (withRepo) header.push('REPO');
  const rows = summaries.map((summary) => {
    const row = [
      summary.runId,
      summary.classification,
      summary.stage ?? '-',
      formatDuration(summary.silentForMs),
      summary.verdict ?? '-',
      summary.tag ? summary.tag.slice(0, 12) : '-',
    ];
    if (withRepo) row.push(summary.repoRoot ? path.basename(summary.repoRoot) : '-');
    return row;
  });
  return formatTable([header, ...rows]);
}

/**
 * Multi-line view of one run. Quiet and orphaned runs get the facts a person
 * needs to decide what to do; the kit never stops a quiet or orphaned run. A
 * run on an older runner is stopped when a newer plugin starts (see
 * superseded-run-stopper).
 *
 * @param {object} summary from summarizeRun
 * @param {{ followCommand?: string }} [options] command that follows this run
 * @returns {string}
 */
export function formatRunDetail(summary, { followCommand = null } = {}) {
  const lines = [
    `run:        ${summary.runId}`,
    `state:      ${summary.classification} (${summary.state})`,
    `stage:      ${summary.stage ?? '-'}${summary.stagesCompleted !== null ? `, ${summary.stagesCompleted} stage(s) done` : ''}`,
    `silent for: ${formatDuration(summary.silentForMs)}`,
    `verdict:    ${summary.verdict ?? '-'}`,
    `repo:       ${summary.repoRoot ?? '-'}`,
    `session:    ${summary.tag ?? '-'}`,
    `runner pid: ${summary.runnerPid ?? '-'}`,
    `review pid: ${summary.childPid ?? '-'}`,
  ];
  if (summary.reportPath) lines.push(`report:     ${summary.reportPath}`);
  if (summary.classification === 'active' && followCommand) {
    lines.push(`follow:     ${followCommand}`);
  }
  if (summary.classification === 'quiet') {
    lines.push(
      'The review is still running but has written nothing for a while. It may be waiting on the model.',
      `Only you can decide to stop it. To stop it yourself: ${killHint(summary.childPid)}`,
      'A stopped review blocks its commit. Nothing here stops it.',
    );
  }
  if (summary.classification === 'orphaned') {
    lines.push(
      'The runner process is gone and no finish was recorded. The commit did not complete.',
      'OMP logs are in ~/.omp/logs (match the review pid in the file name).',
    );
  }
  return lines.join('\n');
}

function killHint(pid) {
  if (!Number.isInteger(pid)) return '(no review pid recorded)';
  return process.platform === 'win32' ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`;
}

/** A repository's unfinished runs are mentioned at session start only while recently updated. */
const ATTENTION_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Unfinished runs worth a session-start mention: this session's runs in any
 * repository, and runs of this repository updated within the attention window.
 * Old orphans therefore do not appear in every session.
 *
 * @param {object[]} records
 * @param {{ repoRoot?: string|null, tag?: string|null, now?: number, quietMs?: number, liveness?: (pid: unknown) => string }} [scope]
 * @returns {object[]} summaries from summarizeRun
 */
export function runsNeedingAttention(records, { repoRoot = null, tag = null, now = Date.now(), quietMs, liveness } = {}) {
  return records
    .filter((record) => {
      if (tag && record.tag === tag) return true;
      const updated = Date.parse(record.updatedAt ?? '');
      return sameRepo(record.repoRoot, repoRoot) && Number.isFinite(updated) && now - updated <= ATTENTION_WINDOW_MS;
    })
    .map((record) => summarizeRun(record, { now, quietMs, liveness }))
    .filter((summary) => summary.classification !== 'done');
}

/**
 * One line for the SessionStart context, or '' when nothing needs attention.
 *
 * @param {object[]} summaries from runsNeedingAttention
 * @returns {string}
 */
export function summaryLine(summaries) {
  if (summaries.length === 0) return '';
  const parts = summaries.slice(0, 3).map((summary) => {
    const stage = summary.stage ? `, stage ${summary.stage}` : '';
    return `${summary.runId} (${summary.classification}${stage})`;
  });
  const more = summaries.length > 3 ? ` and ${summaries.length - 3} more` : '';
  return `${summaries.length} commit review(s) not finished: ${parts.join('; ')}${more}. Check with the review-progress skill before committing again.`;
}

/**
 * Exit code for a run that is being followed: 0 the commit may go ahead, 1 it is
 * blocked or failed, 3 the run is quiet or orphaned. Null while it is still active.
 *
 * @param {{ classification: string, state: string }} summary
 * @returns {0|1|3|null}
 */
export function followExitCode(summary) {
  if (summary.classification === 'active') return null;
  if (summary.classification === 'quiet' || summary.classification === 'orphaned') return 3;
  return summary.state === 'passed' || summary.state === 'skipped' ? 0 : 1;
}
