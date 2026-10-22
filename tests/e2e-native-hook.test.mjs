// Given/When/Then over the real pre-commit hook. Every repository here is a real Git repository,
// the hook is the one `setup` installs, and git itself runs it. Nothing is mocked: the offline
// cases need no model; the live case (OMP_REVIEW_KIT_LIVE_E2E=1) runs the native review on the
// owner's OMP configuration and spends a few cents of model time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { PluginInstallerService } from '../src/index.mjs';
import { main as runNativeHost } from '../src/native/native-host.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isLive = process.env.OMP_REVIEW_KIT_LIVE_E2E === '1';

function git(cwd, args, env = process.env) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env });
}

async function hookRepo(env = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'omp-e2e-hook-'));
  const repo = path.join(base, 'repo');
  const reports = path.join(base, 'reports');
  const runs = path.join(base, 'runs');
  const envWith = { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: kitRoot, OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs, ...env };
  await mkdir(repo, { recursive: true });
  assert.equal(git(repo, ['init', '-q']).status, 0);
  git(repo, ['config', 'user.name', 'E2E']);
  git(repo, ['config', 'user.email', 'e2e@test.local']);
  await writeFile(path.join(repo, 'README.md'), '# seed\n');
  assert.equal(git(repo, ['add', 'README.md']).status, 0);
  assert.equal(git(repo, ['commit', '-q', '--no-verify', '-m', 'seed']).status, 0);
  const setup = await new PluginInstallerService().setup(repo);
  assert.equal(setup.success, true, JSON.stringify(setup));
  return { base, repo, reports, envWith, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('Given the hook is installed and nothing is staged, When git runs the hook, Then the review is skipped and the hook exits 0', async () => {
  const fx = await hookRepo();
  try {
    const run = git(fx.repo, ['hook', 'run', '--ignore-missing', 'pre-commit'], fx.envWith);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /^review: SKIPPED \(no staged changes\)$/m);
  } finally {
    await fx.cleanup();
  }
});

test('Given the directory is not a Git repository, When the native host runs, Then it blocks with exit 1 and names the host error', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'omp-e2e-host-error-'));
  const stderr = [];
  try {
    const code = await runNativeHost([base], {
      stderr: { write: text => stderr.push(text) },
      stdout: { write: () => {} },
    });
    assert.equal(code, 1, stderr.join(''));
    assert.match(stderr.join(''), /^review: BLOCK \(host error: /m);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Given the hook is installed and Bun cannot start, When a real git commit stages a change, Then git refuses the commit with a BLOCK and HEAD does not move', async () => {
  const fx = await hookRepo({ OMP_REVIEW_KIT_BUN: path.join(tmpdir(), 'omp-e2e-no-such-bun', 'bun') });
  try {
    const headBefore = git(fx.repo, ['rev-parse', 'HEAD']).stdout.trim();
    await writeFile(path.join(fx.repo, 'feature.mjs'), 'export const value = 1;\n');
    assert.equal(git(fx.repo, ['add', 'feature.mjs']).status, 0);
    const commit = git(fx.repo, ['commit', '-q', '-m', 'add feature'], fx.envWith);
    assert.notEqual(commit.status, 0, `${commit.stdout}${commit.stderr}`);
    assert.match(`${commit.stdout}${commit.stderr}`, /^review: BLOCK \(bun is required/m);
    assert.equal(git(fx.repo, ['rev-parse', 'HEAD']).stdout.trim(), headBefore, 'a blocked review never creates a commit');
  } finally {
    await fx.cleanup();
  }
});

test('Given the live OMP configuration, When a real git commit stages a change, Then the review passes and the commit is created', { skip: isLive ? false : 'set OMP_REVIEW_KIT_LIVE_E2E=1 to run the native review on live OMP' }, async () => {
  const fx = await hookRepo();
  try {
    const headBefore = git(fx.repo, ['rev-parse', 'HEAD']).stdout.trim();
    await writeFile(path.join(fx.repo, 'greeting.mjs'), "export function greet(name) {\n  return `hello, ${name}`;\n}\n");
    assert.equal(git(fx.repo, ['add', 'greeting.mjs']).status, 0);
    const commit = git(fx.repo, ['commit', '-q', '-m', 'add greeting'], fx.envWith);
    assert.equal(commit.status, 0, `${commit.stdout}${commit.stderr}`);
    assert.match(`${commit.stdout}${commit.stderr}`, /^review: PASS$/m);
    assert.notEqual(git(fx.repo, ['rev-parse', 'HEAD']).stdout.trim(), headBefore, 'a PASS review lets the commit through');

    const reportDir = path.join(fx.reports, (await readdir(fx.reports))[0]);
    const [report] = (await readdir(reportDir)).filter((name) => name.endsWith('.md'));
    assert.ok(report, 'the review saves its report');
    assert.match(await readFile(path.join(reportDir, report), 'utf8'), /^# reviewer-kit review: PASS$/m);
  } finally {
    await fx.cleanup();
  }
});
