// The staged-state identity: the index tree that keys a review, and the staged paths an ignore rule
// would have kept out. Real git in a temporary repository.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readIndexTreeOid, stagedIgnoredPaths } from '../src/infra/git-index-identity.mjs';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

async function tempRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-tree-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'probe@example.com']);
  git(repo, ['config', 'user.name', 'Probe']);
  await writeFile(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return repo;
}

test('Given a staged change, When the tree is read twice, Then it is the same identity', async () => {
  const repo = await tempRepo();
  try {
    await writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
    git(repo, ['add', 'b.txt']);
    const first = await readIndexTreeOid(repo);
    const second = await readIndexTreeOid(repo);
    assert.match(first, /^[0-9a-f]{40,64}$/);
    assert.equal(first, second);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('Given one more staged file, When the tree is read, Then the identity changes', async () => {
  const repo = await tempRepo();
  try {
    await writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
    git(repo, ['add', 'b.txt']);
    const before = await readIndexTreeOid(repo);
    await writeFile(path.join(repo, 'c.txt'), 'three\n', 'utf8');
    git(repo, ['add', 'c.txt']);
    const after = await readIndexTreeOid(repo);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('Given a directory that is not a repository, When the tree is read, Then the identity is null instead of an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-tree-plain-'));
  try {
    assert.equal(await readIndexTreeOid(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given an ignored file forced into the index, When the staged paths are checked, Then it is named and a normal file is not', async () => {
  const repo = await tempRepo();
  try {
    await writeFile(path.join(repo, '.gitignore'), '*.log\n', 'utf8');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-q', '-m', 'ignore logs']);
    await writeFile(path.join(repo, 'feature.mjs'), 'export const x = 1;\n', 'utf8');
    await writeFile(path.join(repo, 'debug.log'), 'junk\n', 'utf8');
    git(repo, ['add', 'feature.mjs']);
    git(repo, ['add', '-f', 'debug.log']);
    const ignored = await stagedIgnoredPaths(repo, ['feature.mjs', 'debug.log']);
    assert.deepEqual(ignored, ['debug.log']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('Given no paths, When the ignore check runs, Then it answers without touching git', async () => {
  assert.deepEqual(await stagedIgnoredPaths('E:/does/not/matter', []), []);
});
