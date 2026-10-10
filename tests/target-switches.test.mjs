import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import initExtension from '../src/extension.mjs';
import { resolveRunsDir } from '../src/infra/filesystem-telemetry-adapter.mjs';
import { CANONICAL_RUNNER, STALE_RUNNER, realPaths, workspace } from './target-workspace.mjs';

test('Given OMP_REVIEW_KIT_AUTO_SYNC=0 or an exhausted budget, Then nothing is healed', async () => {
  const ws = await workspace();
  const saved = process.env.OMP_REVIEW_KIT_AUTO_SYNC;
  try {
    const repo = await ws.makeRepo('paused');
    await ws.registry.add(repo);
    await ws.makeStale(repo);

    process.env.OMP_REVIEW_KIT_AUTO_SYNC = '0';
    assert.deepEqual(await ws.installer.healTargets(), { checked: 0, healed: [], failed: [], pruned: [] });
    assert.deepEqual(await ws.installer.refreshAtSessionStart(repo), { current: null, targets: { checked: 0, healed: [], failed: [], pruned: [] }, stopped: [] });
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), STALE_RUNNER);
    delete process.env.OMP_REVIEW_KIT_AUTO_SYNC;

    assert.deepEqual(await ws.installer.healTargets({ budgetMs: -1 }), { checked: 0, healed: [], failed: [], pruned: [] });
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), STALE_RUNNER);
    assert.deepEqual((await ws.installer.healTargets()).healed, [path.resolve(repo)]);
  } finally {
    if (saved === undefined) delete process.env.OMP_REVIEW_KIT_AUTO_SYNC;
    else process.env.OMP_REVIEW_KIT_AUTO_SYNC = saved;
    await ws.cleanup();
  }
});

test('Given the OMP extension, When a session starts in a hooked repository, Then it registers that repository and heals the registered ones', async () => {
  const ws = await workspace();
  const saved = process.env.OMP_REVIEW_KIT_TARGETS;
  process.env.OMP_REVIEW_KIT_TARGETS = ws.registryFile;
  try {
    const here = await ws.makeRepo('here', { hook: false });
    const other = await ws.makeRepo('other');
    await ws.registry.add(other);
    await ws.makeStale(other);
    const handlers = new Map();
    initExtension({ registerCommand() {}, on: (event, handler) => handlers.set(event, handler), logger: {} });

    await handlers.get('session_start')({}, { cwd: here, ui: { setStatus() {} } });

    assert.equal(await readFile(ws.runnerOf(other), 'utf8'), CANONICAL_RUNNER, 'the other repository was healed');
    assert.equal(await readFile(ws.runnerOf(here), 'utf8'), CANONICAL_RUNNER, 'the current repository was set up as before');
    assert.deepEqual(realPaths(await ws.registry.list()), realPaths([other, here]));

    await ws.makeStale(other);
    const outside = await mkdtemp(path.join(tmpdir(), 'omp-not-git-'));
    try {
      await handlers.get('session_start')({}, { cwd: outside, ui: { setStatus() {} } });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    assert.equal(await readFile(ws.runnerOf(other), 'utf8'), CANONICAL_RUNNER, 'a session outside Git still heals the registered repositories');
  } finally {
    if (saved === undefined) delete process.env.OMP_REVIEW_KIT_TARGETS;
    else process.env.OMP_REVIEW_KIT_TARGETS = saved;
    await ws.cleanup();
  }
});

test('Given a target test workspace, When it is created, Then the run records directory lies inside its temp folder and the previous value returns on cleanup', async () => {
  // Given: whatever the developer's shell has set, possibly nothing.
  const before = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  // When
  const ws = await workspace();
  let released = false;
  try {
    // Then: the automatic stop at session start resolves its records inside the workspace, never the developer's ~/.omp/review-kit-runs.
    const inside = path.relative(ws.base, resolveRunsDir());
    assert.notEqual(inside, '', 'the records directory is a folder inside the workspace');
    assert.equal(inside.startsWith('..') || path.isAbsolute(inside), false, `the records directory ${resolveRunsDir()} is outside ${ws.base}`);
    assert.equal(process.env.OMP_REVIEW_KIT_RUNS_DIR, ws.runsDir);
    await ws.cleanup();
    released = true;
    assert.equal(process.env.OMP_REVIEW_KIT_RUNS_DIR, before, 'cleanup restores the previous value');
  } finally {
    if (!released) await ws.cleanup();
  }
});

test('Given registered repositories, When doctor runs, Then it reports how many are stale', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('doc');
    await ws.registry.add(repo);
    const check = async () => (await ws.installer.doctor(repo)).checks.find((c) => c.name === 'Registered repositories');
    assert.deepEqual(await check(), { name: 'Registered repositories', status: 'OK', message: '1 registered, all current' });
    await ws.makeStale(repo);
    const stale = await check();
    assert.equal(stale.status, 'WARN');
    assert.match(stale.message, /^1 of 1 registered repositories carry a stale hook or runner/);
    await ws.registry.remove(repo);
    assert.equal(await check(), undefined, 'no registry, no line');
  } finally {
    await ws.cleanup();
  }
});

test('Given a repository with a foreign pre-commit hook, When the extension session starts there, Then it is not registered', async () => {
  const ws = await workspace();
  const saved = process.env.OMP_REVIEW_KIT_TARGETS;
  process.env.OMP_REVIEW_KIT_TARGETS = ws.registryFile;
  try {
    const repo = await ws.makeRepo('foreign', { hook: false });
    await mkdir(path.join(repo, '.githooks'), { recursive: true });
    await writeFile(path.join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\necho foreign\n', { mode: 0o755 });
    spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repo, windowsHide: true });
    const handlers = new Map();
    initExtension({ registerCommand() {}, on: (event, handler) => handlers.set(event, handler), logger: {} });

    await handlers.get('session_start')({}, { cwd: repo, ui: { setStatus() {} } });

    assert.deepEqual(await ws.registry.list(), []);
    assert.equal(await readFile(path.join(repo, '.githooks', 'pre-commit'), 'utf8'), '#!/bin/sh\necho foreign\n');
  } finally {
    if (saved === undefined) delete process.env.OMP_REVIEW_KIT_TARGETS;
    else process.env.OMP_REVIEW_KIT_TARGETS = saved;
    await ws.cleanup();
  }
});
