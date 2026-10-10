import { compareRunnerVersions } from './runner-version.mjs';

/**
 * States that never change again. Kept in step with TERMINAL_RUN_STATES in
 * infra/filesystem-telemetry-adapter.mjs; the domain layer must not import the
 * adapter, so the list is repeated here and a test compares the two.
 */
const TERMINAL_STATES = new Set(['passed', 'blocked', 'failed', 'skipped', 'interrupted']);

/**
 * Whether a run record belongs to a review that runs on a runner older than the
 * installed one. Fail closed: anything that cannot be proven older is kept.
 *
 * @param {{ state?: unknown, runnerPid?: unknown, runnerVersion?: unknown }} record
 * @param {unknown} currentVersion 'x.y.z' of the installed runner
 * @returns {boolean}
 */
export function isSupersededRun(record, currentVersion) {
  if (!record || typeof record !== 'object') return false;
  if (TERMINAL_STATES.has(record.state)) return false;
  if (!Number.isInteger(record.runnerPid)) return false;
  if (compareRunnerVersions(currentVersion, '0.0.0') === null) return false;
  // A record without the field predates runner versions, so its runner is older.
  if (record.runnerVersion === undefined || record.runnerVersion === null) return true;
  const order = compareRunnerVersions(record.runnerVersion, currentVersion);
  return order !== null && order < 0;
}
