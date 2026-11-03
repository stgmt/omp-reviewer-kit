// omp-reviewer-kit runner v0.26.1
// omp-reviewer-kit runner: the Node launcher of the native review. The review runs under Bun in
// src/native/native-host.mjs because OMP's library is a Bun package. This launcher only checks that
// Bun and the pinned OMP library are installed, then hands the staged repository to the host.
// Usage (the hook passes nothing): node scripts/run-review.mjs [repository]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(kitRoot, 'src', 'native', 'native-host.mjs');
// The package does not export `./package.json`, so resolution must go through an exported entry and
// the package root is then found by walking up from it.
const LIBRARY_ENTRY = '@oh-my-pi/pi-coding-agent/sdk';
const LIBRARY_NAME = '@oh-my-pi/pi-coding-agent';
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
    candidates.push(packageRootOf(resolve(LIBRARY_ENTRY)));
  } catch {
    // Not resolvable from the kit folder either: the direct candidate above still covers a local install.
  }
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

/**
 * The `package.json` of the package an entry point belongs to: resolution lands on a file inside the
 * package, and the manifest is what the launcher verifies.
 *
 * @param {string} entry
 * @returns {string|null}
 */
export function packageRootOf(entry) {
  let dir = path.dirname(entry);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === LIBRARY_NAME) return manifest;
      } catch {
        // A manifest that cannot be parsed is not the library; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
