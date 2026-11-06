import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { terminateProcessTree } from '../src/infra/process-tree.mjs';

const ROOT = realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const OUTPUT_LIMIT = 256 * 1024;
const operation = z.enum(['review', 'doctor', 'setup', 'install_omp_plan', 'install_omp_apply']);
const operations = {
  review: ['scripts/run-review.mjs'],
  doctor: ['claude-plugin/scripts/bridge.mjs', 'doctor'],
  setup: ['claude-plugin/scripts/bridge.mjs', 'setup'],
  install_omp_plan: ['claude-plugin/scripts/bridge.mjs', 'install-omp'],
  install_omp_apply: ['claude-plugin/scripts/bridge.mjs', 'install-omp', '--yes'],
};

function captureTail(stream) {
  let chunks = [];
  let bytes = 0;
  let truncated = false;
  stream.on('data', chunk => {
    const data = Buffer.from(chunk);
    chunks.push(data);
    bytes += data.length;
    while (bytes > OUTPUT_LIMIT && chunks.length > 1) {
      bytes -= chunks.shift().length;
      truncated = true;
    }
    if (bytes > OUTPUT_LIMIT) {
      chunks[0] = chunks[0].subarray(bytes - OUTPUT_LIMIT);
      bytes = OUTPUT_LIMIT;
      truncated = true;
    }
  });
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated });
}

function runCommand(selected, directory, signal, spawnImpl) {
  if (signal?.aborted) return Promise.reject(new Error('Command aborted.'));
  const [script, ...args] = operations[selected];
  // The bridge has its own entry-point check; a canonical path also works through marketplace links.
  const executable = realpathSync.native(path.join(ROOT, script));
  return new Promise((resolve, reject) => {
    const child = spawnImpl('node', [executable, ...args], {
      cwd: directory,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = captureTail(child.stdout);
    const stderr = captureTail(child.stderr);
    let aborted = false;
    const abort = () => {
      aborted = true;
      void terminateProcessTree(child);
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      signal?.removeEventListener('abort', abort);
      reject(new Error(`Could not start ${selected}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      if (aborted || signal?.aborted) {
        reject(new Error('Command aborted.'));
        return;
      }
      const out = stdout();
      const err = stderr();
      resolve({ operation: selected, exitCode: code, signal: exitSignal, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated });
    });
    if (signal?.aborted) abort();
  });
}

/**
 * The `review_kit` tool. The process seam exists so a test can prove which command each operation
 * runs, that over-limit output is a failure, and that an abort ends a started child; OpenCode always
 * uses the real `spawn`.
 *
 * @param {{ spawnImpl?: typeof spawn }} [overrides]
 */
export function createReviewKitTool({ spawnImpl = spawn } = {}) {
  return {
    description: 'Run a reviewer-kit command for the current project. review inspects the staged changes without changing the project. doctor reports installation health; setup installs or repairs the review hook. install_omp_plan shows installation steps; install_omp_apply installs OMP only when explicitly requested. A nonzero exit, a signal, or truncated output is not a successful review.',
    args: { operation },
    async execute(input, context = {}) {
      const parsed = z.object({ operation }).strict().safeParse(input);
      if (!parsed.success) throw new Error('Invalid review_kit operation.');
      if (typeof context.directory !== 'string' || !path.isAbsolute(context.directory)) {
        throw new Error('OpenCode did not provide an absolute project directory.');
      }
      const result = await runCommand(parsed.data.operation, context.directory, context.abort, spawnImpl);
      if (result.exitCode !== 0 || result.signal || result.truncated) {
        throw new Error(`reviewer-kit command did not complete successfully: ${JSON.stringify(result)}`);
      }
      return JSON.stringify(result);
    },
  };
}
