// Given/When/Then over repository identity: one checkout reached through another spelling is one
// repository, and every consumer that compares repository paths - the run history, the target
// registry, the session heal - answers the same way. Every case works in a temporary folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileTargetRegistry } from '../src/infra/target-registry.mjs';
import { repoIdentity, sameRepository, sameRepositoryPredicate } from '../src/infra/repo-identity.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function withRepos(run) {
  const base = await mkdtemp(path.join(tmpdir(), 'repo-identity-'));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('Given one checkout, When its identity is taken through another spelling, Then the identity is the same', async () => {
  await withRepos(async base => {
    const real = path.join(base, 'checkout');
    const alias = path.join(base, 'alias');
    await mkdir(real);
    await symlink(real, alias, linkType);

    assert.equal(sameRepository(real, alias), true, 'a junction or symlink names the same files');
    if (process.platform === 'win32') {
      assert.equal(sameRepository(real, real.toUpperCase()), true, 'letter case is not identity on Windows');
      assert.equal(sameRepository(real, real.replaceAll('\\', '/')), true, 'separators are not identity');
    }
    assert.equal(sameRepository(real, path.join(base, 'other')), false, 'another folder is another repository');
  });
});

test('Given a value that is not a usable path, When identity is asked, Then it is null and never matches', () => {
  for (const value of [null, undefined, 42, {}, '']) assert.equal(repoIdentity(value), null, String(value));
  assert.equal(sameRepository(null, 'E:/repos/x'), false);
  assert.equal(sameRepository('E:/repos/x', 42), false);
});

test('Given a checkout that no longer exists, When identity is asked, Then its resolved spelling still identifies it', async () => {
  await withRepos(async base => {
    const gone = path.join(base, 'deleted');
    const identity = repoIdentity(gone);
    assert.equal(typeof identity, 'string');
    assert.equal(sameRepository(gone, gone), true, 'a deleted checkout keeps the records it wrote findable');
  });
});

test('Given one repository, When many candidates are compared, Then each distinct spelling is resolved once', async () => {
  await withRepos(async base => {
    const real = path.join(base, 'checkout');
    await mkdir(real);
    const matches = sameRepositoryPredicate(real);
    assert.equal(matches(real), true);
    assert.equal(matches(real), true);
    assert.equal(matches(path.join(base, 'other')), false);
    assert.equal(matches(null), false, 'a record without a repository never matches');
    assert.equal(sameRepositoryPredicate(null)(real), false, 'a filter without a repository matches nothing');
  });
});

test('Given one repository, When a candidate spelling repeats, Then it is resolved once and the comparison still matches', async () => {
  await withRepos(async base => {
    const real = path.join(base, 'checkout');
    await mkdir(real);
    const resolved = [];
    const matches = sameRepositoryPredicate(real, {
      resolve: value => {
        resolved.push(value);
        return repoIdentity(value);
      },
    });
    assert.equal(matches(real), true);
    assert.equal(matches(real), true, 'a repeated spelling is served from the comparison cache');
    assert.equal(matches(path.join(base, 'other')), false);
    assert.deepEqual(resolved.filter(value => value !== real), [path.join(base, 'other')], 'only the unseen spelling is resolved again');
    assert.equal(resolved.length, 3, 'one resolution for the repository itself and one per distinct candidate spelling');
  });
});

test('Given a registered repository, When it is registered again through an alias, Then the registry keeps one entry', async () => {
  await withRepos(async base => {
    const real = path.join(base, 'checkout');
    const alias = path.join(base, 'alias');
    await mkdir(real);
    await symlink(real, alias, linkType);
    const registry = new FileTargetRegistry({ filePath: path.join(base, 'targets.json'), ignoreTemp: false });

    assert.equal(await registry.add(real), true);
    assert.equal(await registry.add(alias), false, 'the alias names the registered repository');
    assert.equal((await registry.list()).length, 1);

    assert.equal(await registry.remove(alias), true, 'a removal through the alias finds the same registration');
    assert.deepEqual(await registry.list(), []);
  });
});

test('Given a registration an earlier release keyed by its spelling, When it is removed through either spelling, Then the stale file is gone', async () => {
  await withRepos(async base => {
    const real = path.join(base, 'checkout');
    const alias = path.join(base, 'alias');
    await mkdir(real);
    await symlink(real, alias, linkType);
    const registryFile = path.join(base, 'targets.json');
    const registry = new FileTargetRegistry({ filePath: registryFile, ignoreTemp: false });

    // The earlier release hashed the written spelling, so an alias registration lives under its own
    // file name; the identity key cannot find that file on its own.
    const legacyKey = process.platform === 'win32' ? path.resolve(alias).toLowerCase() : path.resolve(alias);
    const legacyFile = path.join(`${registryFile}.d`, `${createHash('sha256').update(legacyKey).digest('hex').slice(0, 32)}.json`);
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, JSON.stringify({ path: path.resolve(alias), addedAt: 1 }), 'utf8');
    assert.deepEqual(await registry.list(), [path.resolve(alias)], 'the legacy registration is listed');

    assert.equal(await registry.remove(real), true, 'the real path deregisters the alias registration');
    assert.deepEqual(await registry.list(), [], 'no stale registration survives');
  });
});

test('Given the owner file names a repository by an alias, When a session registers the real path, Then one repository is listed', async () => {
  await withRepos(async base => {
    const real = path.join(base, 'checkout');
    const alias = path.join(base, 'alias');
    await mkdir(real);
    await symlink(real, alias, linkType);
    const ownerFile = path.join(base, 'owner.json');
    await writeFile(ownerFile, JSON.stringify([alias]), 'utf8');
    const registry = new FileTargetRegistry({ filePath: ownerFile, ignoreTemp: false });

    assert.equal(await registry.add(real), false, 'the owner file already names this repository under another spelling');
    assert.deepEqual(await registry.list(), [alias], 'the owner file keeps its own spelling and is listed once');
  });
});
