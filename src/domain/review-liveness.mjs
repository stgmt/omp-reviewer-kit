import { TERMINAL_RUN_STATES, formatDuration } from './review-run-summary.mjs';

// Whether a review is working, quiet, stalled, orphaned or already finished. Pure: the caller
// supplies the clock, the age of the last progress write and the two facts only the machine can
// answer (is the runner process alive, is a commit waiting). The vocabulary exists because "it hangs"
// was wrong every time it was said from a bare terminal: a stage that emits an event every few
// seconds for twenty minutes and a stage that died look identical when the only evidence is silence.

/** A stage that emitted a progress event within this window is working, not hung. */
export const QUIET_MS = 60_000;

/**
 * A stage silent for longer than this is treated as stalled rather than slow. Measured: the longest
 * silent stretch inside a stage that went on to finish was about three minutes (a large model call),
 * and the stage deadline stops anything longer.
 */
export const STALL_MS = 300_000;

export const LIVENESS = {
  finished: 'finished',
  working: 'working',
  quiet: 'quiet',
  stalled: 'stalled',
  exited: 'exited',
  unknown: 'unknown',
};

/**
 * One review's liveness.
 *
 * @param {{
 *   state: string|null,
 *   verdict?: string|null,
 *   stage?: { agent?: string|null, status?: string|null, durationMs?: number|null, tokens?: number|null, requests?: number|null } | null,
 *   startedAt?: string|null,
 *   durationMs?: number|null,
 *   progressAgeMs?: number|null,
 *   runnerAlive?: boolean|'unknown',
 *   commitWaiting?: boolean|null,
 *   reportPath?: string|null,
 * }} input
 * @param {{ now?: number, deadlineMs?: number }} [options]
 * @returns {{ kind: string, stage: string|null, stageStatus: string|null, progressAgeMs: number|null, elapsedMs: number|null, deadlineInMs: number|null, text: string }}
 */
export function classifyLiveness(input, { now = Date.now(), deadlineMs = null } = {}) {
  const state = typeof input?.state === 'string' ? input.state : null;
  const stage = input?.stage ?? null;
  const stageName = stage?.agent ?? null;
  const stageStatus = stage?.status ?? null;
  const progressAgeMs = finiteOrNull(input?.progressAgeMs);
  const started = Date.parse(input?.startedAt ?? '');
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : null;
  const running = state !== null && !TERMINAL_RUN_STATES.includes(state);
  // A finished review reports the duration it measured, never the time since it started: the record
  // is read hours later and its age is not its duration.
  const measuredMs = finiteOrNull(input?.durationMs);
  const reportingMs = measuredMs ?? elapsedMs;
  const facts = { stage: stageName, stageStatus, progressAgeMs, elapsedMs: reportingMs, deadlineMs };
  const where = running ? describeStage(stageName, stageStatus, stage) : '';
  // Whether a commit waits is context, never the classification: identical review state must not
  // change its kind because an unrelated repository elsewhere starts a `git commit`.
  // The waiter answer is three-valued and every value is reported: a waiting commit, a missing one,
  // and a machine that could not be asked are different facts and must not print the same line.
  const unwaited = input?.commitWaiting === true
    ? '; a git commit is waiting for this verdict'
    : input?.commitWaiting === false
      ? '; no git commit is waiting (a manual run, or a commit that is gone)'
      : '';

  if (!running) {
    return result(LIVENESS.finished, `review ${state ?? 'unknown'}${input?.verdict ? ` (${input.verdict})` : ''} in ${formatDuration(reportingMs)}${input?.reportPath ? '; report written' : ''}`, facts);
  }
  if (input?.runnerAlive === 'unknown') {
    // The pid answers, but the record's age cannot be trusted, so silence cannot be judged. Saying
    // "the process is gone" here would be a confident false statement about a live review.
    return result(LIVENESS.unknown, `runner process is alive but progress age is unknown${where}; liveness cannot be judged from the record`, facts);
  }
  if (input?.runnerAlive !== true) {
    return result(LIVENESS.exited, `runner process is gone; this record will never get a verdict${where}`, facts);
  }
  if (progressAgeMs !== null && progressAgeMs >= STALL_MS) {
    // The host arms its deadline per stage, and the record does not carry a stage start time, so the
    // line states the silence and the rule instead of inventing a countdown from the review clock.
    return result(LIVENESS.stalled, `silent for ${formatDuration(progressAgeMs)}${where}; a stage that never answers is stopped by its own deadline${unwaited}`, facts);
  }
  if (progressAgeMs !== null && progressAgeMs >= QUIET_MS) {
    return result(LIVENESS.quiet, `no progress for ${formatDuration(progressAgeMs)}${where}; a long model call, not a hang yet${unwaited}`, facts);
  }
  return result(LIVENESS.working, `working${where}; last progress ${progressAgeMs === null ? 'unknown' : `${formatDuration(progressAgeMs)} ago`}${unwaited}`, facts);
}

/** One line for a terminal or a report: the verdict on liveness first, the evidence after it. */
export function formatLivenessLine(runId, liveness) {
  return `${runId} | ${liveness.kind} | ${liveness.text}`;
}

function result(kind, text, facts = {}) {
  return {
    kind,
    stage: facts.stage ?? null,
    stageStatus: facts.stageStatus ?? null,
    progressAgeMs: facts.progressAgeMs ?? null,
    elapsedMs: facts.elapsedMs ?? null,
    deadlineMs: facts.deadlineMs ?? null,
    text,
  };
}

function describeStage(name, status, stage) {
  if (!name) return '';
  const parts = [];
  if (typeof stage?.durationMs === 'number') parts.push(formatDuration(stage.durationMs));
  if (typeof stage?.tokens === 'number') parts.push(`${stage.tokens} tok`);
  if (typeof stage?.requests === 'number') parts.push(`${stage.requests} req`);
  const facts = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return ` at ${name}${status ? ` ${status}` : ''}${facts}`;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
