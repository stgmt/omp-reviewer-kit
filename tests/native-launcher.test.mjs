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

async function copyLauncher(root) {
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'src', 'infra'), { recursive: true });
  await copyFile(launcher, path.join(root, 'scripts', 'run-review.mjs'));
  await copyFile(path.join(kitRoot, 'src', 'infra', 'main-module.mjs'), path.join(root, 'src', 'infra', 'main-module.mjs'));
  await copyFile(path.join(kitRoot, 'src', 'infra', 'ensure-review-runtime.mjs'), path.join(root, 'src', 'infra', 'ensure-review-runtime.mjs'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@oh-my-pi/pi-coding-agent': '18.12.5' } }));
}

test('Given Bun cannot be started, When the launcher runs, Then it blocks with the Bun diagnostic and no review', () => {
  const result = spawnSync(process.execPath, [launcher], {
    cwd: kitRoot,
    encoding: 'utf8',
    env: { ...process.env, OMP_REVIEW_KIT_BUN: path.join(kitRoot, 'no-such-bun-binary') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review: BLOCK \(bun is required for the native review/);
});

test('Given the OMP library is missing and its runtime cannot be prepared, When the launcher runs, Then it blocks the review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-test-'));
  try {
    await copyLauncher(root);
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-review.mjs')], {
      cwd: repo,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the OMP library \(@oh-my-pi\/pi-coding-agent\) is not installed/);
    assert.match(result.stderr, /runtime could not be prepared/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A copy of the launcher with the OMP library marker present. Node stands in for Bun: the probe
// (`node --version`) passes, and the host is whatever file the test writes at src/native.
async function launcherRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-test-'));
  await copyLauncher(root);
  await mkdir(path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json'), JSON.stringify({ name: '@oh-my-pi/pi-coding-agent', version: '18.12.5' }));
  return root;
}

test('Given Bun is outside PATH in the standard Windows location, the launcher runs the review host and respects an explicit override', { skip: process.platform !== 'win32' }, async t => {
  const root = await launcherRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const bin = path.join(root, '.bun', 'bin');
  await mkdir(bin, { recursive: true });
  await copyFile(process.execPath, path.join(bin, 'bun.exe'));
  await mkdir(path.join(root, 'src', 'native'), { recursive: true });
  await writeFile(path.join(root, 'src', 'native', 'native-host.mjs'), "console.error('review host reached'); process.exit(7);\n");
  const env = { ...process.env, USERPROFILE: root };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.Path = path.join(process.env.SystemRoot, 'System32');
  delete env.OMP_REVIEW_KIT_BUN;
  const args = [path.join(root, 'scripts', 'run-review.mjs'), root];
  const found = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env, windowsHide: true });
  assert.equal(found.status, 7, found.stderr);
  assert.match(found.stderr, /review host reached/);
  const overridden = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', env: { ...env, OMP_REVIEW_KIT_BUN: path.join(root, 'missing-bun.exe') }, windowsHide: true,
  });
  assert.equal(overridden.status, 1);
  assert.match(overridden.stderr, /review: BLOCK \(bun is required/);
  assert.doesNotMatch(overridden.stderr, /review host reached/);
});

test('Given an installed library with the wrong identity or version, When the locked runtime cannot be prepared, Then the review blocks', async t => {
  const root = await launcherRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const initialized = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  const library = path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json');
  for (const installed of [
    { name: '@oh-my-pi/pi-coding-agent', version: '0.0.0' },
    { name: 'not-the-omp-library', version: '18.12.5' },
  ]) {
    await writeFile(library, JSON.stringify(installed));
    const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-review.mjs'), repo], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, HOME: root, USERPROFILE: root, OMP_REVIEW_KIT_BUN: process.execPath },
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /runtime could not be prepared/);
  }
});

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

test('Given the OMP library is hoisted above the kit folder, When the launcher looks for it, Then it accepts the resolvable install', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { findLibrary } = await import('../scripts/run-review.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'kit-hoisted-'));
  try {
    const kit = path.join(root, 'plugins', 'node_modules', 'omp-reviewer-kit');
    const hoisted = path.join(root, 'plugins', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json');
    await mkdir(path.dirname(hoisted), { recursive: true });
    await mkdir(kit, { recursive: true });
    await writeFile(hoisted, JSON.stringify({ name: '@oh-my-pi/pi-coding-agent', version: '18.12.5' }));
    const entry = path.join(path.dirname(hoisted), 'dist', 'sdk.mjs');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, 'export const sdk = 1;\n');
    await writeFile(path.join(kit, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.0.0', dependencies: { '@oh-my-pi/pi-coding-agent': '18.12.5' } }));
    // Only the walk can find this one: the resolver is deliberately broken here.
    const refuse = () => { const error = new Error('not resolvable'); error.code = 'ERR_MODULE_NOT_FOUND'; throw error; };
    assert.equal(findLibrary(kit, { resolveEntry: refuse }), hoisted, 'a hoisted install is found by walking up');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the launcher module is imported, When it loads, Then it starts nothing and prints no diagnostic', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/run-review.mjs', import.meta.url).href)})`], {
    encoding: 'utf8',
    env: { ...process.env, OMP_REVIEW_KIT_BUN: 'definitely-not-a-binary' },
    windowsHide: true,
  });
  assert.equal(child.status, 0, 'an import is not a review');
  assert.equal(String(child.stderr ?? ''), '', 'no launcher diagnostic on import');
  assert.equal(String(child.stdout ?? ''), '', 'no host output on import');
  void fileURLToPath;
});

test('Given the package exports no package.json, When the launcher resolves a hoisted install, Then it finds the manifest by walking up from an exported entry', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const { tmpdir } = await import('node:os');
  const { findLibrary } = await import('../scripts/run-review.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'kit-hoisted-entry-'));
  try {
    const pkgDir = path.join(root, 'plugins', 'node_modules', '@oh-my-pi', 'pi-coding-agent');
    const entry = path.join(pkgDir, 'dist', 'sdk.mjs');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, 'export const sdk = 1;\n');
    await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@oh-my-pi/pi-coding-agent', version: '18.12.5' }));
    const kit = path.join(root, 'plugins', 'node_modules', 'omp-reviewer-kit');
    await mkdir(kit, { recursive: true });
    await writeFile(path.join(kit, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.0.0', dependencies: { '@oh-my-pi/pi-coding-agent': '18.12.5' } }));
    // The real resolver refuses `…/package.json`; the exported entry resolves.
    const resolve = specifier => {
      if (specifier.endsWith('/package.json')) {
        const error = new Error('not exported');
        error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
        throw error;
      }
      return entry;
    };
    assert.equal(findLibrary(kit, { resolveEntry: () => `file:///${entry.replace(/\\/g, '/')}` }), path.join(pkgDir, 'package.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
