// omp-reviewer-kit runner v0.32.0
// omp-reviewer-kit runner: the Node launcher of the native review. The review runs under Bun in
// src/native/native-host.mjs because OMP's library is a Bun package. The launcher checks Bun and
// prepares the pinned library outside the repository when a host install does not include it.
// Usage (the hook passes nothing): node scripts/run-review.mjs [repository]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/infra/main-module.mjs';
import { ensureReviewRuntime } from '../src/infra/ensure-review-runtime.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(kitRoot, 'src', 'native', 'native-host.mjs');
// Resolution of the manifest is not a reliable way to find this package: it exports neither
// `./package.json` nor, for `require`, its own entry points (they are `import`-only). The launcher only
// needs the directory, so it walks up the way Node would and checks the one path that must exist in a
// workspace or plugin install.
const LIBRARY_NAME = '@oh-my-pi/pi-coding-agent';
const LIBRARY_ENTRY = '@oh-my-pi/pi-coding-agent/sdk';
const LIBRARY_SUFFIX = path.join('node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json');

/**
 * Finds an installed OMP library matching the plugin's exact dependency pin. The kit's own
 * folder is checked first, then hoisted parents and finally module resolution.
 *
 * @param {string} root
 * @param {{ resolveEntry?: (specifier: string) => string, exists?: (file: string) => boolean }} [options]
 * @returns {string|null}
 */
export function findLibrary(root = kitRoot, { resolveEntry = specifier => import.meta.resolve(specifier), exists = existsSync } = {}) {
  let expected;
  try {
    expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies?.[LIBRARY_NAME];
  } catch {
    return null;
  }
  if (typeof expected !== 'string' || expected === '') return null;
  const matches = manifest => {
    if (!exists(manifest)) return false;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      return pkg.name === LIBRARY_NAME && pkg.version === expected;
    } catch {
      return false;
    }
  };
  let dir = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, LIBRARY_SUFFIX);
    if (matches(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const entry = resolveEntry(LIBRARY_ENTRY);
    const manifest = packageRootOf(entry.startsWith('file:') ? fileURLToPath(entry) : entry);
    if (manifest && matches(manifest)) return manifest;
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
  let bun = process.env.OMP_REVIEW_KIT_BUN || 'bun';
  let probe = spawnSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (!process.env.OMP_REVIEW_KIT_BUN && process.platform === 'win32' &&
      probe.error?.code === 'ENOENT' && process.env.USERPROFILE) {
    bun = path.join(process.env.USERPROFILE, '.bun', 'bin', 'bun.exe');
    probe = spawnSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true });
  }
  if (probe.error || probe.status !== 0) {
    return block(`bun is required for the native review (set OMP_REVIEW_KIT_BUN or install https://bun.sh): ${probe.error?.message ?? `exit ${probe.status}`}`);
  }
  const repo = path.resolve(argv[0] ?? process.cwd());
  const env = { ...process.env };
  delete env.OMP_REVIEW_KIT_RUNTIME_ROOT;
  if (!findLibrary()) {
    try {
      const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8', windowsHide: true });
      if (root.error || root.status !== 0 || !String(root.stdout ?? '').trim()) {
        throw new Error('cannot determine the reviewed repository root');
      }
      process.stderr.write('review: preparing the pinned OMP runtime outside the repository\n');
      const runtime = ensureReviewRuntime({ kitRoot, repoRoot: String(root.stdout).trim(), bun, bunVersion: String(probe.stdout).trim() });
      env.OMP_REVIEW_KIT_RUNTIME_ROOT = runtime;
      env.NODE_PATH = [path.join(runtime, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    } catch (error) {
      return block(`the OMP library (@oh-my-pi/pi-coding-agent) is not installed and its runtime could not be prepared: ${error.message}`);
    }
  }
  const child = spawnSync(bun, [host, repo], { stdio: 'inherit', env, windowsHide: true, cwd: repo });
  if (child.error) return block(`cannot start the native review host: ${child.error.message}`);
  // A host that ended by signal has no status: that is a failed review, never a pass.
  process.exitCode = child.status ?? 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
