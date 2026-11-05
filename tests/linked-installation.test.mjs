// Exercise a linked plugin through the installed Git hook and the Codex guard, without a model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { PluginInstallerService } from '../src/index.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function git(cwd, args, env) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env });
}

async function linkedRepo(t, overrides = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'linked-review-'));
  t.after(() => rm(base, REMOVE));
  const repo = path.join(base, 'repo');
  const linkedKit = path.join(base, 'plugin link');
  const emptyHooks = path.join(base, 'empty-hooks');
  const env = {
    ...process.env,
    OMP_REVIEW_KIT_PLUGIN_DIR: linkedKit,
    OMP_REVIEW_KIT_REPORTS_DIR: path.join(base, 'reports'),
    OMP_REVIEW_KIT_RUNS_DIR: path.join(base, 'runs'),
    ...overrides,
  };
  await mkdir(repo);
  await mkdir(emptyHooks);
  await symlink(kitRoot, linkedKit, linkType);
  assert.equal(git(repo, ['init', '-q'], env).status, 0);
  assert.equal(git(repo, ['config', 'user.name', 'E2E'], env).status, 0);
  assert.equal(git(repo, ['config', 'user.email', 'e2e@test.local'], env).status, 0);
  await writeFile(path.join(repo, 'README.md'), '# seed\n');
  assert.equal(git(repo, ['add', 'README.md'], env).status, 0);
  assert.equal(git(repo, ['-c', `core.hooksPath=${emptyHooks}`, 'commit', '-q', '-m', 'seed'], env).status, 0);
  const setup = await new PluginInstallerService().setup(repo);
  assert.equal(setup.success, true, JSON.stringify(setup));
  return { base, repo, linkedKit, env };
}

test('Given the plugin is linked and Bun cannot start, When git commits, Then the hook blocks the commit', async t => {
  const fx = await linkedRepo(t);
  fx.env.OMP_REVIEW_KIT_BUN = path.join(fx.base, 'missing-bun');
  const headBefore = git(fx.repo, ['rev-parse', 'HEAD'], fx.env).stdout.trim();
  await writeFile(path.join(fx.repo, 'feature.mjs'), 'export const value = 1;\n');
  assert.equal(git(fx.repo, ['add', 'feature.mjs'], fx.env).status, 0);
  const commit = git(fx.repo, ['commit', '-q', '-m', 'add feature'], fx.env);
  assert.notEqual(commit.status, 0, `${commit.stdout}${commit.stderr}`);
  assert.match(`${commit.stdout}${commit.stderr}`, /^review: BLOCK \(bun is required/m);
  assert.equal(git(fx.repo, ['rev-parse', 'HEAD'], fx.env).stdout.trim(), headBefore);
});

test('Given the plugin is linked and nothing is staged, When git runs the hook, Then the real review host skips the empty change', async t => {
  const fx = await linkedRepo(t);
  const run = git(fx.repo, ['hook', 'run', '--ignore-missing', 'pre-commit'], fx.env);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /^review: SKIPPED \(no staged changes\)$/m);
});

test('Given the plugin is linked and a staged change exceeds the review limit, When git commits, Then the real review host blocks the commit', async t => {
  const fx = await linkedRepo(t, { OMP_REVIEW_KIT_MAX_DIFF: '1' });
  const headBefore = git(fx.repo, ['rev-parse', 'HEAD'], fx.env).stdout.trim();
  await writeFile(path.join(fx.repo, 'first.mjs'), 'export const first = 1;\n');
  await writeFile(path.join(fx.repo, 'second.mjs'), 'export const second = 2;\n');
  assert.equal(git(fx.repo, ['add', 'first.mjs', 'second.mjs'], fx.env).status, 0);
  const commit = git(fx.repo, ['commit', '-q', '-m', 'add files'], fx.env);
  assert.notEqual(commit.status, 0, `${commit.stdout}${commit.stderr}`);
  assert.match(`${commit.stdout}${commit.stderr}`, /review: diff too large \(2 paths,/);
  assert.equal(git(fx.repo, ['rev-parse', 'HEAD'], fx.env).stdout.trim(), headBefore);
});

test('Given the plugin is linked and Bun cannot start, When the Codex guard sees a commit, Then it denies the command', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'guard-linked-'));
  t.after(() => rm(base, REMOVE));
  const linkedKit = path.join(base, 'plugin link');
  await symlink(kitRoot, linkedKit, linkType);
  const result = spawnSync(process.execPath, [path.join(linkedKit, 'scripts', 'hook-guard.mjs'), '--codex'], {
    encoding: 'utf8',
    windowsHide: true,
    input: JSON.stringify({ tool_input: { command: 'git commit -m x' } }),
    env: { ...process.env, OMP_REVIEW_KIT_ROOT: linkedKit, OMP_REVIEW_KIT_BUN: path.join(base, 'missing-bun') },
  });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /review: BLOCK \(bun is required/);
});
