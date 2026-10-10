import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import { isSkippedTarget } from '../src/domain/target-policy.mjs';
import { FileTargetRegistry } from '../src/infra/target-registry.mjs';

// The vendored runner is the thin stub the installer writes; the algorithm lives in the plugin.
export const CANONICAL_RUNNER = await readFile('templates/review-kit/run-review.mjs', 'utf8');
// Windows temp directories have a short 8.3 and a long spelling; git reports the long one.
export const realPaths = (paths) => paths.map((entry) => realpathSync.native(entry)).sort();
export const STALE_RUNNER = '// omp-reviewer-kit runner v0.0.1\nold\n';

// The hook and runner an earlier release left in a worker checkout, which setup() no longer writes.
async function installEarlierRelease(dir) {
  await mkdir(path.join(dir, '.githooks'), { recursive: true });
  await writeFile(path.join(dir, '.githooks', 'pre-commit'), await readFile('templates/githooks/pre-commit', 'utf8'), { mode: 0o755 });
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir, windowsHide: true });
  await mkdir(path.join(dir, '.omp', 'review-kit'), { recursive: true });
  await writeFile(path.join(dir, '.omp', 'review-kit', 'run-review.mjs'), CANONICAL_RUNNER);
}

export async function workspace() {
  const base = await mkdtemp(path.join(tmpdir(), 'omp-target-sync-'));
  const registryFile = path.join(base, 'targets.json');
  // A session start stops live reviews on an older runner, and that stop reads the run records
  // from OMP_REVIEW_KIT_RUNS_DIR or, unset, from the developer's ~/.omp/review-kit-runs. Every
  // test that reaches it points the variable into its own temp folder until cleanup().
  const runsDir = path.join(base, 'runs');
  const savedRunsDir = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  const registry = new FileTargetRegistry({ filePath: registryFile, ignoreTemp: false });
  const installer = new PluginInstallerService({ targetRegistry: registry });
  const repos = [];
  const makeRepo = async (name, { hook = true } = {}) => {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) {
      spawnSync('git', args, { cwd: dir, windowsHide: true });
    }
    if (hook && isSkippedTarget(dir)) await installEarlierRelease(dir);
    else if (hook) assert.equal((await installer.setup(dir)).success, true);
    repos.push(dir);
    return dir;
  };
  const runnerOf = (dir) => path.join(dir, '.omp', 'review-kit', 'run-review.mjs');
  const makeStale = (dir) => writeFile(runnerOf(dir), STALE_RUNNER);
  const cleanup = async () => {
    if (savedRunsDir === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
    else process.env.OMP_REVIEW_KIT_RUNS_DIR = savedRunsDir;
    await rm(base, { recursive: true, force: true });
  };
  return { base, runsDir, registry, registryFile, installer, makeRepo, runnerOf, makeStale, cleanup };
}
