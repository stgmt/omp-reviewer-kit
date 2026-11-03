// omp-reviewer-kit runner v0.26.0
// omp-reviewer-kit runner: the Node launcher of the native review. The review runs under Bun in
// src/native/native-host.mjs because OMP's library is a Bun package. This launcher only checks that
// Bun and the pinned OMP library are installed, then hands the staged repository to the host.
// Usage (the hook passes nothing): node scripts/run-review.mjs [repository]

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(kitRoot, 'src', 'native', 'native-host.mjs');
const LIBRARY = '@oh-my-pi/pi-coding-agent/package.json';
const bun = process.env.OMP_REVIEW_KIT_BUN || 'bun';

/**
 * Where the pinned OMP library actually lives. A workspace install hoists it to a parent
 * `node_modules` — OMP does exactly that for its own plugins — so the kit's own folder is only the
 * first candidate, not the only one. Resolution keeps the kit working from whichever copy the host
 * installed, instead of demanding a manual `bun install` after every plugin update.
 *
 * @param {string} root
 * @param {(specifier: string) => string} [resolve]
 * @returns {string|null}
 */
export function findLibrary(root = kitRoot, resolve = specifier => createRequire(path.join(root, 'package.json')).resolve(specifier)) {
  const candidates = [path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json')];
  try {
    candidates.push(resolve(LIBRARY));
  } catch {
    // Not resolvable from the kit folder: a hoisted install still shows up through `require.resolve`
    // of the host process, which the candidate list below covers.
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

function block(message) {
  process.stderr.write(`review: BLOCK (${message})\n`);
  process.exitCode = 1;
}

function main(argv) {
  const probe = spawnSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    return block(`bun is required for the native review (set OMP_REVIEW_KIT_BUN or install https://bun.sh): ${probe.error?.message ?? `exit ${probe.status}`}`);
  }
  if (!findLibrary()) {
    return block(`the OMP library (@oh-my-pi/pi-coding-agent) is not installed next to ${kitRoot} or above it; run: bun install --cwd "${kitRoot}" (or reinstall the plugin: omp plugin install github:stgmt/omp-reviewer-kit)`);
  }
  const repo = path.resolve(argv[0] ?? process.cwd());
  const child = spawnSync(bun, [host, repo], { stdio: 'inherit', env: process.env, windowsHide: true, cwd: repo });
  if (child.error) return block(`cannot start the native review host: ${child.error.message}`);
  // A host that ended by signal has no status: that is a failed review, never a pass.
  process.exitCode = child.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
