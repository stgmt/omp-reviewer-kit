#!/usr/bin/env node
// Stops live review runs whose runner is older than the installed plugin and marks
// their records interrupted. Runs of the same or a newer runner, finished runs and
// quiet runs on the current runner are never touched.
//   --dry-run  list what would be stopped, stop nothing
//   --json     print the result as JSON
// Exit codes: 0 done, 2 usage error or unexpected failure.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunnerFileVersion, stopSupersededRuns } from '../src/application/superseded-run-stopper.mjs';
import { resolveRunsDir } from '../src/infra/filesystem-telemetry-adapter.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: stop-superseded-runs [--dry-run] [--json]';

/**
 * Plain-text report of a stop result.
 *
 * @param {{ currentVersion: string|null, dryRun: boolean, stopped: object[], unverified: object[], kept: number }} result
 * @returns {string}
 */
export function formatStopResult(result) {
  const lines = [`installed runner: ${result.currentVersion ?? 'unknown'}${result.dryRun ? ' (dry run, nothing stopped)' : ''}`];
  if (result.currentVersion === null) lines.push('The installed runner version is unreadable, so nothing was stopped.');
  const verb = result.dryRun ? 'would stop' : 'stopped';
  for (const run of result.stopped) {
    lines.push(`${verb}  ${run.runId}  runner ${run.runnerVersion ?? 'from before 0.20.1'}  pid ${run.runnerPid}  ${run.repoRoot ?? ''}`.trimEnd());
  }
  for (const run of result.unverified) {
    lines.push(`left    ${run.runId}  pid ${run.runnerPid}  ${run.reason}`);
  }
  if (result.stopped.length === 0 && result.unverified.length === 0) lines.push('no superseded live runs');
  lines.push(`${result.kept} other record(s) untouched`);
  return lines.join('\n');
}

/**
 * @param {{ argv?: string[], out?: (text: string) => void, err?: (text: string) => void, runnerPath?: string }} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function main({
  argv = process.argv.slice(2),
  out = console.log,
  err = console.error,
  runnerPath = path.join(SCRIPT_DIR, 'run-review.mjs'),
} = {}) {
  try {
    const known = new Set(['--dry-run', '--json']);
    const unknown = argv.filter((arg) => !known.has(arg));
    if (unknown.length > 0) {
      err(`unknown argument: ${unknown[0]}\n${USAGE}`);
      return 2;
    }
    const dryRun = argv.includes('--dry-run');
    const result = await stopSupersededRuns({
      runsDir: resolveRunsDir(),
      currentVersion: await readRunnerFileVersion(runnerPath),
      dryRun,
    });
    out(argv.includes('--json') ? JSON.stringify(result, null, 2) : formatStopResult(result));
    return 0;
  } catch (error) {
    err(`stop-superseded-runs failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
