// Given/When/Then over the Node launcher. It runs the real launcher as a child process: the
// launcher itself is the unit under test, and its diagnostics are the observable behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(kitRoot, 'scripts', 'run-review.mjs');

test('Given Bun cannot be started, When the launcher runs, Then it blocks with the Bun diagnostic and no review', () => {
  const result = spawnSync(process.execPath, [launcher], {
    cwd: kitRoot,
    encoding: 'utf8',
    env: { ...process.env, OMP_REVIEW_KIT_BUN: path.join(kitRoot, 'no-such-bun-binary') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review: BLOCK \(bun is required for the native review/);
});

test('Given the OMP library is not installed beside the launcher, When the launcher runs, Then it blocks naming the install command', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-test-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await copyFile(launcher, path.join(root, 'scripts', 'run-review.mjs'));
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-review.mjs')], {
      cwd: repo,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the OMP library is not installed/);
    assert.match(result.stderr, /bun install/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A copy of the launcher with the OMP library marker present. Node stands in for Bun: the probe
// (`node --version`) passes, and the host is whatever file the test writes at src/native.
async function launcherRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-test-'));
  await mkdir(path.join(root, 'scripts'));
  await copyFile(launcher, path.join(root, 'scripts', 'run-review.mjs'));
  await mkdir(path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json'), '{}\n');
  return root;
}

test('Given the repository directory does not exist, When the launcher runs, Then it blocks naming the host that could not start', async () => {
  const root = await launcherRoot();
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-review.mjs'), path.join(root, 'missing-repo')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, OMP_REVIEW_KIT_BUN: process.execPath },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /review: BLOCK \(cannot start the native review host: /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the review host is ended by a signal, When the launcher runs, Then the review fails with exit 1 and never passes', { skip: process.platform === 'win32' ? 'POSIX signals only' : false }, async () => {
  const root = await launcherRoot();
  try {
    await mkdir(path.join(root, 'src', 'native'), { recursive: true });
    await writeFile(path.join(root, 'src', 'native', 'native-host.mjs'), "process.kill(process.pid, 'SIGTERM');\n");
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-review.mjs'), repo], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, OMP_REVIEW_KIT_BUN: process.execPath },
    });
    assert.equal(result.status, 1, 'a host that ends without a status is a failed review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
