import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runnerVersionString } from '../domain/runner-version.mjs';
import { isSupersededRun } from '../domain/superseded-runs.mjs';
import { TERMINAL_RUN_STATES, pidLiveness } from '../infra/filesystem-telemetry-adapter.mjs';
import { listProcesses, terminateTree } from '../infra/process-table.mjs';
import { classifyRun, readRunRecord, readRunRecords } from '../infra/review-run-records.mjs';

/** The runner writes its record after it started, so a start this much later cannot be the same process. */
const START_TOLERANCE_MS = 2000;
const EXIT_WAIT_MS = 5000;
const EXIT_POLL_MS = 50;

/**
 * True when `processEntry` is the runner that wrote `record`, not a stranger that
 * reuses the recorded pid. All of these must hold: the pid is the recorded one
 * and is not this process, the command line runs run-review.mjs, and the process
 * started no later than the record (plus a small tolerance).
 *
 * @param {{ runnerPid?: unknown, startedAt?: unknown }} record
 * @param {{ pid?: unknown, startedAt?: unknown, commandLine?: unknown }|null|undefined} processEntry
 * @param {{ selfPid?: number }} [options]
 * @returns {boolean}
 */
export function matchesRunner(record, processEntry, { selfPid = process.pid } = {}) {
  if (!record || !processEntry) return false;
  if (!Number.isInteger(record.runnerPid) || record.runnerPid === selfPid) return false;
  if (processEntry.pid !== record.runnerPid) return false;
  if (typeof processEntry.commandLine !== 'string' || !/run-review\.mjs/i.test(processEntry.commandLine)) return false;
  const processStart = processEntry.startedAt;
  if (typeof processStart !== 'number' || !Number.isFinite(processStart)) return false;
  const recordStart = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN;
  if (!Number.isFinite(recordStart)) return false;
  return processStart <= recordStart + START_TOLERANCE_MS;
}

/**
 * The 'x.y.z' of the marker on the first line of a runner file.
 *
 * @param {string} runnerPath
 * @returns {Promise<string|null>} null when the file cannot be read or has no marker
 */
export async function readRunnerFileVersion(runnerPath) {
  try {
    return runnerVersionString((await readFile(runnerPath, 'utf8')).slice(0, 200));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilGone(pid, liveness, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (liveness(pid) === 'dead') return true;
    if (Date.now() >= deadline) return false;
    await sleep(EXIT_POLL_MS);
  }
}

/**
 * Stops live review runs whose runner is older than `currentVersion` and marks
 * their records `interrupted`. Runs of the same or a newer runner, finished runs,
 * and runs whose runner is already gone are never touched. A run is stopped only
 * when the process table proves that the recorded pid is still that runner;
 * anything else is reported as `unverified`.
 *
 * @param {{
 *   runsDir: string,
 *   currentVersion: string|null,
 *   dryRun?: boolean,
 *   now?: number,
 *   processTable?: () => (Array<object>|null|Promise<Array<object>|null>),
 *   terminate?: (pid: number, options: { table: Array<object>|null }) => Promise<unknown>,
 *   readRecords?: (runsDir: string) => Promise<object[]>,
 *   liveness?: (pid: unknown) => string,
 *   exitWaitMs?: number,
 * }} options
 * @returns {Promise<{
 *   currentVersion: string|null,
 *   dryRun: boolean,
 *   stopped: Array<{ runId: string, repoRoot: unknown, tag: unknown, runnerVersion: unknown, runnerPid: number }>,
 *   unverified: Array<{ runId: string, runnerPid: number, reason: string }>,
 *   kept: number,
 * }>}
 */
export async function stopSupersededRuns({
  runsDir,
  currentVersion,
  dryRun = false,
  now = Date.now(),
  processTable = listProcesses,
  terminate = terminateTree,
  readRecords = readRunRecords,
  liveness = pidLiveness,
  exitWaitMs = EXIT_WAIT_MS,
} = {}) {
  const result = { currentVersion, dryRun, stopped: [], unverified: [], kept: 0 };
  const records = await readRecords(runsDir);
  const candidates = records.filter((record) => isSupersededRun(record, currentVersion)
    && classifyRun(record, { now, liveness }) !== 'orphaned');
  result.kept = records.length - candidates.length;
  // Fast path of every session start: no candidate, no process table.
  if (candidates.length === 0) return result;

  const table = await processTable();
  const rows = Array.isArray(table) ? table : null;
  for (const record of candidates) {
    const base = { runId: record.runId, runnerPid: record.runnerPid };
    if (!rows) {
      result.unverified.push({ ...base, reason: 'the process table could not be read' });
      continue;
    }
    const entry = rows.find((row) => matchesRunner(record, row));
    if (!entry) {
      result.unverified.push({ ...base, reason: 'the recorded pid is not this run\'s runner' });
      continue;
    }
    const summary = {
      runId: record.runId,
      repoRoot: record.repoRoot ?? null,
      tag: record.tag ?? null,
      runnerVersion: record.runnerVersion ?? null,
      runnerPid: record.runnerPid,
    };
    if (dryRun) {
      result.stopped.push(summary);
      continue;
    }
    // The run may have finished while the process table was being read.
    const beforeKill = await readRunRecord(runsDir, record.runId);
    if (!beforeKill || TERMINAL_RUN_STATES.has(beforeKill.state)) {
      result.kept += 1;
      continue;
    }
    const outcome = await terminate(record.runnerPid, { table: rows });
    if (outcome?.refused) {
      result.unverified.push({ ...base, reason: 'refused to stop this process or one of its ancestors' });
      continue;
    }
    if (!(await waitUntilGone(record.runnerPid, liveness, exitWaitMs))) {
      result.unverified.push({ ...base, reason: 'the runner was still alive after the stop' });
      continue;
    }
    const afterKill = await readRunRecord(runsDir, record.runId);
    if (afterKill && !TERMINAL_RUN_STATES.has(afterKill.state)) {
      const detail = `stopped by reviewer-kit ${currentVersion}: this run used runner ${record.runnerVersion ?? 'from before 0.20.1'}`;
      await writeFile(path.join(runsDir, `${record.runId}.json`), `${JSON.stringify({
        ...afterKill,
        state: 'interrupted',
        finishedAt: new Date(now).toISOString(),
        error: detail,
        message: detail,
        supersededBy: currentVersion,
      }, null, 2)}\n`, 'utf8');
    }
    result.stopped.push(summary);
  }
  return result;
}
