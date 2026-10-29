// omp-reviewer-kit runner v0.23.1
// omp-reviewer-kit runner: the Node launcher of the native review. The review runs under Bun in
// src/native/native-host.mjs because OMP's library is a Bun package. This launcher only checks that
// Bun and the pinned OMP library are installed, then hands the staged repository to the host.
// Usage (the hook passes nothing): node scripts/run-review.mjs [repository]

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(kitRoot, 'src', 'native', 'native-host.mjs');
const library = path.join(kitRoot, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json');
const bun = process.env.OMP_REVIEW_KIT_BUN || 'bun';

function block(message) {
  process.stderr.write(`review: BLOCK (${message})\n`);
  process.exitCode = 1;
}

function main(argv) {
  const probe = spawnSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    return block(`bun is required for the native review (set OMP_REVIEW_KIT_BUN or install https://bun.sh): ${probe.error?.message ?? `exit ${probe.status}`}`);
  }
  if (!existsSync(library)) {
    return block(`the OMP library is not installed in ${kitRoot}; run: bun install --cwd "${kitRoot}" (or reinstall the plugin: omp plugin install github:stgmt/omp-reviewer-kit)`);
  }
  const repo = path.resolve(argv[0] ?? process.cwd());
  const child = spawnSync(bun, [host, repo], { stdio: 'inherit', env: process.env, windowsHide: true, cwd: repo });
  if (child.error) return block(`cannot start the native review host: ${child.error.message}`);
  // A host that ended by signal has no status: that is a failed review, never a pass.
  process.exitCode = child.status ?? 1;
}

main(process.argv.slice(2));
