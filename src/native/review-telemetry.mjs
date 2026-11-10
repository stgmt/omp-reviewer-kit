// Bridge between the native review and the run record. The native review already receives every
// timing and usage number from OMP's own task result; this module only carries them into the
// record and onto the hook log. Every write is fail-open: a record that cannot be written never
// changes a verdict, an exit code or a stage outcome.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  RUN_SCHEMA,
  formatDuration,
  isTerminalRun,
  normalizeRunRecord,
  runStateFor,
  stageCounts,
} from '../domain/review-run-summary.mjs';
import { pruneRuns, runRecordFile, runsRootDir, writeRunRecord } from '../infra/review-run-store.mjs';
import { formatDiffSize } from '../domain/diff-budget.mjs';

/** Minimum gap between two live rewrites of the same record, so a chatty reviewer cannot spin the disk. */
const LIVE_WRITE_INTERVAL_MS = 1000;

/**
 * A run identifier that sorts by start time and stays unique: `2026-11-01T09-12-33-120Z-a1b2c3`.
 *
 * @param {number} now
 * @param {{ random?: () => string }} [options]
 * @returns {string}
 */
export function createRunId(now = Date.now(), { random = () => randomBytes(3).toString('hex') } = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${random()}`;
}

/** Tokens as the log shows them: `820`, `18k`, `410k`. */
export function formatTokens(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return 'unknown';
  if (tokens < 1000) return String(Math.round(tokens));
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * One live stage event as a hook-log line. Unknown numbers are omitted, never printed as a guess.
 *
 * @param {{ agent?: string|null, lane?: string|null, status?: string|null, durationMs?: number|null, tokens?: number|null, requests?: number|null }} event
 * @returns {string}
 */
export function formatStageEvent(event) {
  const agent = event?.agent ?? 'stage';
  const lane = event?.lane ? ` lane=${event.lane}` : '';
  const facts = [];
  if (typeof event?.durationMs === 'number' && Number.isFinite(event.durationMs)) facts.push(formatDuration(event.durationMs));
  if (typeof event?.tokens === 'number' && Number.isFinite(event.tokens)) facts.push(`${formatTokens(event.tokens)} tok`);
  if (typeof event?.requests === 'number' && Number.isFinite(event.requests)) facts.push(`${event.requests} req`);
  const suffix = facts.length > 0 ? ` (${facts.join(', ')})` : '';
  return `review: stage ${agent}${lane} ${event?.status ?? 'running'}${suffix}`;
}

/**
 * The final stage list of a record: one entry per native stage, carrying timing and usage and only
 * the counts of what the stage reported — never its structured payload.
 *
 * @param {Array<object>} stages
 * @returns {Array<object>}
 */
export function recordStages(stages) {
  return (Array.isArray(stages) ? stages : []).map(stage => ({
    agent: stage?.agent ?? null,
    lane: stage?.lane ?? null,
    status: stage?.status ?? (stage?.aborted ? 'aborted' : stage?.exitCode === 0 ? 'completed' : 'failed'),
    exitCode: stage?.exitCode ?? null,
    aborted: stage?.aborted === true,
    structure: stage?.structuredStatus ?? null,
    durationMs: stage?.durationMs ?? null,
    tokens: stage?.tokens ?? null,
    requests: stage?.requests ?? null,
    contextTokens: stage?.contextTokens ?? null,
    role: stage?.role ?? null,
    model: stage?.model ?? null,
    counts: stage?.counts ?? stageCounts(stage?.data),
  }));
}

/**
 * The finished record of one review, assembled from the native result. Pure: the caller decides
 * where it goes.
 *
 * @param {{
 *   runId: string,
 *   record: object,
 *   result: object,
 *   reportPath?: string|null,
 *   reportMs?: number|null,
 *   finishedAt: string,
 *   durationMs: number,
 * }} input
 */
/** The one line a refused run carries: the token, the observed numbers and the limits it broke. */
function refusalReason(refused) {
  if (refused.reason === 'invalid-budget') return refused.error ?? 'diff budget invalid';
  return `${refused.reason}: ${refused.paths} paths, ${formatDiffSize(refused.bytes)} (max ${refused.maxPaths} paths, ${formatDiffSize(refused.maxBytes)})`;
}

export function buildRunRecord({ runId, record, result, reportPath = null, reportMs = null, finishedAt, durationMs }) {
  const state = runStateFor(result?.verdict, result);
  return normalizeRunRecord({
    ...record,
    schema: RUN_SCHEMA,
    runId,
    state,
    verdict: result?.verdict?.verdict ?? (result?.refused ? 'REFUSED' : null),
    reasons: result?.refused ? [refusalReason(result.refused)] : result?.verdict?.reasons ?? [],
    finishedAt,
    durationMs,
    profile: result?.profile ?? null,
    lanes: result?.lanes ?? [],
    diffHash: result?.diffHash ?? null,
    changedPaths: Array.isArray(result?.changedPaths) ? result.changedPaths.length : null,
    reportPath,
    journalKey: result?.journal?.key ?? null,
    treeOid: result?.journal?.treeOid ?? null,
    journalHit: result?.journal?.hit === true,
    ignoredStagedPaths: Array.isArray(result?.ignoredStagedPaths) ? result.ignoredStagedPaths : [],
    reviewer: {
      role: result?.provenance?.role ?? null,
      model: result?.provenance?.model ?? null,
      fallbackApplied: result?.fallback?.applied === true,
      durationMs: result?.runSummary?.reviewer?.durationMs ?? null,
      tokens: result?.runSummary?.reviewer?.tokens ?? null,
      requests: result?.runSummary?.reviewer?.requests ?? null,
      contextTokens: result?.runSummary?.reviewer?.contextTokens ?? null,
      sessionFile: result?.runSummary?.reviewer?.sessionFile ?? null,
    },
    timings: {
      snapshotMs: result?.runSummary?.timings?.snapshotMs ?? null,
      nativeTaskMs: result?.runSummary?.timings?.nativeTaskMs ?? null,
      verdictMs: result?.runSummary?.timings?.verdictMs ?? null,
      reportMs: reportMs ?? null,
    },
    stages: recordStages(result?.stages ?? []),
  });
}

/**
 * Owns the lifecycle of one run record: `running` before the reviewer starts, a throttled rewrite
 * while stages report progress, and the final record once the verdict exists. Every method is
 * fail-open: an unwritable record is reported once by the caller and never throws.
 *
 * @param {{
 *   repo: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   kitVersion?: string|null,
 *   pid?: number,
 *   now?: () => number,
 *   write?: typeof writeRunRecord,
 *   prune?: typeof pruneRuns,
 * }} options
 */
export function createRunRecorder({
  repo,
  env = process.env,
  home,
  kitVersion = null,
  pid = process.pid,
  now = () => Date.now(),
  write = writeRunRecord,
  prune = pruneRuns,
} = {}) {
  const startedMs = now();
  const runId = createRunId(startedMs);
  const dir = runsRootDir({ env, home });
  let file = null;
  let lastWriteAt = 0;
  let failure = null;
  const record = normalizeRunRecord({
    schema: RUN_SCHEMA,
    runId,
    kitVersion,
    repoRoot: path.resolve(repo),
    repoName: path.basename(path.resolve(repo)),
    state: 'running',
    startedAt: new Date(startedMs).toISOString(),
    runnerPid: pid,
  });

  const attempt = async (work, label) => {
    if (failure) return null;
    try {
      return await work();
    } catch (error) {
      failure = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  };

  const writeOnce = async () => {
    const written = await attempt(() => write(record, { dir }), 'write');
    if (written) file = written;
    lastWriteAt = now();
    return written;
  };
  // Writes are serialized. The host fires progress events without awaiting them, so two writes of
  // one record would otherwise overlap and a settled record could lose to a stale one, or two
  // renames could collide on one temporary path.
  let writeChain = null;
  const persist = () => {
    const next = writeChain ? writeChain.then(writeOnce) : writeOnce();
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    runId,
    dir,
    get path() {
      return file ?? runRecordFile(dir, runId);
    },
    get record() {
      return record;
    },
    /** The first write: the record exists before the reviewer does, so a killed run is still visible. */
    async start() {
      await persist();
      return file;
    },
    /**
     * Merges one live stage event into the record. Only start and finish events matter, and the
     * rewrite is throttled; a stage that reports the same status twice updates its numbers only.
     *
     * @param {object} event
     */
    async event(event) {
      if (!event || typeof event !== 'object' || failure) return;
      const agent = event.agent ?? null;
      const lane = event.lane ?? null;
      if (!agent) return;
      const existing = record.stages.find(stage => stage.agent === agent && stage.lane === lane);
      const patch = {
        agent,
        lane,
        status: event.status ?? 'running',
        durationMs: event.durationMs ?? null,
        tokens: event.tokens ?? null,
        requests: event.requests ?? null,
        contextTokens: event.contextTokens ?? null,
        role: event.role ?? null,
        model: event.model ?? null,
      };
      if (existing) Object.assign(existing, patch);
      else record.stages.push(normalizeRunRecord({ stages: [patch] }).stages[0]);
      const finished = event.status && event.status !== 'running';
      if (!finished && now() - lastWriteAt < LIVE_WRITE_INTERVAL_MS) return;
      await persist();
    },
    /**
     * The final record: the verdict, the timings, the report path and the settled stage list.
     *
     * @param {{ result: object, reportPath?: string|null, reportMs?: number|null }} input
     */
    async complete({ result, reportPath = null, reportMs = null }) {
      const finishedMs = now();
      const final = buildRunRecord({
        runId,
        record,
        result,
        reportPath,
        reportMs,
        finishedAt: new Date(finishedMs).toISOString(),
        durationMs: finishedMs - startedMs,
      });
      Object.assign(record, final);
      await persist();
      await attempt(() => prune({ dir }), 'prune');
      return file;
    },
    /** A run that threw before a verdict: recorded as failed, so the log never hides a crash. */
    async fail(error) {
      record.state = 'failed';
      record.verdict = 'FAILED';
      record.reasons = [error instanceof Error ? error.message : String(error)].slice(0, 1);
      record.finishedAt = new Date(now()).toISOString();
      record.durationMs = now() - startedMs;
      await persist();
      return file;
    },
    /** Why the record could not be written, once. Null while everything works. */
    get writeFailure() {
      return failure;
    },
  };
}

export { isTerminalRun };
