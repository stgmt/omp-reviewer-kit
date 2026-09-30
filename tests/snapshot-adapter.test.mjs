import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DiffIdentity, FileSystemSnapshotAdapter, StagedSnapshot, SubprocessGitAdapter } from '../src/index.mjs';
import { isPidAlive } from '../src/infra/filesystem-snapshot-adapter.mjs';

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
    assert.ok(!entries.includes('.review'), 'no .review directory without artifacts');
    assert.ok(entries.includes('a.txt'), 'staged file materialized');
    assert.ok(entries.every((e) => e === 'a.txt' || /^\.live(-\d+(?:-[0-9a-f]+)?)?$/.test(e)),
      `only staged files plus the in-use marker, got: ${entries.join(',')}`);
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
test('create failure on a shared reuseDir leaves the directory in place', async () => {
  // Gate coverage: the catch path used to rm(targetDir) unconditionally —
  // after assertOwnLease proved a concurrent actor rebuilt the shared dir,
  // that rm destroyed THEIR live tree. A failure must never remove reuseDir.
  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-reuse-'));
  const adapter = new FileSystemSnapshotAdapter();
  adapter.materialize = async () => { throw new Error('simulated materialize failure'); };
  const snapshot = new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]);
  try {
    await assert.rejects(
      adapter.create(snapshot, { diffBytes: Buffer.from('d'), changedPaths: ['a.txt'], reuseDir }),
      /simulated materialize failure/
    );
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(reuseDir), true, 'shared reuseDir must survive a failed materialize');
  } finally {
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('materialize rejects control bytes in staged paths', async () => {
  // Gate coverage: control bytes (\x00, \x1f, \x7f) in a staged path must be
  // rejected, not passed to writeFile where they corrupt the snapshot or
  // throw platform-dependent errors.
  const adapter = new FileSystemSnapshotAdapter();
  const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-ctl-'));
  try {
    for (const bad of ['bad\x00x.txt', 'a/bad\x1f.txt', 'bad\x7f.txt']) {
      const snapshot = new StagedSnapshot([{ path: bad, content: Buffer.from('x') }]);
      await assert.rejects(
        adapter.materialize(snapshot, targetDir),
        /Unsafe staged path in snapshot/,
        `path ${JSON.stringify(bad)} must be rejected`
      );
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('materialize rejects NTFS-folded names colliding with reserved .live/.review', async () => {
  // Gate coverage: Windows strips trailing dots/spaces, so '.live-1.' and
  // '.review.' materialize as the reserved names — a planted lease or a
  // hidden artifacts dir bypassing the literal-name checks.
  const adapter = new FileSystemSnapshotAdapter();
  const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-fold-'));
  try {
    for (const bad of ['.live-1.', '.review.', '.live-1./x.txt', '.live ']) {
      const snapshot = new StagedSnapshot([{ path: bad, content: Buffer.from('x') }]);
      await assert.rejects(
        adapter.materialize(snapshot, targetDir),
        /folds onto reserved snapshot namespace|collides with reserved snapshot/,
        `path ${JSON.stringify(bad)} must be rejected`
      );
    }
    // A non-reserved name that merely folds differently must still pass.
    const okSnapshot = new StagedSnapshot([{ path: 'normal-a.txt', content: Buffer.from('y') }]);
    await adapter.materialize(okSnapshot, targetDir);
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('materialize rejects backslash .. segments (Windows resolution escapes /-only check)', async () => {
  // Gate coverage: path.resolve honors '\' on Windows — 'z\..\a.mjs' would
  // write outside the snapshot and 'z\..\.live-99' forges lease markers.
  const adapter = new FileSystemSnapshotAdapter();
  const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-bsep-'));
  try {
    for (const bad of ['z\\..\\a.mjs', 'z\\..\\.live-99', 'x\\..\\..\\b.txt']) {
      const snapshot = new StagedSnapshot([{ path: bad, content: Buffer.from('x') }]);
      await assert.rejects(
        adapter.materialize(snapshot, targetDir),
        /Unsafe staged path in snapshot/,
        `path ${JSON.stringify(bad)} must be rejected`
      );
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('create diverts a live foreign reuseDir without keeping our lease stamp', async () => {
  // Correctness-1: while #isReusable byte-verifies the index, a concurrent
  // same-diff reviewer could rm+rebuild the dir — stamping BEFORE the probe
  // protects the window, but if we divert (foreign live marker) our stamp
  // must be dropped so we never extend liveness on a foreign tree.
  const { existsSync } = await import('node:fs');
  const adapter = new FileSystemSnapshotAdapter();
  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-lease-'));
  const foreignMarker = path.join(reuseDir, '.live-424242');
  let created;
  try {
    await writeFile(foreignMarker, 'foreign');
    // Stale index bytes → isReusable fails; foreign fresh marker → isLive.
    created = await adapter.create(
      new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]),
      { diffBytes: Buffer.from('d'), changedPaths: ['a.txt'], reuseDir }
    );
    assert.notEqual(created, reuseDir, 'must divert to a transient dir');
    const { readdirSync } = await import('node:fs');
    const ownLeft = readdirSync(reuseDir).filter((n) => new RegExp(`^\\.live-${process.pid}(?:-[0-9a-f]+)?$`).test(n));
    assert.equal(ownLeft.length, 0, 'our stamp dropped on divert');
    assert.equal(existsSync(foreignMarker), true, 'foreign lease untouched');
    assert.equal(existsSync(reuseDir), true, 'foreign live dir never destroyed');
  } finally {
    if (created) await adapter.remove(created).catch(() => {});
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('create sanitizes control bytes in changed-files.txt manifest lines', async () => {
  // Gate coverage: a deleted staged path carries no snapshot file, so it
  // never reaches materialize — but its raw name lands in changed-files.txt
  // and then in the reviewer prompt context. Control bytes must be escaped.
  const snapshot = new StagedSnapshot([{ path: 'keep.txt', content: Buffer.from('k') }]);
  const adapter = new FileSystemSnapshotAdapter();
  const snapshotDir = await adapter.create(snapshot, {
    diffBytes: Buffer.from('d'),
    changedPaths: ['keep.txt', 'del\x00ete.txt'],
  });
  try {
    const manifest = await readFile(path.join(snapshotDir, '.review', 'changed-files.txt'), 'utf8');
    assert.equal(manifest.includes('\x00'), false, 'raw NUL must not reach the manifest');
    assert.ok(manifest.includes('del\\u0000ete.txt'), 'escaped control byte present in manifest');
  } finally {
    await adapter.remove(snapshotDir);
  }
});
test('failed reuseDir rebuild drops our freshly stamped lease', async () => {
  // Gate coverage: create() stamps .live-<pid> BEFORE materialize on the
  // rebuild path; a mid-flight failure must drop that marker so the next
  // process sees a dead (rebuildable) dir, not a foreign live lease that
  // diverts to transient for up to 24h.
  const { existsSync } = await import('node:fs');
  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-lease-'));
  const adapter = new FileSystemSnapshotAdapter();
  adapter.materialize = async () => { throw new Error('simulated materialize failure'); };
  const snapshot = new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]);
  try {
    await assert.rejects(
      adapter.create(snapshot, { diffBytes: Buffer.from('d'), changedPaths: ['a.txt'], reuseDir }),
      /simulated materialize failure/
    );
    assert.equal(existsSync(reuseDir), true, 'shared reuseDir itself survives');
    const { readdirSync } = await import('node:fs');
    assert.equal(
      readdirSync(reuseDir).filter((n) => new RegExp(`^\\.live-${process.pid}(?:-[0-9a-f]+)?$`).test(n)).length,
      0,
      'our lease marker dropped after failed rebuild'
    );
    // And a retry now rebuilds cleanly instead of diverting to transient.
    const okAdapter = new FileSystemSnapshotAdapter();
    const second = await okAdapter.create(snapshot, { diffBytes: Buffer.from('d'), changedPaths: ['a.txt'], reuseDir });
    assert.equal(second, reuseDir, 'retry materializes into the shared dir');
    assert.equal(existsSync(path.join(reuseDir, 'a.txt')), true);
  } finally {
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('refreshLease never resurrects a released or missing marker', async () => {
  // Gate coverage: the heartbeat used to #markLive the dir when the marker
  // was absent — an in-flight tick landing after release() re-stamped the
  // lease as a foreign-live marker for the next 24h.
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-heartbeat-'));
  const adapter = new FileSystemSnapshotAdapter();
  const marker = path.join(dir, adapter.leaseName);
  const { existsSync } = await import('node:fs');
  try {
    // No marker at all → refresh creates nothing.
    await adapter.refreshLease(dir);
    assert.equal(existsSync(marker), false, 'refreshLease must not create a marker');
    // Present marker → refreshed in place (still a regular file).
    await writeFile(marker, `${process.pid}\n`, 'utf8');
    await adapter.refreshLease(dir);
    assert.equal(existsSync(marker), true);
    // Release removes it; a trailing tick after release must not resurrect.
    await adapter.release(dir);
    await adapter.refreshLease(dir);
    assert.equal(existsSync(marker), false, 'post-release tick must not resurrect the lease');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('materialize rejects staged paths folding onto one on-disk name', async () => {
  // Gate coverage: SRC/x + src/x, a\b + a/b, file. + file all resolve to
  // one NTFS/CI filesystem destination — last-write-wins hid payload diffs.
  const adapter = new FileSystemSnapshotAdapter();
  const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-foldpair-'));
  try {
    for (const pair of [
      ['SRC/x.txt', 'src/x.txt'],
      ['a\\b.txt', 'a/b.txt'],
      ['file.', 'file'],
      ['file ', 'file'],
    ]) {
      const snapshot = new StagedSnapshot(pair.map((p) => ({ path: p, content: Buffer.from('x') })));
      await assert.rejects(
        adapter.materialize(snapshot, targetDir),
        /fold onto one on-disk name/,
        `pair ${JSON.stringify(pair)} must be rejected`
      );
    }
    // Same-dir case-variant siblings are legal staged content when they
    // keep distinct folded names.
    await adapter.materialize(
      new StagedSnapshot([
        { path: 'src/a.txt', content: Buffer.from('1') },
        { path: 'SRC/b.txt', content: Buffer.from('2') },
      ]),
      targetDir,
    );
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('file-classes.json sanitizes path bytes like changed-files.txt', async () => {
  // Gate coverage: deleted staged paths reach the manifest with sha256 null
  // and never pass assertSafeSnapshotPath — their raw bytes (bidi marks,
  // zero-width) must not reach the reviewer-facing manifest.
  const snapshot = new StagedSnapshot([{ path: 'keep.txt', content: Buffer.from('k') }]);
  const adapter = new FileSystemSnapshotAdapter();
  const snapshotDir = await adapter.create(snapshot, {
    diffBytes: Buffer.from('d'),
    changedPaths: ['keep.txt', 'gone\u202exed.mjs'],
    fileClasses: [
      { path: 'keep.txt', fileClass: 'docs', sha256: 'aa' },
      { path: 'gone\u202exed.mjs', fileClass: 'executable', sha256: null },
    ],
  });
  try {
    const manifest = JSON.parse(await readFile(path.join(snapshotDir, '.review', 'file-classes.json'), 'utf8'));
    const paths = manifest.files.map((r) => r.path);
    assert.equal(paths.some((p) => p.includes('\u202e')), false, 'raw bidi mark must not persist');
    assert.ok(paths.some((p) => p.includes('gone\\u202e')), 'escaped bidi mark present');
  } finally {
    await adapter.remove(snapshotDir);
  }
});

test('runner adapter copy enforces identical safety guards', async () => {
  // Gate coverage: the distributable runner embeds its own adapter copy —
  // run the same invariants against it (fold dedup, control bytes, lease
  // drop on failure, non-resurrecting refresh).
  const Runner = await import('../scripts/run-review.mjs');
  const RunnerAdapter = Runner.FileSystemSnapshotAdapter;
  const RunnerSnapshot = Runner.StagedSnapshot;
  assert.ok(RunnerAdapter && RunnerSnapshot, 'runner exports adapter + snapshot');
  const { existsSync } = await import('node:fs');

  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-rlease-'));
  const adapter = new RunnerAdapter();
  adapter.materialize = async () => { throw new Error('boom'); };
  try {
    await assert.rejects(
      adapter.create(new RunnerSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]),
        { diffBytes: Buffer.from('d'), changedPaths: ['a.txt'], reuseDir }),
      /boom/
    );
    // Namespace assertion, not a literal: real leases carry a random hex
    // suffix (.live-<pid>-<8hex>), so existsSync('.live-<pid>') is vacuous —
    // assert NO own-pid marker remains at all.
    const { readdirSync } = await import('node:fs');
    const leaked = readdirSync(reuseDir).filter((n) => new RegExp(`^\\.live-${process.pid}(?:-[0-9a-f]+)?$`).test(n));
    assert.deepEqual(leaked, [], 'runner drops every own-pid lease marker');
  } finally {
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }

  const foldAdapter = new RunnerAdapter();
  const targetDir = await mkdtemp(path.join(tmpdir(), 'omp-rfold-'));
  try {
    await assert.rejects(
      foldAdapter.materialize(new RunnerSnapshot([
        { path: 'SRC/x.txt', content: Buffer.from('x') },
        { path: 'src/x.txt', content: Buffer.from('y') },
      ]), targetDir),
      /fold onto one on-disk name/
    );
    await assert.rejects(
      foldAdapter.materialize(new RunnerSnapshot([{ path: 'bad\x00x.txt', content: Buffer.from('x') }]), targetDir),
      /Unsafe staged path in snapshot/
    );
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }

  const hbDir = await mkdtemp(path.join(tmpdir(), 'omp-rhb-'));
  try {
    await foldAdapter.refreshLease(hbDir);
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(hbDir).filter((n) => /^\.live/.test(n)).length, 0, 'runner heartbeat never resurrects');
    await assert.rejects(
      foldAdapter.materialize(new RunnerSnapshot([{ path: 'z\\..\\a.mjs', content: Buffer.from('x') }]), targetDir),
      /Unsafe staged path in snapshot/
    );
  } finally {
    await rm(hbDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('assertSafeSnapshotPath rejects NTFS ADS colons on Windows, allows POSIX-legal names elsewhere', async () => {
  // Round-16 security-1: 'file.ts:evil' writes the ADS of file.ts on Windows
  // while the manifest lists the staged name — silent content evasion.
  // r25 correctness-1: the hazard only materializes on Windows/NTFS —
  // POSIX hosts must NOT hard-fail on colon filenames.
  const { FileSystemSnapshotAdapter, StagedSnapshot } = await import('../scripts/run-review.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-ads-'));
  const adapter = new FileSystemSnapshotAdapter();
  try {
    if (process.platform === 'win32') {
      await assert.rejects(
        adapter.materialize(new StagedSnapshot([{ path: 'x.ts:evil', content: Buffer.from('p') }]), dir),
        /Unsafe staged path/
      );
      await assert.rejects(
        adapter.materialize(new StagedSnapshot([{ path: 'dir:withcolon/x.ts', content: Buffer.from('p') }]), dir),
        /Unsafe staged path/
      );
    } else {
      // POSIX-legal: materializes as a plain file, no evasion possible.
      await adapter.materialize(new StagedSnapshot([{ path: 'x.ts:evil', content: Buffer.from('p') }]), dir);
      await adapter.materialize(new StagedSnapshot([{ path: 'dir:withcolon/x.ts', content: Buffer.from('p') }]), dir);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('isPidAlive: EPERM means alive, ESRCH/other codes dead, non-integer pids rejected without kill', async () => {
  // Patch the global kill seam deterministically; restores in finally.
  const originalKill = process.kill;
  try {
    const calls = [];
    const makeKill = (err) => (pid, sig) => { calls.push([pid, sig]); if (err) { const e = new Error('x'); e.code = err; throw e; } };

    process.kill = makeKill(null);
    assert.equal(isPidAlive(process.pid), true, 'own live pid must report alive');
    assert.ok(calls.length >= 1, 'kill probe must run for a valid pid');

    process.kill = makeKill('EPERM');
    assert.equal(isPidAlive(99999), true, 'EPERM = permission denied = pid alive (foreign-owned)');

    process.kill = makeKill('ESRCH');
    assert.equal(isPidAlive(99999), false, 'ESRCH = no such process = dead');

    process.kill = makeKill('EINVAL');
    assert.equal(isPidAlive(99999), false, 'unexpected codes fail closed to dead');

    calls.length = 0;
    for (const bad of [0, -3, 1.5, NaN, '123', null, undefined]) {
      assert.equal(isPidAlive(bad), false, `pid ${bad} must be rejected`);
    }
    assert.equal(calls.length, 0, 'invalid pids must never invoke process.kill');
  } finally {
    process.kill = originalKill;
  }
});

test('win32-only staged-path rejections: DOS devices and NTFS 8.3 aliases (r27 coverage-1)', async () => {
  // win32: reserved DOS device names and 8.3 short aliases silently alias
  // real filesystem entries — a manifest naming them would evade content
  // checks. POSIX: legal names, must materialize.
  const { FileSystemSnapshotAdapter, StagedSnapshot } = await import('../scripts/run-review.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-dosdev-'));
  const adapter = new FileSystemSnapshotAdapter();
  const bad = ['con.txt', 'dir/nul', 'lpt1.mjs', 'foo~1.txt', 'aux', 'com2/x.ts',
    // Win32 DOS-to-NT folds superscript digits ¹²³ to ASCII 1-3: 'com¹' → COM1.
    'com¹/x.ts', 'dir/lpt³/x.ts', 'com².txt'];
  const ok = ['concat.mjs', 'null.md', 'com10.txt', 'foo~1x.txt'];
  try {
    for (const p of bad) {
      if (process.platform === 'win32') {
        await assert.rejects(
          adapter.materialize(new StagedSnapshot([{ path: p, content: Buffer.from('x') }]), dir),
          /Unsafe staged path/, p);
      } else {
        await adapter.materialize(new StagedSnapshot([{ path: p, content: Buffer.from('x') }]), dir);
      }
    }
    for (const p of ok) {
      await adapter.materialize(new StagedSnapshot([{ path: p, content: Buffer.from('x') }]), dir);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('own lease ops bind to this run nonce, never to a sibling same-PID marker (r27 correctness-1)', async () => {
  // #ownMarkerIn must match #leaseName exactly: a stale same-PID marker from
  // an earlier create()/run is NOT ours — release()/refreshLease() acting on
  // it would serve or drop the wrong lease.
  const { FileSystemSnapshotAdapter, StagedSnapshot } = await import('../scripts/run-review.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-lease-'));
  const adapter = new FileSystemSnapshotAdapter();
  try {
    // Our lease file is what create() stamped: use the public leaseName.
    const own = path.join(dir, adapter.leaseName);
    const staleSibling = `.live-${process.pid}-0000`; // sorts before own nonce under old regex
    await writeFile(own, `${process.pid}\n`, 'utf8');
    await writeFile(path.join(dir, staleSibling), `${process.pid}\n`, 'utf8');

    await adapter.release(dir);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(own), false, 'release must drop OUR lease');
    assert.equal(existsSync(path.join(dir, staleSibling)), true,
      'a foreign-hex same-PID marker must survive our release');

    await adapter.refreshLease(dir);
    assert.equal(existsSync(path.join(dir, staleSibling)), true,
      'refresh must not resurrect another run marker either');

    await adapter.remove(dir).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('lease destroyed between claim stamp and post-claim assert rejects create() (r27 coverage-3)', async () => {
  // After rename(stageDir, reuseDir) our marker lives inside reuseDir; a
  // concurrent destroyer removing it before #assertOwnLease must fail the
  // create(), never serve an unprotected dir.
  const { FileSystemSnapshotAdapter, StagedSnapshot } = await import('../scripts/run-review.mjs');
  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-claim-'));
  const adapter = new FileSystemSnapshotAdapter();
  const { watch, unlinkSync, readdirSync } = await import('node:fs');
  const parent = path.dirname(reuseDir);
  let killer = null;
  let watcher = null;
  const killLive = () => {
    try {
      for (const n of readdirSync(reuseDir)) {
        if (/^\.live-/.test(n)) unlinkSync(path.join(reuseDir, n));
      }
    } catch {}
  };
  try {
    watcher = watch(parent, (event, name) => {
      if (name !== path.basename(reuseDir)) return;
      killLive();
    });
    killer = setInterval(killLive, 1);
    await assert.rejects(
      adapter.create(
        new StagedSnapshot([{ path: 'x.mjs', content: Buffer.from('x') }]),
        { reuseDir, diffBytes: Buffer.from('x'), fileClasses: [], changedPaths: ['x.mjs'] },
      ),
      /lost its in-use lease|snapshot lease lost/,
      'a destroyed own lease across the claim must fail closed');
  } finally {
    if (watcher) watcher.close();
    if (killer) clearInterval(killer);
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('overlapping create() calls on one adapter serialize and stamp distinct leases (r8 correctness-2)', async () => {
  // Two concurrent create()s on the same adapter used to re-roll #leaseName
  // mid-flight: the earlier marker inside the shared reuseDir was orphaned —
  // unreadable by #ownMarkerIn and counted as a foreign live lease for every
  // other process for up to the TTL. The create() gate serializes the calls.
  const { FileSystemSnapshotAdapter, StagedSnapshot } = await import('../scripts/run-review.mjs');
  const { readdirSync } = await import('node:fs');
  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-gate-'));
  const adapter = new FileSystemSnapshotAdapter();
  const diffBytes = Buffer.from('d');
  try {
    const [d1, d2] = await Promise.all([
      adapter.create(new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]), { diffBytes, changedPaths: ['a.txt'], reuseDir }),
      adapter.create(new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]), { diffBytes, changedPaths: ['a.txt'], reuseDir }),
    ]);
    assert.equal(d1, reuseDir, 'first create claims the shared reuseDir');
    assert.equal(d2, reuseDir, 'second create reuses the same reuseDir');
    // Exactly ONE live marker inside: no orphan from a torn map binding.
    const live = readdirSync(reuseDir).filter((n) => /^\.live-\d+-[0-9a-f]+$/.test(n));
    assert.equal(live.length, 1, `expected one marker, got ${JSON.stringify(live)}`);
    // And it is OUR recorded lease for this dir.
    assert.equal(live[0], adapter.leaseName);
  } finally {
    await adapter.release?.(reuseDir).catch(() => {});
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('foreign same-PID markers survive release/refreshLease across ALL adapter copies (r11 coverage)', async () => {
  // #ownMarkerIn must return null when neither the per-dir mapped lease nor
  // #leaseName exists — never fall back to a same-PID scan: a foreign
  // adapter instance's .live-<pid>-<hex> is not ours to unlink. Pin on every
  // runnable copy (src module + distributable runner + deployed .omp copy).
  const modules = [
    ['src', '../src/infra/filesystem-snapshot-adapter.mjs'],
    ['runner', '../scripts/run-review.mjs'],
    ['omp-copy', '../.omp/review-kit/run-review.mjs'],
  ];
  const { writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  for (const [label, spec] of modules) {
    const { FileSystemSnapshotAdapter } = await import(spec);
    const dir = await mkdtemp(path.join(tmpdir(), `omp-foreign-${label}-`));
    const adapter = new FileSystemSnapshotAdapter();
    const foreign = path.join(dir, `.live-${process.pid}-0000`);
    try {
      await writeFile(foreign, `${process.pid}\n`, 'utf8');
      await adapter.release(dir);
      await adapter.refreshLease(dir);
      assert.equal(existsSync(foreign), true,
        `${label}: foreign same-PID marker must survive release+refreshLease`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('sequential create()s on one adapter reclaim the recorded lease; foreign same-PID survives (r11 coverage)', async () => {
  // #markLive reclaims ONLY the lease this instance previously recorded for
  // the dir: a second create() must remove the earlier own marker, while a
  // same-PID marker stamped by a foreign adapter instance survives.
  // src adapter + deployed .omp copy both exercised via the public surface.
  const modules = [
    ['src', '../src/infra/filesystem-snapshot-adapter.mjs', '../src/domain/staged-snapshot.mjs'],
    ['omp', '../.omp/review-kit/run-review.mjs', '../.omp/review-kit/run-review.mjs'],
  ];
  const { writeFile } = await import('node:fs/promises');
  const { existsSync, readdirSync } = await import('node:fs');
  for (const [label, adapterSpec, snapSpec] of modules) {
    const { FileSystemSnapshotAdapter } = await import(adapterSpec);
    const { StagedSnapshot } = await import(snapSpec);
    const reuseDir = await mkdtemp(path.join(tmpdir(), `omp-claim-${label}-`));
    const adapter = new FileSystemSnapshotAdapter();
    const foreign = `.live-${process.pid}-0000`;
    const diffBytes = Buffer.from('d');
    const snap = () => new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('x') }]);
    try {
      // First create stamps lease A in reuseDir; plant a foreign marker too.
      const d1 = await adapter.create(snap(), { diffBytes, changedPaths: ['a.txt'], reuseDir });
      assert.equal(d1, reuseDir);
      const first = adapter.leaseName;
      assert.ok(existsSync(path.join(reuseDir, first)), `${label}: first lease stamped`);
      await writeFile(path.join(reuseDir, foreign), `${process.pid}\n`, 'utf8');
      // Sequential create() re-rolls the lease: the old recorded marker is
      // reclaimed; the foreign same-PID marker survives.
      const d2 = await adapter.create(snap(), { diffBytes, changedPaths: ['a.txt'], reuseDir });
      assert.equal(d2, reuseDir);
      const live = readdirSync(reuseDir).filter((n) => /^\.live-\d+-[0-9a-f]+$/.test(n));
      assert.equal(existsSync(path.join(reuseDir, foreign)), true,
        `${label}: foreign marker must survive sequential creates`);
      assert.ok(!live.includes(first), `${label}: superseded recorded lease was reclaimed, got ${JSON.stringify(live)}`);
      // release() then drops exactly OUR current recorded marker.
      await adapter.release(reuseDir);
      const after = readdirSync(reuseDir).filter((n) => /^\.live-\d+-[0-9a-f]+$/.test(n));
      assert.deepEqual(after, [foreign], `${label}: release drops only our recorded marker`);
    } finally {
      await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('create() gate serializes across src + .omp copies; deferred binding on src adapter (r12 coverage)', async () => {
  // src adapter: #createGate survives a rejected run and serializes; the
  // deferred #leaseByDir binding makes release() on an unstamped dir a
  // no-op. .omp copy gets its own create-serialization pin (importable
  // module, not covered by the runner import above).
  const { existsSync, readdirSync } = await import('node:fs');
  const { FileSystemSnapshotAdapter: SrcAdapter } =
    await import('../src/infra/filesystem-snapshot-adapter.mjs');
  const { StagedSnapshot: SrcSnap } =
    await import('../src/domain/staged-snapshot.mjs');
  const { FileSystemSnapshotAdapter: OmpAdapter, StagedSnapshot: OmpSnap } =
    await import('../.omp/review-kit/run-review.mjs');

  // src: serialized create()s + deferred binding
  const reuseDir = await mkdtemp(path.join(tmpdir(), 'omp-srcgate-'));
  const adapter = new SrcAdapter();
  const diffBytes = Buffer.from('d');
  try {
    const [d1, d2] = await Promise.all([
      adapter.create(new SrcSnap([{ path: 'a.txt', content: Buffer.from('x') }]), { diffBytes, changedPaths: ['a.txt'], reuseDir }),
      adapter.create(new SrcSnap([{ path: 'a.txt', content: Buffer.from('x') }]), { diffBytes, changedPaths: ['a.txt'], reuseDir }),
    ]);
    assert.equal(d1, reuseDir);
    assert.equal(d2, reuseDir);
    const live = readdirSync(reuseDir).filter((n) => /^\.live-\d+-[0-9a-f]+$/.test(n));
    assert.equal(live.length, 1, `src adapter: one marker, got ${JSON.stringify(live)}`);
  } finally {
    await adapter.release?.(reuseDir).catch(() => {});
    await rm(reuseDir, { recursive: true, force: true }).catch(() => {});
  }

  // .omp copy: same serialization contract
  const ompDir = await mkdtemp(path.join(tmpdir(), 'omp-ompgate-'));
  const ompAdapter = new OmpAdapter();
  try {
    const [d1, d2] = await Promise.all([
      ompAdapter.create(new OmpSnap([{ path: 'a.txt', content: Buffer.from('x') }]), { diffBytes, changedPaths: ['a.txt'], reuseDir: ompDir }),
      ompAdapter.create(new OmpSnap([{ path: 'a.txt', content: Buffer.from('x') }]), { diffBytes, changedPaths: ['a.txt'], reuseDir: ompDir }),
    ]);
    assert.equal(d1, ompDir);
    assert.equal(d2, ompDir);
    const live = readdirSync(ompDir).filter((n) => /^\.live-\d+-[0-9a-f]+$/.test(n));
    assert.equal(live.length, 1, `.omp adapter: one marker, got ${JSON.stringify(live)}`);
  } finally {
    await ompAdapter.release?.(ompDir).catch(() => {});
    await rm(ompDir, { recursive: true, force: true }).catch(() => {});
  }
});

