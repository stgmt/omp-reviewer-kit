import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import { isSkippedTarget } from '../src/domain/target-policy.mjs';
import { loadTargets } from '../scripts/sync-targets.mjs';
import { FileTargetRegistry, defaultTargetRegistryPath } from '../src/infra/target-registry.mjs';
import { workspace } from './target-workspace.mjs';

test('Given the shared policy, Then only tp-* and the release checkout are skipped and every other repository, tokenplan included, is synced', () => {
  assert.equal(isSkippedTarget('E:/repos/tp-foo'), true);
  assert.equal(isSkippedTarget('E:/repos/omp-reviewer-kit-release'), true);
  assert.equal(isSkippedTarget('E:/repos/tokenplan'), false);
  assert.equal(isSkippedTarget('E:/repos/omp-spec-kit'), false);
});

test('Given an env override, Then the registry file is the one sync-targets reads', () => {
  assert.equal(defaultTargetRegistryPath({ OMP_REVIEW_KIT_TARGETS: 'X:/targets.json' }), 'X:/targets.json');
  assert.match(defaultTargetRegistryPath({}), /[\\/]\.omp[\\/]review-kit-targets\.json$/);
});

test('Given a registry, When repositories are added, Then it keeps unique existing ones and refuses skipped ones', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('alpha', { hook: false });
    assert.deepEqual(await ws.registry.list(), []);
    assert.equal(await ws.registry.add(repo), true);
    assert.equal(await ws.registry.add(repo), false, 'duplicates are ignored');
    assert.equal(await ws.registry.add(path.join(ws.base, 'missing')), false, 'a path that does not exist is refused');
    const tokenplan = path.join(ws.base, 'tokenplan');
    await mkdir(tokenplan);
    assert.equal(await ws.registry.add(tokenplan), true, 'tokenplan gets the new runner like every other repository');
    for (const name of ['tp-thing', 'omp-reviewer-kit-release']) {
      const skipped = path.join(ws.base, name);
      await mkdir(skipped);
      assert.equal(await ws.registry.add(skipped), false, `${name} is never registered`);
    }
    assert.deepEqual(await ws.registry.list(), [path.resolve(repo), path.resolve(tokenplan)]);
    assert.equal(await ws.registry.remove(repo), true);
    assert.equal(await ws.registry.remove(repo), false);
    assert.deepEqual(await ws.registry.list(), [path.resolve(tokenplan)]);
  } finally {
    await ws.cleanup();
  }
});

test('Given a missing or malformed registry file, Then the list is empty and a later add still registers', async () => {
  const ws = await workspace();
  try {
    assert.deepEqual(await ws.registry.list(), []);
    await writeFile(ws.registryFile, '{"not":"an array"}');
    assert.deepEqual(await ws.registry.list(), []);
    await writeFile(ws.registryFile, 'not json');
    assert.deepEqual(await ws.registry.list(), []);
    await writeFile(ws.registryFile, JSON.stringify([42, '', 'relative-ok']));
    assert.deepEqual(await ws.registry.list(), [path.resolve('relative-ok')]);
    const repo = await ws.makeRepo('beta', { hook: false });
    await writeFile(ws.registryFile, 'not json');
    assert.equal(await ws.registry.add(repo), true);
    assert.deepEqual(await ws.registry.list(), [path.resolve(repo)]);
  } finally {
    await ws.cleanup();
  }
});

test('Given the default registry, Then repositories under the OS temp directory are not remembered', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-temp-repo-'));
  const file = path.join(dir, 'targets.json');
  try {
    assert.equal(await new FileTargetRegistry({ filePath: file, ignoreTemp: true }).add(dir), false);
    assert.equal(await new FileTargetRegistry({ filePath: file, ignoreTemp: false }).add(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a registry that cannot be read or written, Then registering and healing never throw', async () => {
  const broken = {
    list: async () => { throw new Error('unreadable'); },
    add: async () => { throw new Error('read-only'); },
    remove: async () => { throw new Error('read-only'); },
  };
  const installer = new PluginInstallerService({ targetRegistry: broken });
  assert.equal(await installer.registerTarget('E:/anywhere'), false);
  assert.equal(await installer.registerTarget(''), false);
  assert.deepEqual(await installer.healTargets(), { checked: 0, healed: [], failed: [], pruned: [] });
});

test('Given no registry override, Then the default registry skips temp-dir repositories and an override file accepts them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-temp-default-'));
  const file = path.join(dir, 'targets.json');
  const saved = process.env.OMP_REVIEW_KIT_TARGETS;
  try {
    delete process.env.OMP_REVIEW_KIT_TARGETS;
    assert.equal(await new FileTargetRegistry({ filePath: file }).add(dir), false);
    process.env.OMP_REVIEW_KIT_TARGETS = file;
    assert.equal(await new FileTargetRegistry({ filePath: file }).add(dir), true);
  } finally {
    if (saved === undefined) delete process.env.OMP_REVIEW_KIT_TARGETS;
    else process.env.OMP_REVIEW_KIT_TARGETS = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a full registry, Then no further repository is added', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('overflow', { hook: false });
    const entries = Array.from({ length: 200 }, (_, i) => path.join(ws.base, `ghost-${i}`));
    await writeFile(ws.registryFile, JSON.stringify(entries));
    assert.equal(await ws.registry.add(repo), false);
    assert.equal((await ws.registry.list()).length, 200);
    assert.equal(await ws.registry.remove(entries[0]), false, 'the owner file is never rewritten');
    assert.equal((await ws.registry.list()).length, 200);
  } finally {
    await ws.cleanup();
  }
});

test('Given sessions registering different repositories at the same time, Then every registration survives', async () => {
  const ws = await workspace();
  try {
    const names = Array.from({ length: 12 }, (_, i) => `parallel-${i}`);
    const repos = await Promise.all(names.map((name) => ws.makeRepo(name, { hook: false })));
    const other = new FileTargetRegistry({ filePath: ws.registryFile, ignoreTemp: false });
    const results = await Promise.all(repos.map((repo, i) => (i % 2 ? ws.registry : other).add(repo)));
    assert.deepEqual(results, repos.map(() => true));
    assert.deepEqual((await ws.registry.list()).sort(), repos.map((repo) => path.resolve(repo)).sort());
  } finally {
    await ws.cleanup();
  }
});

test('Given foreign or half-written files next to the registrations, Then they are ignored and the owner file is never rewritten', async () => {
  const ws = await workspace();
  try {
    const owned = await ws.makeRepo('owned', { hook: false });
    const added = await ws.makeRepo('added', { hook: false });
    const ownerText = `${JSON.stringify([path.resolve(owned)])}\n`;
    await writeFile(ws.registryFile, ownerText);
    assert.equal(await ws.registry.add(added), true);
    assert.equal(await ws.registry.add(owned), false, 'an entry of the owner file is already registered');
    const dir = `${ws.registryFile}.d`;
    await writeFile(path.join(dir, 'junk.json'), 'not json');
    await writeFile(path.join(dir, 'wrong-shape.json'), '{"path":42}');
    await writeFile(path.join(dir, 'half.tmp'), JSON.stringify({ path: path.resolve(ws.base), addedAt: 1 }));
    assert.deepEqual(await ws.registry.list(), [path.resolve(owned), path.resolve(added)]);
    assert.equal(await ws.registry.remove(owned), false);
    assert.equal(await ws.registry.remove(added), true);
    assert.equal(await ws.registry.remove(added), false);
    assert.deepEqual(await ws.registry.list(), [path.resolve(owned)]);
    assert.equal(await readFile(ws.registryFile, 'utf8'), ownerText);
  } finally {
    await ws.cleanup();
  }
});

test('Given repositories registered by sessions, Then sync-targets reads them with the owner file, or alone when that file is missing', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('synced', { hook: false });
    assert.deepEqual(await loadTargets([], ws.registryFile), [], 'nothing registered, no file');
    assert.equal(await ws.registry.add(repo), true);
    assert.deepEqual(await loadTargets([], ws.registryFile), [path.resolve(repo)]);
    await writeFile(ws.registryFile, JSON.stringify(['E:/owner/repo']));
    assert.deepEqual(await loadTargets([], ws.registryFile), [path.resolve('E:/owner/repo'), path.resolve(repo)]);
  } finally {
    await ws.cleanup();
  }
});
