// omp-reviewer-kit runner v0.26.3
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
// Resolution of the manifest is not a reliable way to find this package: it exports neither
// `./package.json` nor, for `require`, its own entry points (they are `import`-only). The launcher only
// needs the directory, so it walks up the way Node would and checks the one path that must exist in a
// workspace or plugin install.
const LIBRARY_NAME = '@oh-my-pi/pi-coding-agent';
const LIBRARY_ENTRY = '@oh-my-pi/pi-coding-agent/sdk';
const LIBRARY_SUFFIX = path.join('node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json');
const bun = process.env.OMP_REVIEW_KIT_BUN || 'bun';

/**
 * The installed `package.json` of the pinned OMP library: the kit's own folder first, then every parent
 * directory, which is where a hoisted workspace or plugin install puts it. A module-resolution attempt
 * covers a layout the walk cannot see (a linked package); it is never the only attempt, because the
 * package declares no `require` condition.
 *
 * @param {string} root
 * @param {{ resolveEntry?: (specifier: string) => string, exists?: (file: string) => boolean }} [options]
 * @returns {string|null}
 */
export function findLibrary(root = kitRoot, { resolveEntry = specifier => import.meta.resolve(specifier), exists = existsSync } = {}) {
  let dir = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, LIBRARY_SUFFIX);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const entry = resolveEntry(LIBRARY_ENTRY);
    const manifest = packageRootOf(entry.startsWith('file:') ? fileURLToPath(entry) : entry);
    if (manifest && exists(manifest)) return manifest;
  } catch {
    // A layout neither the walk nor the resolver can see is reported as missing, with the fix to run.
  }
  return null;
}

/**
 * The `package.json` of the package an entry point belongs to.
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
