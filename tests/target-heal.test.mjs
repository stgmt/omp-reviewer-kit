import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import { CANONICAL_RUNNER, STALE_RUNNER, workspace } from './target-workspace.mjs';

test('Given a registered repository with a stale runner, When targets are healed, Then the runner is replaced and nothing else changes', async () => {
  const ws = await workspace();
  try {
    const stale = await ws.makeRepo('stale');
    const fresh = await ws.makeRepo('fresh');
    for (const repo of [stale, fresh]) await ws.installer.registerTarget(repo);
    await ws.makeStale(stale);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary, { checked: 2, healed: [path.resolve(stale)], failed: [], pruned: [] });
    assert.equal(await readFile(ws.runnerOf(stale), 'utf8'), CANONICAL_RUNNER);
    assert.equal(await readFile(ws.runnerOf(fresh), 'utf8'), CANONICAL_RUNNER);
    assert.equal((await ws.installer.status(stale)).state, 'active');
  } finally {
    await ws.cleanup();
  }
});

test('Given a registered repository whose runner is newer than the plugin, Then it is never rolled back', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('newer');
    await ws.installer.registerTarget(repo);
    const newer = '// omp-reviewer-kit runner v99.0.0\nnewer\n';
    await writeFile(ws.runnerOf(repo), newer);
    const summary = await ws.installer.healTargets();
    assert.deepEqual(summary.healed, []);
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), newer);
  } finally {
    await ws.cleanup();
  }
});

test('Given registered repositories that never installed the hook, lost their git directory, or are the current one, Then healing leaves them alone', async () => {
  const ws = await workspace();
  try {
    const bare = await ws.makeRepo('bare', { hook: false });
    const gone = await ws.makeRepo('gone');
    const current = await ws.makeRepo('current');
    for (const repo of [bare, gone, current]) await ws.registry.add(repo);
    await ws.makeStale(current);
    await rm(gone, { recursive: true, force: true });

    const summary = await ws.installer.healTargets({ exceptRoot: current });

    assert.deepEqual(summary.healed, []);
    assert.deepEqual(summary.pruned, [path.resolve(gone)]);
    assert.equal(summary.checked, 1, 'only the repository without a hook was inspected and left alone');
    assert.equal(await readFile(ws.runnerOf(current), 'utf8'), STALE_RUNNER, 'the current repository is the caller\'s business');
    assert.deepEqual(await ws.registry.list(), [path.resolve(bare), path.resolve(current)]);
  } finally {
    await ws.cleanup();
  }
});

test('Given a repository with a foreign pre-commit hook, Then healing never touches it', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('foreign', { hook: false });
    await mkdir(path.join(repo, '.githooks'), { recursive: true });
    await writeFile(path.join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\necho foreign\n', { mode: 0o755 });
    spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repo, windowsHide: true });
    await mkdir(path.dirname(ws.runnerOf(repo)), { recursive: true });
    await writeFile(ws.runnerOf(repo), STALE_RUNNER);
    await ws.registry.add(repo);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary.healed, []);
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), STALE_RUNNER);
    assert.equal(await readFile(path.join(repo, '.githooks', 'pre-commit'), 'utf8'), '#!/bin/sh\necho foreign\n');
  } finally {
    await ws.cleanup();
  }
});

test('Given a repair that reports failure or throws, Then the repository is listed as failed, not healed', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('unrepairable');
    await ws.registry.add(repo);
    await ws.makeStale(repo);
    const refusing = new (class extends PluginInstallerService {
      async setup() { return { success: false }; }
    })({ targetRegistry: ws.registry });
    assert.deepEqual(await refusing.healTargets(), { checked: 1, healed: [], failed: [path.resolve(repo)], pruned: [] });
    const crashing = new (class extends PluginInstallerService {
      async setup() { throw new Error('disk full'); }
    })({ targetRegistry: ws.registry });
    assert.deepEqual(await crashing.healTargets(), { checked: 1, healed: [], failed: [path.resolve(repo)], pruned: [] });
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), STALE_RUNNER);
  } finally {
    await ws.cleanup();
  }
});
