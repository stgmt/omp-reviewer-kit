import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DiffIdentity, FileSystemSnapshotAdapter, StagedSnapshot, SubprocessGitAdapter } from '../src/index.mjs';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

test('snapshot contains exactly the staged files with staged content', async () => {
  // Given a repository where a.txt is staged as v1 and b.txt is modified on disk only
  const repoDir = await mkdtemp(path.join(tmpdir(), 'omp-snapshot-'));
  try {
    git(['init'], repoDir);
    git(['config', 'user.name', 'Snapshot Test'], repoDir);
    git(['config', 'user.email', 'snapshot@test.local'], repoDir);

    await writeFile(path.join(repoDir, 'a.txt'), 'v1', 'utf8');
    git(['add', 'a.txt'], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'v1-edit', 'utf8');
    await writeFile(path.join(repoDir, 'b.txt'), 'v2', 'utf8');

    // When the staged snapshot is captured
    const gitPort = new SubprocessGitAdapter();
    const snapshot = await gitPort.getSnapshot(repoDir);

    // Then only the staged file is present, with the staged (not worktree) content
    assert.equal(snapshot.files.length, 1, 'expected exactly one staged file');
    assert.equal(snapshot.files[0].path, 'a.txt');
    assert.equal(snapshot.files[0].content.toString('utf8'), 'v1', 'worktree edit must not leak into the snapshot');
    assert.match(snapshot.hash, /^[a-f0-9]{64}$/);

    // And materializing the snapshot writes only staged files to the target directory
    const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-snapshot-out-'));
    try {
      await new FileSystemSnapshotAdapter().materialize(snapshot, targetDir);

      const written = await readFile(path.join(targetDir, 'a.txt'), 'utf8');
      assert.equal(written, 'v1');

      const entries = await readdir(targetDir);
      assert.deepEqual(entries.sort(), ['a.txt'], 'only staged files, never unstaged b.txt or generated metadata');
    } finally {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('create materializes .review artifacts with exact diff bytes and manifest', async () => {
  // Given a snapshot and a staged diff identity
  const snapshot = new StagedSnapshot([
    { path: 'src/a.mjs', content: Buffer.from('v1') },
    { path: 'src/b.mjs', content: Buffer.from('v2') },
  ]);
  const diff = DiffIdentity.fromString(
    'diff --git a/src/a.mjs b/src/a.mjs\nindex 111..222 100644\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1 @@\n-old\n+new\n'
  );

  const adapter = new FileSystemSnapshotAdapter();
  const snapshotDir = await adapter.create(snapshot, {
    diffBytes: diff.bytes,
    changedPaths: diff.changedPaths,
  });
  try {
    // Then .review carries the byte-exact diff and the changed-file manifest
    const patch = await readFile(path.join(snapshotDir, '.review', 'diff.patch'));
    assert.ok(patch.equals(diff.bytes), 'diff.patch must preserve the exact diff bytes');
    const manifest = await readFile(path.join(snapshotDir, '.review', 'changed-files.txt'), 'utf8');
    assert.equal(manifest, 'src/a.mjs\n');
    // And the staged files materialized alongside the artifacts
    assert.equal(await readFile(path.join(snapshotDir, 'src', 'a.mjs'), 'utf8'), 'v1');
  } finally {
    await adapter.remove(snapshotDir);
  }
});

test('create without artifacts writes no .review directory', async () => {
  const snapshot = new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('v1') }]);
  const adapter = new FileSystemSnapshotAdapter();
  const snapshotDir = await adapter.create(snapshot);
  try {
    const entries = await readdir(snapshotDir);
    assert.deepEqual(entries, ['a.txt']);
  } finally {
    await adapter.remove(snapshotDir);
  }
});

test('staged paths under .review collide with reserved artifacts and fail loudly', async () => {
  const snapshot = new StagedSnapshot([
    { path: '.review/diff.patch', content: Buffer.from('forged') },
  ]);
  const adapter = new FileSystemSnapshotAdapter();
  await assert.rejects(
    adapter.create(snapshot, { diffBytes: Buffer.from('d'), changedPaths: ['.review/diff.patch'] }),
    /collides with reserved snapshot artifacts directory/
  );
});

test('DiffIdentity.changedPaths parses headers, renames, and quoted paths', () => {
  const diff = DiffIdentity.fromString(
    [
      'diff --git a/src/old.mjs b/src/new.mjs',
      'similarity index 90%',
      'rename from src/old.mjs',
      'rename to src/new.mjs',
      'diff --git "a/dir with space/f.txt" "b/dir with space/f.txt"',
      'index 111..222 100644',
      'diff --git a/src/a.mjs b/src/a.mjs',
      'index 333..444 100644',
    ].join('\n')
  );
  assert.deepEqual(diff.changedPaths.sort(), [
    'dir with space/f.txt',
    'src/a.mjs',
    'src/new.mjs',
    'src/old.mjs',
  ]);
  assert.deepEqual(DiffIdentity.fromString('').changedPaths, []);
});

test('DiffIdentity.changedPaths decodes non-ASCII octal-escaped paths (core.quotepath)', () => {
  const diff = DiffIdentity.fromString(
    [
      'diff --git "a/docs/\\303\\200\\303\\251.md" "b/docs/\\303\\200\\303\\251.md"',
      'index 111..222 100644',
    ].join('\n')
  );
  assert.deepEqual(diff.changedPaths, ['docs/Àé.md']);
});

test('FileSystemSnapshotAdapter rejects case-variant .Review collision (case-insensitive)', async () => {
  const snapshot = new StagedSnapshot([{ path: '.Review', content: Buffer.from('x') }]);
  const adapter = new FileSystemSnapshotAdapter();
  const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-case-'));
  try {
    await assert.rejects(
      adapter.materialize(snapshot, targetDir),
      /collides with reserved snapshot artifacts directory/
    );
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('SubprocessGitAdapter.getSnapshot skips submodule gitlink entries (mode 160000)', async () => {
  const subDir = await mkdtemp(path.join(tmpdir(), 'omp-submod-sub-'));
  const repoDir = await mkdtemp(path.join(tmpdir(), 'omp-submod-'));
  try {
    git(['init'], subDir);
    git(['config', 'user.name', 'Sub'], subDir);
    git(['config', 'user.email', 'sub@test.local'], subDir);
    await writeFile(path.join(subDir, 'inner.txt'), 'x', 'utf8');
    git(['add', 'inner.txt'], subDir);
    git(['commit', '-m', 'sub-init'], subDir);
    const subHead = git(['rev-parse', 'HEAD'], subDir).trim();

    git(['init'], repoDir);
    git(['config', 'user.name', 'Submod Test'], repoDir);
    git(['config', 'user.email', 'submod@test.local'], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'v1', 'utf8');
    git(['add', 'a.txt'], repoDir);
    git(['update-index', '--add', '--cacheinfo', `160000,${subHead},vendor/sub`], repoDir);

    const gitPort = new SubprocessGitAdapter();
    const snapshot = await gitPort.getSnapshot(repoDir);
    const paths = snapshot.files.map((f) => f.path);
    assert.ok(!paths.includes('vendor/sub'), 'submodule gitlink must not be cat-filed');
    assert.ok(paths.includes('a.txt'), 'regular staged file must be present');
  } finally {
    await rm(subDir, { recursive: true, force: true }).catch(() => {});
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('snapshot hash is deterministic for identical staged states', async () => {
  // Given two repositories with byte-identical staged trees
  const repoA = await mkdtemp(path.join(tmpdir(), 'omp-snap-a-'));
  const repoB = await mkdtemp(path.join(tmpdir(), 'omp-snap-b-'));
  try {
    for (const repoDir of [repoA, repoB]) {
      git(['init'], repoDir);
      git(['config', 'user.name', 'Snapshot Test'], repoDir);
      git(['config', 'user.email', 'snapshot@test.local'], repoDir);
      await writeFile(path.join(repoDir, 'x.txt'), 'same bytes', 'utf8');
      git(['add', 'x.txt'], repoDir);
    }

    // When both snapshots are captured
    const gitPort = new SubprocessGitAdapter();
    const snapA = await gitPort.getSnapshot(repoA);
    const snapB = await gitPort.getSnapshot(repoB);

    // Then their hashes are identical
    assert.equal(snapA.hash, snapB.hash);
  } finally {
    await rm(repoA, { recursive: true, force: true }).catch(() => {});
    await rm(repoB, { recursive: true, force: true }).catch(() => {});
  }
});
