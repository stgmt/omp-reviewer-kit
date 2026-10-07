import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CANONICAL_RUNNER, workspace } from './target-workspace.mjs';

test('Given a session in a stale repository, When the session starts, Then it is repaired, registered, and the other registered repositories are healed', async () => {
  const ws = await workspace();
  try {
    const here = await ws.makeRepo('here');
    const other = await ws.makeRepo('other');
    await ws.registry.add(other);
    await ws.makeStale(here);
    await ws.makeStale(other);

    const outcome = await ws.installer.refreshAtSessionStart(here);

    assert.equal(outcome.current.success, true);
    assert.deepEqual(outcome.targets.healed, [path.resolve(other)]);
    assert.equal(await readFile(ws.runnerOf(here), 'utf8'), CANONICAL_RUNNER);
    assert.equal(await readFile(ws.runnerOf(other), 'utf8'), CANONICAL_RUNNER);
    assert.deepEqual((await ws.registry.list()).sort(), [path.resolve(other), path.resolve(here)].sort());
  } finally {
    await ws.cleanup();
  }
});

test('Given a session in a repository without the hook or outside Git, Then it is neither installed nor registered but others are still healed', async () => {
  const ws = await workspace();
  try {
    const bare = await ws.makeRepo('bare', { hook: false });
    const other = await ws.makeRepo('other');
    await ws.registry.add(other);
    await ws.makeStale(other);

    const inBare = await ws.installer.refreshAtSessionStart(bare);
    assert.equal(inBare.current, null);
    assert.deepEqual(inBare.targets.healed, [path.resolve(other)]);
    assert.deepEqual(await ws.registry.list(), [path.resolve(other)]);

    await ws.makeStale(other);
    const outside = await mkdtemp(path.join(tmpdir(), 'omp-not-git-'));
    try {
      const inOutside = await ws.installer.refreshAtSessionStart(outside);
      assert.equal(inOutside.current, null);
      assert.deepEqual(inOutside.targets.healed, [path.resolve(other)]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await ws.cleanup();
  }
});
