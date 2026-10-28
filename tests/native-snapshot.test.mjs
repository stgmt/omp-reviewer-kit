// Given/When/Then over the staged snapshot. Real Git in a temporary repository; no model, no mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeStagedSnapshot, removeSnapshot } from '../src/native/snapshot.mjs';

function git(cwd, args, input) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
    cwd,
    input: input === undefined ? undefined : Buffer.from(input),
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function newRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), 'snapshot-test-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'snapshot test']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return repo;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('Given a staged source change, When the snapshot is materialized, Then files equal the staged blobs and the review inputs are written', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await writeFile(path.join(repo, 'greet.mjs'), 'export const a = 1;\r\nexport const b = 2;\n');
    git(repo, ['add', 'greet.mjs']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {} });

    assert.ok(snapshot, 'a staged change yields a snapshot');
    assert.equal(snapshot.profile, 'full');
    assert.deepEqual(snapshot.lanes, ['correctness']);
    assert.deepEqual(snapshot.changedPaths, ['greet.mjs']);
    assert.deepEqual(snapshot.fileClasses, [{ path: 'greet.mjs', fileClass: 'executable' }]);
    assert.equal(
      (await readFile(path.join(snapshot.dir, 'greet.mjs'))).equals(git(repo, ['show', ':greet.mjs'])),
      true,
      'the snapshot file is byte-identical to the staged blob',
    );

    const review = path.join(snapshot.dir, '.review');
    const diff = git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--']);
    assert.equal((await readFile(path.join(review, 'diff.patch'))).equals(diff), true, 'diff.patch is the exact staged diff');
    assert.equal(await readFile(path.join(review, 'changed-files.txt'), 'utf8'), 'greet.mjs\n');
    const classes = JSON.parse(await readFile(path.join(review, 'file-classes.json'), 'utf8'));
    assert.equal(classes.profile, 'full');
    assert.deepEqual(classes.files, [{ path: 'greet.mjs', fileClass: 'executable' }]);
    assert.match(snapshot.diffHash, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.diffHash, createHash('sha256').update(diff).digest('hex'), 'the hash is the SHA-256 of the staged diff bytes');

    await removeSnapshot(snapshot.dir);
    assert.equal(await exists(snapshot.dir), false, 'removeSnapshot deletes the snapshot');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given only documentation is staged, When the snapshot is materialized, Then the profile is spec-docs with the content-risk lane', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, 'docs'));
    await writeFile(path.join(repo, 'docs', 'guide.md'), '# Guide\n');
    git(repo, ['add', 'docs/guide.md']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {} });
    assert.equal(snapshot.profile, 'spec-docs');
    assert.deepEqual(snapshot.lanes, ['content-risk']);
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged test file, When the snapshot is materialized, Then the manifest exposes its test class for the verdict', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, 'tests'));
    await writeFile(path.join(repo, 'tests', 'greet.test.mjs'), 'export const testOnly = 1;\n');
    git(repo, ['add', 'tests/greet.test.mjs']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {} });
    assert.equal(snapshot.profile, 'full');
    assert.deepEqual(snapshot.fileClasses, [{ path: 'tests/greet.test.mjs', fileClass: 'test' }]);
    const classes = JSON.parse(await readFile(path.join(snapshot.dir, '.review', 'file-classes.json'), 'utf8'));
    assert.deepEqual(classes.files, snapshot.fileClasses);
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged path under the reserved .review directory, When the snapshot is materialized, Then it fails before exporting', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, '.review'));
    await writeFile(path.join(repo, '.review', 'diff.patch'), 'staged by a user\n');
    git(repo, ['add', '.review/diff.patch']);
    await assert.rejects(
      materializeStagedSnapshot({ repo, parentDir: parent, env: {} }),
      /reserved \.review\/ directory/,
    );
    assert.deepEqual(await readdirSafe(parent), [], 'no snapshot directory is left behind');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given nothing is staged, When the snapshot is materialized, Then there is no snapshot', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    assert.equal(await materializeStagedSnapshot({ repo, parentDir: parent, env: {} }), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged deletion, When the snapshot is materialized, Then the deleted path is named but not exported', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    git(repo, ['rm', '-q', 'base.txt']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {} });
    assert.deepEqual(snapshot.changedPaths, ['base.txt']);
    assert.equal(await exists(path.join(snapshot.dir, 'base.txt')), false);
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the export step fails after the snapshot directory exists, When materialized, Then the error reaches the caller and no partial snapshot is left behind', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await writeFile(path.join(repo, 'greet.mjs'), 'export const a = 1;\n');
    git(repo, ['add', 'greet.mjs']);
    await assert.rejects(
      materializeStagedSnapshot({
        repo,
        parentDir: parent,
        env: {},
        checkoutIndex: async (_repo, dir) => {
          await writeFile(path.join(dir, 'partial.mjs'), 'export const partial = 1;\n');
          throw new Error('export interrupted');
        },
      }),
      /export interrupted/,
    );
    assert.deepEqual(await readdirSafe(parent), [], 'the partial snapshot directory is removed');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a parent directory with Windows separators, When materialized, Then the export lands in that directory', { skip: process.platform === 'win32' ? false : 'Windows path separators only' }, async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await writeFile(path.join(repo, 'greet.mjs'), 'export const a = 1;\n');
    git(repo, ['add', 'greet.mjs']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {} });
    assert.match(snapshot.dir, /\\/, 'the snapshot directory is a Windows path');
    assert.equal(await readFile(path.join(snapshot.dir, 'greet.mjs'), 'utf8'), 'export const a = 1;\n');
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

async function readdirSafe(dir) {
  const { readdir } = await import('node:fs/promises');
  return readdir(dir);
}

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalHook = await readFile(path.join(kitRoot, 'templates', 'githooks', 'pre-commit'), 'utf8');

test('Given only the vendored kit hook is staged and byte-identical to the installed copy, When materialized, Then nothing is reviewed', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, '.githooks'));
    await writeFile(path.join(repo, '.githooks', 'pre-commit'), canonicalHook);
    git(repo, ['add', '.githooks/pre-commit']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: { OMP_REVIEW_KIT_PLUGIN_DIR: kitRoot } });
    assert.equal(snapshot, null);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the vendored kit hook is staged with a local edit, When materialized, Then it stays in the review', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, '.githooks'));
    await writeFile(path.join(repo, '.githooks', 'pre-commit'), `${canonicalHook}echo edited\n`);
    git(repo, ['add', '.githooks/pre-commit']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: { OMP_REVIEW_KIT_PLUGIN_DIR: kitRoot } });
    assert.deepEqual(snapshot.changedPaths, ['.githooks/pre-commit']);
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged file whose index mode is 100755, When materialized, Then it is classified executable and the profile is full', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, 'tools'));
    await mkdir(path.join(repo, 'docs'));
    await writeFile(path.join(repo, 'tools', 'run.dat'), 'payload\n');
    await writeFile(path.join(repo, 'docs', 'a.md'), '# A\n');
    git(repo, ['add', 'tools/run.dat', 'docs/a.md']);
    git(repo, ['update-index', '--chmod=+x', 'tools/run.dat']);
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {} });
    assert.equal(snapshot.profile, 'full', 'the executable bit from the index makes the change a full review');
    const classes = JSON.parse(await readFile(path.join(snapshot.dir, '.review', 'file-classes.json'), 'utf8'));
    assert.deepEqual(classes.files.find(file => file.path === 'tools/run.dat'), { path: 'tools/run.dat', fileClass: 'executable' });
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a path with unmerged index records and no stage-0 entry, When materialized, Then its mode is not read from the conflict', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    await mkdir(path.join(repo, 'tools'));
    await mkdir(path.join(repo, 'docs'));
    await writeFile(path.join(repo, 'tools', 'run.dat'), 'payload\n');
    await writeFile(path.join(repo, 'docs', 'a.md'), '# A\n');
    git(repo, ['add', 'docs/a.md']);
    const sha = git(repo, ['hash-object', '-w', 'tools/run.dat']).toString('utf8').trim();
    // Stage 1 (base, 100644) and stage 2 (ours, 100755) with no stage-0 entry: the conflict has no mode of its own.
    git(repo, ['update-index', '--index-info'], `100644 ${sha} 1\ttools/run.dat\n100755 ${sha} 2\ttools/run.dat\n`);
    // The export step is injected: git checkout-index does not export unmerged paths.
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {}, checkoutIndex: async () => {} });
    assert.equal(snapshot.profile, 'spec-docs', 'the conflict record at mode 100755 must not make the change executable');
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged name with a Unicode line separator, When materialized, Then the manifest carries it escaped on one line', async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    const sha = git(repo, ['hash-object', '-w', '--stdin'], 'export const a = 1;\n').toString('utf8').trim();
    const name = `greet${String.fromCodePoint(0x2028)}forged.mjs`;
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`]);
    // The export step is injected: the line separator is legal in an index path on every platform.
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {}, checkoutIndex: async () => {} });
    assert.deepEqual(snapshot.changedPaths, [name], 'the review sees the real name');
    assert.equal(
      await readFile(path.join(snapshot.dir, '.review', 'changed-files.txt'), 'utf8'),
      'greet\\u2028forged.mjs\n',
      'the manifest carries the escaped name',
    );
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged name with a newline, When materialized, Then the manifest keeps one line per path and escapes the newline', { skip: process.platform === 'win32' ? 'Git for Windows refuses control characters in index paths' : false }, async () => {
  const repo = await newRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'snapshot-test-parent-'));
  try {
    const sha = git(repo, ['hash-object', '-w', '--stdin'], 'export const a = 1;\n').toString('utf8').trim();
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${sha},greet\nforged.mjs`]);
    // The export step is injected: a file name with a newline cannot be written on Windows.
    const snapshot = await materializeStagedSnapshot({ repo, parentDir: parent, env: {}, checkoutIndex: async () => {} });
    assert.deepEqual(snapshot.changedPaths, ['greet\nforged.mjs'], 'the review sees the real name');
    assert.equal(
      await readFile(path.join(snapshot.dir, '.review', 'changed-files.txt'), 'utf8'),
      'greet\\nforged.mjs\n',
      'the manifest carries the escaped name on one line',
    );
    await removeSnapshot(snapshot.dir);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
