import { spawn } from 'node:child_process';
import path from 'node:path';

// Kills a spawned process and its children. Used by the mutation runner to stop a timed-out mutant's test run.
// The launcher and platform are injectable so the Windows escalation can be proved without relying on
// taskkill actually failing.
export async function terminateProcessTree(proc, { spawnImpl = spawn, platform = process.platform } = {}) {
  if (!proc.pid) return;

  // Whether an exit has already been reported, without waiting for a close that may have fired earlier.
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    if (exited()) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (didExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('close', onClose);
      resolve(didExit);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('close', onClose);
    if (exited()) finish(true);
  });

  if (platform === 'win32') {
    // taskkill can miss a child that has not finished starting, and it reports that as a normal exit,
    // so the caller is left waiting for a process that is still running. Killing the child directly
    // after it is the sure termination: it is a process this module started, not a shared one.
    await new Promise((resolve) => {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawnImpl(taskkill, ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(resolve, 250);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', finish);
    });
    if (await waitForExit(300)) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // The process may have exited between the two termination attempts.
    }
    await waitForExit(300);
    return;
  }

  const signalTree = (signal) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };

  signalTree('SIGTERM');
  if (await waitForExit(250)) return;
  signalTree('SIGKILL');
  await waitForExit(250);
}
