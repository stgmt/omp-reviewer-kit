import { spawn } from 'node:child_process';
import { stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionPort } from '../application/ports.mjs';

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('node:child_process');
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 5000).unref();
}

/**
 * Creates symlinks for repository dependency directories into the snapshot directory.
 * Failures return warning strings without throwing.
 *
 * @param {string} repoRoot
 * @param {string} snapshotDir
 * @param {string[]} [dirNames]
 * @returns {Promise<string[]>} warnings
 */
export async function linkDependencyDirs(repoRoot, snapshotDir, dirNames = ['node_modules', '.venv', 'venv']) {
  const warnings = [];
  for (const name of dirNames) {
    const source = path.join(repoRoot, name);
    const destination = path.join(snapshotDir, name);
    try {
      const srcStat = await stat(source).catch(() => null);
      if (!srcStat || !srcStat.isDirectory()) continue;
      const destStat = await stat(destination).catch(() => null);
      if (destStat) continue;

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(source, destination, symlinkType);
    } catch (err) {
      warnings.push(`Failed to link ${name}: ${err.message}`);
    }
  }
  return warnings;
}

/**
 * Execution adapter running external test/check commands via child_process.spawn.
 */
export class SubprocessExecutionAdapter extends ExecutionPort {
  async run({ command, cwd, timeoutMs = 600000 }) {
    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return { ok: false, error: 'No command specified' };
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let timedOut = false;
      let timer = null;

      let child;
      try {
        child = spawn(command, {
          shell: true,
          cwd,
          env: process.env,
          windowsHide: true,
        });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }

      const MAX_LINES = 200;
      let stdoutLines = [];
      let stderrLines = [];

      child.stdout?.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        stdoutLines = stdoutLines.concat(lines).slice(-MAX_LINES);
      });

      child.stderr?.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        stderrLines = stderrLines.concat(lines).slice(-MAX_LINES);
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child.pid);
        }, timeoutMs);
        if (typeof timer?.unref === 'function') {
          timer.unref();
        }
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });

      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startedAt;
        resolve({
          ok: true,
          exitCode: exitCode ?? (timedOut ? 1 : 0),
          timedOut,
          durationMs,
          stdout: stdoutLines.join('\n'),
          stderr: stderrLines.join('\n'),
        });
      });
    });
  }
}
