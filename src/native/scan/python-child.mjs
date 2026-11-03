// The one way the kit starts a Python child. Two scans read Python — the maintainability extractor
// and the reuse scanner — and both need the same request shape, the same budget rule and the same
// reasons a start can fail. Keeping one launcher means a change to any of those cannot drift between
// them: a missing interpreter is `no-interpreter` for both, never one reason here and another there.

import { spawnSync as defaultSpawnSync } from 'node:child_process';

/**
 * @param {{
 *   script: string,
 *   files: Array<{ path: string, abs: string }>,
 *   timeoutMs: number,
 *   pythonBin?: string,
 *   spawnSync?: Function,
 * }} input
 * @returns {Promise<
 *   { status: 'ok', payload: object } |
 *   { status: 'failed', reason: string, message: string }
 * >}
 */
export async function runPythonChild({ script, files, timeoutMs, pythonBin = 'python', spawnSync = null }) {
  const spawn = spawnSync ?? defaultSpawnSync;
  let result;
  try {
    result = spawn(pythonBin, ['-c', script], {
      input: JSON.stringify({ files }),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    return { status: 'failed', reason: 'failed', message: String(error?.message ?? error) };
  }
  if (result?.error?.code === 'ENOENT') return { status: 'failed', reason: 'no-interpreter', message: 'python interpreter not found' };
  if (result?.error?.code === 'ETIMEDOUT') return { status: 'failed', reason: 'analysis-budget-exhausted', message: 'python adapter exceeded the scan budget' };
  if (result?.error) return { status: 'failed', reason: 'failed', message: String(result.error.message ?? result.error) };
  if (result?.signal) return { status: 'failed', reason: 'failed', message: `python adapter stopped by ${result.signal}` };
  if (result?.status !== 0) {
    return { status: 'failed', reason: 'failed', message: String(result?.stderr ?? '').slice(0, 500) || `python adapter exit ${result?.status}` };
  }
  try {
    return { status: 'ok', payload: JSON.parse(String(result.stdout ?? '')) };
  } catch {
    return { status: 'failed', reason: 'failed', message: 'python adapter returned unreadable output' };
  }
}
