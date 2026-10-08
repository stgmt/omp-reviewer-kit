import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const STUB = path.resolve('templates/review-kit/run-review.mjs');

// Stands in for the installed algorithm: it reports the arguments it received and exits with the given code.
async function fakePlugin(exitCode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-stub-plugin-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), [
    'process.stdout.write(`argv:${process.argv.slice(2).join(\',\')}\\n`);',
    `process.exitCode = ${exitCode};`,
  ].join('\n'));
  return dir;
}

// Stands in for an algorithm that the operating system ends with a signal: the child has no exit status.
async function killedPlugin() {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-stub-killed-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), "process.kill(process.pid, 'SIGKILL');\n");
  return dir;
}

// Stands in for an operating system that refuses to start the algorithm (E2BIG, EAGAIN, ...): the spawn reports an error and no status.
// Loaded with --require, it replaces spawnSync in the stub's own process, so the refusal happens the same way on every platform.
async function refusedSpawnPreload() {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-stub-refused-'));
  await writeFile(path.join(dir, 'refuse-spawn.cjs'), [
    "const childProcess = require('node:child_process');",
    "childProcess.spawnSync = () => ({ error: Object.assign(new Error('spawnSync node E2BIG'), { code: 'E2BIG' }), status: null, signal: null, output: null, pid: 0, stdout: null, stderr: null });",
    "require('node:module').syncBuiltinESMExports();",
  ].join('\n'));
  return dir;
}

describe('Feature: the vendored runner stub hands every review to the installed plugin', () => {
  let home;

  before(async () => {
    // An empty home folder: a stub that ignores OMP_REVIEW_KIT_PLUGIN_DIR must not find a real installed plugin here.
    home = await mkdtemp(path.join(tmpdir(), 'omp-stub-home-'));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const runStub = (env, args = [], execArgv = []) => spawnSync(process.execPath, [...execArgv, STUB, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });

  it('Given an installed plugin, When the stub runs, Then it passes the arguments on and forwards the exit code', async () => {
    const plugin = await fakePlugin(7);
    try {
      const result = runStub({ OMP_REVIEW_KIT_PLUGIN_DIR: plugin }, ['--flag', 'x']);
      assert.equal(result.status, 7, result.stderr);
      assert.match(result.stdout, /argv:--flag,x/);
    } finally {
      await rm(plugin, { recursive: true, force: true });
    }
  });

  it('Given an installed plugin that passes, When the stub runs, Then the exit code 0 reaches git', async () => {
    const plugin = await fakePlugin(0);
    try {
      assert.equal(runStub({ OMP_REVIEW_KIT_PLUGIN_DIR: plugin }).status, 0);
    } finally {
      await rm(plugin, { recursive: true, force: true });
    }
  });

  it('Given no plugin in the configured directory, When the stub runs, Then it fails closed with INFRA_ERROR', () => {
    const result = runStub({ OMP_REVIEW_KIT_PLUGIN_DIR: path.join(home, 'absent') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reviewer-kit INFRA_ERROR: no omp-reviewer-kit plugin at /);
  });

  it('Given the algorithm is ended by a signal, When the stub runs, Then the review fails and never passes', { skip: process.platform === 'win32' ? 'a signal cannot end a child on win32' : false }, async () => {
    const plugin = await killedPlugin();
    try {
      const result = runStub({ OMP_REVIEW_KIT_PLUGIN_DIR: plugin });
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /REVIEW_RESULT=PASS/);
    } finally {
      await rm(plugin, { recursive: true, force: true });
    }
  });

  it('Given the operating system refuses to start the algorithm, When the stub runs, Then it reports INFRA_ERROR and fails closed', async () => {
    const plugin = await fakePlugin(0);
    const refusal = await refusedSpawnPreload();
    try {
      const result = runStub({ OMP_REVIEW_KIT_PLUGIN_DIR: plugin }, [], ['--require', path.join(refusal, 'refuse-spawn.cjs')]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /reviewer-kit INFRA_ERROR: spawnSync node E2BIG/);
      assert.doesNotMatch(result.stdout, /REVIEW_RESULT=PASS/);
    } finally {
      await rm(plugin, { recursive: true, force: true });
      await rm(refusal, { recursive: true, force: true });
    }
  });

  it('Given no plugin at all, When the stub runs, Then it fails closed as well', () => {
    const result = runStub({ OMP_REVIEW_KIT_PLUGIN_DIR: undefined });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INFRA_ERROR/);
  });
});
