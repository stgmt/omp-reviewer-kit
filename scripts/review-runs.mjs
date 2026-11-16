#!/usr/bin/env node
// Read-only view of the review run records. Usage:
//   node scripts/review-runs.mjs                 the last 10 runs of this machine
//   node scripts/review-runs.mjs --all           every kept run
//   node scripts/review-runs.mjs --repo <path>   runs of one repository
//   node scripts/review-runs.mjs --run <runId>   one record, in full
//   node scripts/review-runs.mjs --status        is the review working, quiet, stalled or orphaned?
//   node scripts/review-runs.mjs --json          the same data as machine-readable JSON
//   node scripts/review-runs.mjs --follow <id>   watch a running review until it settles
// Exit 0 when something was found, 1 when nothing matched, 2 on a usage error. This command never
// writes, never stops a review and never changes a verdict.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatLivenessLine } from '../src/domain/review-liveness.mjs';
import { gitCommitWaiting, probeRun } from '../src/infra/review-liveness-probe.mjs';
import { resolveStageTimeout } from '../src/native/task-engine.mjs';

import { TERMINAL_RUN_STATES, formatDuration, stageSummaryLine } from '../src/domain/review-run-summary.mjs';
import { isRunAlive, latestRunRecord, readRunRecord, readRunRecords, runRecordFile, runsRootDir } from '../src/infra/review-run-store.mjs';

const DEFAULT_LIMIT = 10;
const FOLLOW_INTERVAL_MS = 500;

/**
 * `--flag value` and `--flag=value` in one small parser: the CLI takes no positionals.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { mode: 'list', limit: DEFAULT_LIMIT, json: false, repo: null, runId: null, timeoutMs: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      index += 1;
      const next = argv[index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case '--all':
        options.mode = 'all';
        break;
      case '--last':
        options.mode = 'last';
        break;
      case '--status':
        options.mode = 'status';
        break;
      case '--json':
        options.json = true;
        break;
      case '--repo':
        options.repo = path.resolve(take());
        break;
      case '--run':
        options.runId = take();
        break;
      case '--follow':
        options.mode = 'follow';
        options.runId = take();
        break;
      case '--timeout': {
        const seconds = Number(take());
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout needs a positive number of seconds');
        options.timeoutMs = seconds * 1000;
        break;
      }
      case '--help':
      case '-h':
        options.mode = 'help';
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

/** One table row per record. */
export function formatRunLine(record) {
  const label = record.verdict ?? String(record.state ?? 'unknown').toUpperCase();
  const state = String(label).padEnd(8);
  const duration = formatDuration(record.durationMs);
  const repo = record.repoName ?? 'unknown';
  const stages = stageSummaryLine(record.stages);
  return `${record.runId}  ${state} ${duration}  ${repo}${stages.length > 0 ? `  ${stages}` : ''}`;
}

export const HELP = `Usage: node scripts/review-runs.mjs [--last] [--all] [--status] [--repo <path>] [--run <runId>] [--json] [--follow <runId>] [--timeout <seconds>]

Records live in <home>/.omp/review-kit-runs, or OMP_REVIEW_KIT_RUNS_DIR when set.`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Prints each stage transition of one run until it settles. Read-only: the follow never touches the
 * file, never signals a process, and gives up when its optional timeout expires.
 *
 * @param {{ dir: string, runId: string, out: (line: string) => void, timeoutMs?: number|null, intervalMs?: number, now?: () => number }} input
 * @returns {Promise<boolean>} whether the run settled
 */
export async function followRun({ dir, runId, out, timeoutMs = null, intervalMs = FOLLOW_INTERVAL_MS, now = () => Date.now() }) {
  const started = now();
  const seen = new Map();
  let announced = false;
  for (;;) {
    const record = await readRunRecord(runRecordFile(dir, runId));
    if (!record) {
      if (!announced) out(`run ${runId} not found in ${dir}`);
      return false;
    }
    announced = true;
    for (const stage of record.stages) {
      const key = `${stage.agent}|${stage.lane ?? ''}`;
      const signature = `${stage.status}|${stage.durationMs ?? ''}|${stage.tokens ?? ''}`;
      if (seen.get(key) === signature) continue;
      seen.set(key, signature);
      out(`stage ${stage.agent}${stage.lane ? ` lane=${stage.lane}` : ''} ${stage.status ?? 'running'} ${formatDuration(stage.durationMs)}`);
    }
    if (TERMINAL_RUN_STATES.includes(record.state)) {
      out(formatRunLine(record));
      return true;
    }
    if (!isRunAlive(record)) {
      out(`run ${runId} is no longer running and did not settle (interrupted)`);
      out(formatRunLine(record));
      return false;
    }
    if (timeoutMs !== null && now() - started > timeoutMs) {
      out(`run ${runId} still running after ${formatDuration(now() - started)}; stopped watching`);
      return false;
    }
    await sleep(intervalMs);
  }
}

/**
 * Liveness of every unfinished review, and of the newest finished one when nothing is running. The
 * facts come from three places and none of them is a guess: the record's own age is the age of the
 * last progress write, the operating system answers whether the runner process is still ours, and
 * the git process table says whether a commit is still waiting for the verdict.
 *
 * @param {{
 *   dir: string,
 *   records: object[],
 *   out: (line: string) => void,
 *   json?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   probe?: typeof probeRun,
 *   deadlineMs?: number,
 * }} input
 * @returns {Promise<number>} exit code: 0 when something was reported
 */
export async function statusReport({
  dir,
  records,
  out,
  json = false,
  env = process.env,
  now = () => Date.now(),
  probe = probeRun,
  deadlineMs = resolveStageTimeout(env),
}) {
  const at = now();
  // Status answers one question: is something running, and is it alive? Finished runs are history,
  // so only the newest one is shown for context; abandoned records are shown only while they are
  // fresh, and the rest are counted so a month of dead records cannot bury the live one.
  const running = records.filter(record => !TERMINAL_RUN_STATES.includes(record.state));
  const finished = records.filter(record => TERMINAL_RUN_STATES.includes(record.state));
  const rows = [];
  // One process-table read per repository for the whole report, not one per record.
  const waiters = new Map();
  const waiter = repoRoot => {
    if (!waiters.has(repoRoot)) waiters.set(repoRoot, gitCommitWaiting(repoRoot));
    return waiters.get(repoRoot);
  };
  for (const record of running) rows.push(await probe(record, { dir, now: at, deadlineMs, waiter }));
  // `unknown` is not a live review either: a record that cannot be judged counts as abandoned for
  // display, and is shown only while it is fresh.
  const aliveNow = rows.filter(row => row.kind !== 'exited' && row.kind !== 'unknown');
  const fresh = aliveNow.length === 0 && rows.length > 0 ? rows.filter(row => withinWindow(recordOf(records, row.runId), at)).slice(0, STATUS_ABANDONED_LIMIT) : aliveNow;
  const shown = fresh.length > 0 ? fresh : (await Promise.all(finished.slice(0, 1).map(record => probe(record, { dir, now: at, deadlineMs }))));
  if (shown.length === 0) {
    if (rows.length > 0) {
      if (json) out('[]');
      else out(`no review is running; ${rows.length} unfinished record(s) from earlier (--all lists them)`);
      return 0;
    }
    if (json) out('[]');
    else out(`no review runs in ${dir}`);
    return 1;
  }
  for (const row of shown) {
    if (json) continue;
    out(formatLivenessLine(row.runId, row));
  }
  // The machine-readable form is one document and nothing else: prose after the closing bracket
  // makes it unparseable exactly when there is history to explain.
  if (json) out(JSON.stringify(shown, null, 2));
  // The finished-fallback row is not one of the unfinished rows, so it must not be subtracted:
  // only rows that are really shown among the unfinished ones reduce the hidden count.
  const hidden = shown.every(row => rows.includes(row)) ? rows.length - shown.length : rows.length;
  if (hidden > 0 && !json) out(`plus ${hidden} older unfinished record(s); --all lists them`);
  return 0;
}

/** How many abandoned records a status report shows before it only counts them. */
const STATUS_ABANDONED_LIMIT = 2;

/** Abandoned records older than this are history, not status. */
const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

function recordOf(records, runId) {
  return records.find(record => record.runId === runId) ?? null;
}

function withinWindow(record, at) {
  const started = Date.parse(record?.startedAt ?? '');
  return Number.isFinite(started) && at - started <= STATUS_WINDOW_MS;
}

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, env?: NodeJS.ProcessEnv }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`), env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(HELP);
    return 2;
  }
  if (options.mode === 'help') {
    out(HELP);
    return 0;
  }
  const dir = runsRootDir({ env });

  if (options.mode === 'follow') {
    const settled = await followRun({ dir, runId: options.runId, out, timeoutMs: options.timeoutMs });
    return settled ? 0 : 1;
  }
  if (options.mode === 'status') {
    const all = await readRunRecords({ dir, repoRoot: options.repo ?? undefined });
    return statusReport({ dir, records: all, out, json: options.json, env });
  }

  if (options.runId) {
    const record = await readRunRecord(runRecordFile(dir, options.runId));
    if (!record) {
      err(`no run ${options.runId} in ${dir}`);
      return 1;
    }
    out(options.json ? JSON.stringify(record, null, 2) : formatRunDetail(record));
    return 0;
  }

  const limit = options.mode === 'all' ? undefined : options.limit;
  const records = await readRunRecords({ dir, limit, repoRoot: options.repo ?? undefined });
  if (records.length === 0) {
    if (options.json) out('[]');
    else err(`no run records in ${dir}`);
    return 1;
  }
  if (options.json) {
    out(JSON.stringify(records, null, 2));
    return 0;
  }
  const latest = options.mode === 'last' ? await latestRunRecord({ dir, repoRoot: options.repo ?? undefined }) : null;
  const shown = latest ? [latest] : records;
  for (const record of shown) out(formatRunLine(record));
  return 0;
}

/** One record as a short block: identity, timings, then a row per stage. */
export function formatRunDetail(record) {
  const lines = [
    `Run: ${record.runId}`,
    `State: ${record.state}${record.verdict ? ` (${record.verdict})` : ''}`,
    `Repository: ${record.repoRoot ?? 'unknown'}`,
    `Started: ${record.startedAt ?? 'unknown'}; duration: ${formatDuration(record.durationMs)}`,
  ];
  const lanes = Array.isArray(record.lanes) ? record.lanes : [];
  const stages = Array.isArray(record.stages) ? record.stages : [];
  const reasons = Array.isArray(record.reasons) ? record.reasons : [];
  if (record.profile) lines.push(`Profile: ${record.profile}; lanes: ${lanes.join(', ') || 'none'}`);
  if (record.reportPath) lines.push(`Report: ${record.reportPath}`);
  if (stages.length > 0) {
    lines.push('', 'Stage | Status | Duration | Tokens | Requests | Counts', '--- | --- | --- | --- | --- | ---');
    for (const stage of stages) {
      const counts = Object.entries(stage.counts ?? {}).map(([key, value]) => `${key} ${value}`).join(', ');
      lines.push(`${stage.agent ?? 'stage'} | ${stage.status ?? 'unknown'} | ${formatDuration(stage.durationMs)} | ${stage.tokens ?? 'unknown'} | ${stage.requests ?? 'unknown'} | ${counts || '-'}`);
    }
  }
  if (reasons.length > 0) {
    lines.push('', 'Reasons:', ...reasons.map(reason => `- ${reason}`));
  }
  const notes = Array.isArray(record.notes) ? record.notes : [];
  if (notes.length > 0) {
    lines.push('', 'Notes:', ...notes.map(note => `- ${note}`));
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
