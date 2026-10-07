import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import { FileTargetRegistry } from '../src/infra/target-registry.mjs';

export const CANONICAL_RUNNER = await readFile('scripts/run-review.mjs', 'utf8');
// Windows temp directories have a short 8.3 and a long spelling; git reports the long one.
export const realPaths = (paths) => paths.map((entry) => realpathSync.native(entry)).sort();
export const STALE_RUNNER = '// omp-reviewer-kit runner v0.0.1\nold\n';

export async function workspace() {
  const base = await mkdtemp(path.join(tmpdir(), 'omp-target-sync-'));
  const registryFile = path.join(base, 'targets.json');
  const registry = new FileTargetRegistry({ filePath: registryFile, ignoreTemp: false });
  const installer = new PluginInstallerService({ targetRegistry: registry });
  const repos = [];
  const makeRepo = async (name, { hook = true } = {}) => {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) {
      spawnSync('git', args, { cwd: dir, windowsHide: true });
    }
    if (hook) assert.equal((await installer.setup(dir)).success, true);
    repos.push(dir);
    return dir;
  };
  const runnerOf = (dir) => path.join(dir, '.omp', 'review-kit', 'run-review.mjs');
  const makeStale = (dir) => writeFile(runnerOf(dir), STALE_RUNNER);
  return { base, registry, registryFile, installer, makeRepo, runnerOf, makeStale, cleanup: () => rm(base, { recursive: true, force: true }) };
}
