// Pure value rules for one review run record: state words, duration formatting, stage counts and
// normalization. No file system, no process and no model lives here. The record is an observation
// of a review: nothing in this module can change a verdict or an exit code.

export const RUN_SCHEMA = 'review-run-record@2';
export const RUN_STATES = ['running', 'passed', 'blocked', 'failed', 'skipped', 'refused'];
export const TERMINAL_RUN_STATES = ['passed', 'blocked', 'failed', 'skipped', 'refused'];

/** Most keys one stage may report, so a runaway structured payload cannot bloat a record. */
const MAX_COUNT_KEYS = 16;

/**
 * The state word for a finished review. A skipped review never reached the reviewer.
 *
 * @param {{ pass: boolean } | undefined} verdict
 * @param {{ staged?: boolean }} [result]
 * @returns {'passed'|'blocked'|'failed'|'skipped'}
 */
export function runStateFor(verdict, result = {}) {
  if (result.staged === false) return 'skipped';
  // A refused diff never reached a reviewer: it is neither a pass nor a finding.
  if (result.refused) return 'refused';
  if (!verdict || typeof verdict.pass !== 'boolean') return 'failed';
  return verdict.pass ? 'passed' : 'blocked';
}

/**
 * Human duration: `820ms`, `95s`, `4m12s`, `1h05m`. Unknown input is `unknown`, never `NaN`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Counts of what a stage reported, never its content: every array becomes its length, every
 * finite number its value and every `true` a one. The stage's structured payload stays out of the
 * record, so no prompt text, file text or finding body is ever persisted.
 *
 * @param {object|null|undefined} data
 * @returns {Record<string, number>}
 */
export function stageCounts(data) {
  const counts = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return counts;
  for (const key of Object.keys(data).sort().slice(0, MAX_COUNT_KEYS)) {
    const value = data[key];
    if (Array.isArray(value)) counts[key] = value.length;
    else if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
    else if (value === true) counts[key] = 1;
  }
  return counts;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOrNull(value, limit = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, limit);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function countMap(value) {
  const counts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  for (const key of Object.keys(value).sort().slice(0, MAX_COUNT_KEYS)) {
    const number = finiteOrNull(value[key]);
    if (number !== null) counts[key] = number;
  }
  return counts;
}

/**
 * One stage of a record, reduced to the known observation fields.
 *
 * @param {object} stage
 */
export function normalizeStage(stage) {
  const entry = stage && typeof stage === 'object' ? stage : {};
  return {
    agent: textOrNull(entry.agent),
    status: textOrNull(entry.status),
    lane: textOrNull(entry.lane),
    exitCode: finiteOrNull(entry.exitCode),
    aborted: entry.aborted === true,
    structure: textOrNull(entry.structure),
    durationMs: finiteOrNull(entry.durationMs),
    tokens: finiteOrNull(entry.tokens),
    requests: finiteOrNull(entry.requests),
    contextTokens: finiteOrNull(entry.contextTokens),
    role: textOrNull(entry.role),
    model: textOrNull(entry.model),
    counts: countMap(entry.counts),
  };
}

/**
 * A record reduced to its known fields. Unknown keys are dropped and malformed values become null,
 * so a reader of an older or newer writer never crashes on it.
 *
 * @param {object} record
 */
export function normalizeRunRecord(record) {
  const source = record && typeof record === 'object' ? record : {};
  const reviewer = source.reviewer && typeof source.reviewer === 'object' ? source.reviewer : {};
  const timings = source.timings && typeof source.timings === 'object' ? source.timings : {};
  const state = RUN_STATES.includes(source.state) ? source.state : 'failed';
  return {
    schema: RUN_SCHEMA,
    runId: textOrNull(source.runId),
    kitVersion: textOrNull(source.kitVersion),
    repoRoot: textOrNull(source.repoRoot, 400),
    repoName: textOrNull(source.repoName),
    state,
    verdict: textOrNull(source.verdict),
    reasons: stringList(source.reasons).slice(0, 50),
    notes: stringList(source.notes).slice(0, 50),
    startedAt: textOrNull(source.startedAt, 40),
    finishedAt: textOrNull(source.finishedAt, 40),
    durationMs: finiteOrNull(source.durationMs),
    profile: textOrNull(source.profile),
    lanes: stringList(source.lanes),
    diffHash: textOrNull(source.diffHash),
    changedPaths: finiteOrNull(source.changedPaths),
    reportPath: textOrNull(source.reportPath, 400),
    runnerPid: finiteOrNull(source.runnerPid),
    journalKey: textOrNull(source.journalKey, 128),
    treeOid: textOrNull(source.treeOid, 128),
    journalHit: source.journalHit === true,
    ignoredStagedPaths: stringList(source.ignoredStagedPaths).slice(0, 50),
    reviewer: {
      role: textOrNull(reviewer.role),
      model: textOrNull(reviewer.model),
      fallbackApplied: reviewer.fallbackApplied === true,
      durationMs: finiteOrNull(reviewer.durationMs),
      tokens: finiteOrNull(reviewer.tokens),
      requests: finiteOrNull(reviewer.requests),
      contextTokens: finiteOrNull(reviewer.contextTokens),
      sessionFile: textOrNull(reviewer.sessionFile, 400),
    },
    timings: {
      snapshotMs: finiteOrNull(timings.snapshotMs),
      nativeTaskMs: finiteOrNull(timings.nativeTaskMs),
      verdictMs: finiteOrNull(timings.verdictMs),
      reportMs: finiteOrNull(timings.reportMs),
    },
    stages: Array.isArray(source.stages) ? source.stages.map(normalizeStage) : [],
  };
}

/**
 * @param {object} record
 * @returns {boolean}
 */
export function isTerminalRun(record) {
  return TERMINAL_RUN_STATES.includes(record?.state);
}

/**
 * The stage timings as one line: `scout 1m02s · hunter 2m10s · verifier 58s`. Unknown timings are
 * omitted rather than printed as a guess.
 *
 * @param {Array<{ agent: string|null, durationMs: number|null }>} stages
 * @returns {string}
 */
export function stageSummaryLine(stages) {
  const parts = (Array.isArray(stages) ? stages : [])
    .filter(stage => stage && stage.durationMs !== null && stage.durationMs !== undefined)
    .map(stage => `${shortAgent(stage.agent)} ${formatDuration(stage.durationMs)}`);
  return parts.join(' · ');
}

/** `review-context-scout` → `scout`, `review-risk-hunter` → `hunter`, `review-finding-verifier` → `verifier`. */
export function shortAgent(agent) {
  const name = typeof agent === 'string' ? agent.trim() : '';
  if (name.length === 0) return 'stage';
  const parts = name.split('-');
  return parts[parts.length - 1];
}
