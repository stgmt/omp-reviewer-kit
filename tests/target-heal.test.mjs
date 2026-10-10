import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('Given another tool\'s hook next to ours, Then a stale runner is refreshed only while .githooks is already the hooks path', async () => {
  const ws = await workspace();
  try {
    const live = await ws.makeRepo('live-hooks');
    await writeFile(path.join(live, '.githooks', 'pre-push'), '#!/bin/sh\necho theirs\n', { mode: 0o755 });
    await ws.makeStale(live);
    const dormant = await ws.makeRepo('dormant-hooks');
    spawnSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: dormant, windowsHide: true });
    await writeFile(path.join(dormant, '.githooks', 'pre-push'), '#!/bin/sh\necho theirs\n', { mode: 0o755 });
    await ws.makeStale(dormant);
    for (const repo of [live, dormant]) await ws.registry.add(repo);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary.healed, [path.resolve(live)], 'already running .githooks: only the runner is refreshed');
    assert.equal(await readFile(ws.runnerOf(live), 'utf8'), CANONICAL_RUNNER);
    assert.equal(await readFile(path.join(live, '.githooks', 'pre-push'), 'utf8'), '#!/bin/sh\necho theirs\n');
    assert.equal(await readFile(ws.runnerOf(dormant), 'utf8'), STALE_RUNNER, 'activating .githooks would start their hook: left alone');
    assert.equal((await ws.installer.status(dormant)).state, 'conflict');
  } finally {
    await ws.cleanup();
  }
});

test('Given a stale worker checkout under omp-tasks that an earlier release registered, When targets are healed, Then the checkout is left as it is', async () => {
  const ws = await workspace();
  try {
    const worker = await ws.makeRepo(path.join('omp-tasks', 'task-1', 'wt'));
    const other = await ws.makeRepo('other');
    // The registry now refuses worker checkouts, but entries written before the policy stay in the owner file.
    await writeFile(ws.registryFile, JSON.stringify([worker, other]));
    await ws.makeStale(worker);
    await ws.makeStale(other);
    const hook = path.join(worker, '.githooks', 'pre-commit');
    const hookBefore = await readFile(hook, 'utf8');

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary, { checked: 1, healed: [path.resolve(other)], failed: [], pruned: [] }, 'the worker checkout is not even inspected');
    assert.equal(await readFile(ws.runnerOf(worker), 'utf8'), STALE_RUNNER, 'the automatic heal never writes into a worker checkout');
    assert.equal(await readFile(hook, 'utf8'), hookBefore, 'its hook is not rewritten either');
  } finally {
    await ws.cleanup();
  }
});

test('Given a worker checkout under omp-tasks that lost its git directory, When targets are healed, Then it is neither pruned nor counted and stays registered', async () => {
  const ws = await workspace();
  try {
    const worker = await ws.makeRepo(path.join('omp-tasks', 'task-2', 'wt'));
    const other = await ws.makeRepo('other');
    await writeFile(ws.registryFile, JSON.stringify([worker, other]));
    await ws.makeStale(other);
    await rm(path.join(worker, '.git'), { recursive: true, force: true });
    await ws.makeStale(worker);
    const workerRunner = await readFile(ws.runnerOf(worker), 'utf8');

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary, { checked: 1, healed: [path.resolve(other)], failed: [], pruned: [] }, 'the skipped checkout is not pruned as a non-repository');
    assert.deepEqual(JSON.parse(await readFile(ws.registryFile, 'utf8')), [worker, other], 'and it stays in the registry');
    assert.equal(await readFile(ws.runnerOf(worker), 'utf8'), workerRunner, 'its files are unchanged');
  } finally {
    await ws.cleanup();
  }
});

test('Given a stale worker checkout under omp-tasks in the registry, When the doctor counts registered repositories, Then it is not reported as one a session start repairs', async () => {
  const ws = await workspace();
  try {
    const worker = await ws.makeRepo(path.join('omp-tasks', 'task-3', 'wt'));
    const other = await ws.makeRepo('other');
    await writeFile(ws.registryFile, JSON.stringify([worker, other]));
    await ws.makeStale(worker);

    const check = (await ws.installer.doctor(other)).checks.find((c) => c.name === 'Registered repositories');

    assert.deepEqual({ status: check.status, message: check.message }, { status: 'OK', message: '1 registered, all current' });
  } finally {
    await ws.cleanup();
  }
});

test('Given a stale worker checkout under omp-tasks, When the doctor inspects it, Then it says the kit does not repair it instead of promising a repair', async () => {
  const ws = await workspace();
  try {
    const worker = await ws.makeRepo(path.join('omp-tasks', 'task-4', 'wt'));
    await ws.makeStale(worker);

    const check = (await ws.installer.doctor(worker)).checks.find((c) => c.name === 'Pre-commit hook');

    assert.equal(check.status, 'WARN');
    assert.match(check.message, /outside the kit's reach: the review runner script is stale, and no session repairs it/);
    assert.doesNotMatch(check.message, /will be updated on next session/);
  } finally {
    await ws.cleanup();
  }
});

test('Given a stale hook that is not executable in a regular repository, When the doctor inspects it, Then it says the hook is repaired on the next session', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('plain-repo');
    const status = ws.installer.status.bind(ws.installer);
    ws.installer.status = async (dir) => ({ ...(await status(dir)), state: 'stale', hookExecutable: false });

    const check = (await ws.installer.doctor(repo)).checks.find((c) => c.name === 'Pre-commit hook');

    assert.equal(check.status, 'WARN');
    assert.equal(check.message, 'Pre-commit hook is not executable and will be repaired on next session.');
  } finally {
    await ws.cleanup();
  }
});

/** A registration as an earlier release wrote it: one file per repository in the registry's entries folder. */
async function writeRegistration(registryFile, repo) {
  const resolved = path.resolve(repo);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const entries = `${registryFile}.d`;
  await mkdir(entries, { recursive: true });
  await writeFile(path.join(entries, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`), `${JSON.stringify({ path: resolved, addedAt: 1 })}\n`, 'utf8');
}

test('Given a worker checkout that an earlier release registered and that lost its git directory, When targets are healed, Then its registration is kept', async () => {
  const ws = await workspace();
  try {
    const worker = await ws.makeRepo(path.join('omp-tasks', 'task-6', 'wt'));
    await rm(path.join(worker, '.git'), { recursive: true, force: true });
    await writeRegistration(ws.registryFile, worker);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary.pruned, [], 'the skipped checkout is not pruned as a non-repository');
    assert.deepEqual(await ws.registry.list(), [path.resolve(worker)], 'and its registration stays');
  } finally {
    await ws.cleanup();
  }
});
