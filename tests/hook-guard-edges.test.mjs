import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { session } from '../claude-plugin/scripts/bridge.mjs';
import { PluginInstallerService } from '../src/application/installer-service.mjs';
import { HOOK_SHIM, HOOK_SHIM_FORMAT } from '../src/domain/hook-shim.mjs';
import initExtension from '../src/extension.mjs';
import { workspace } from './target-workspace.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

let current;
let savedTargets;
afterEach(async () => {
  if (savedTargets === undefined) delete process.env.OMP_REVIEW_KIT_TARGETS;
  else process.env.OMP_REVIEW_KIT_TARGETS = savedTargets;
  await current?.cleanup();
  current = undefined;
});
// Components that build their own installer (the extension, the Claude shell) must not read the developer's registry.
const open = async () => {
  savedTargets = process.env.OMP_REVIEW_KIT_TARGETS;
  current = await workspace();
  process.env.OMP_REVIEW_KIT_TARGETS = path.join(current.base, 'default-targets.json');
  return current;
};
const useHusky = async (repo) => {
  await mkdir(path.join(repo, '.husky'), { recursive: true });
  git(repo, 'config', 'core.hooksPath', '.husky');
};

describe('Feature: edges of the shim, the assessment and the reports', () => {
  it('Given a hooks directory that is a link elsewhere, Then no shim is stored through it', async () => {
    const { base, installer, makeRepo } = await open();
    const repo = await makeRepo('linked-hooks');
    const shared = path.join(base, 'shared-hooks');
    await mkdir(shared, { recursive: true });
    await rm(path.join(repo, '.git', 'hooks'), { recursive: true, force: true });
    try {
      await symlink(shared, path.join(repo, '.git', 'hooks'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // links are not available in this environment
    }
    assert.equal((await installer.setup(repo)).success, true);
    await assert.rejects(readFile(path.join(shared, 'pre-commit'), 'utf8'), { code: 'ENOENT' });
  });

  it('Given an active repository whose shim went missing or is of a newer format, Then setup restores the first and keeps the second', async () => {
    const { installer, makeRepo } = await open();
    const repo = await makeRepo('shim-lifecycle');
    const shim = path.join(repo, '.git', 'hooks', 'pre-commit');
    await rm(shim);
    assert.equal((await installer.setup(repo)).state, 'active');
    assert.equal(await readFile(shim, 'utf8').catch(() => null), HOOK_SHIM);

    const newer = HOOK_SHIM.replace(`hook-shim v${HOOK_SHIM_FORMAT} `, `hook-shim v${HOOK_SHIM_FORMAT + 1} `);
    await writeFile(shim, newer, { mode: 0o755 });
    await installer.setup(repo);
    assert.equal(await readFile(shim, 'utf8').catch(() => null), newer);
  });

  it('Given a hooks path that is not a directory, Then setup still succeeds without a shim', async () => {
    const { installer, makeRepo } = await open();
    const repo = await makeRepo('file-hooks');
    await rm(path.join(repo, '.git', 'hooks'), { recursive: true, force: true });
    await writeFile(path.join(repo, '.git', 'hooks'), 'not a directory');
    assert.equal((await installer.setup(repo)).success, true);
  });

  it('Given a foreign hook that chains into pre-commit.d, Then the chain is effective with its entry and not without it', async () => {
    const { base, installer } = await open();
    const repo = path.join(base, 'chained');
    await mkdir(path.join(repo, '.githooks'), { recursive: true });
    git(repo, 'init', '-q');
    const foreign = '#!/bin/sh\nset -eu\nhook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n"$hook_dir/pre-commit.d/00-omp-reviewer-kit.chain"\n';
    await writeFile(path.join(repo, '.githooks', 'pre-commit'), foreign, { mode: 0o755 });
    assert.equal((await installer.setup(repo)).success, true);
    const chained = await installer.assessHook(repo);
    assert.deepEqual([chained.kitExpected, chained.kind, chained.effective], [true, 'chained', true]);
    await rm(path.join(repo, '.githooks', 'pre-commit.d'), { recursive: true, force: true });
    const broken = await installer.assessHook(repo);
    assert.deepEqual([broken.kind, broken.effective], ['foreign', false]);
  });

  it('Given a directory outside Git or a git failure, Then there is no assessment and the guard allows', async () => {
    const { base, installer } = await open();
    assert.equal(await installer.assessHook(base), null);
    class Broken extends PluginInstallerService {
      runGit() { throw new Error('git is gone'); }
    }
    assert.deepEqual(await new Broken().guardCommit(base), { action: 'allow' });
  });

  it('Given the status command, Then it names the hook git runs, and says so when it is not the review', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('status-line');
    const commands = new Map();
    initExtension({ registerCommand: (name, options) => commands.set(name, options), on() {}, logger: {} });
    const say = async () => {
      const notices = [];
      await commands.get('reviewer-kit:status').handler('', { cwd: repo, ui: { notify: (msg) => notices.push(msg) } });
      return notices.join('\n');
    };
    assert.match(await say(), /Effective Hook: OK \(git runs .*pre-commit, kit\)/);
    await useHusky(repo);
    assert.match(await say(), /Effective Hook: NOT REVIEWED \(git runs .*pre-commit: missing\)/);
  });

  it('Given a session in a repository that would commit unreviewed, Then the Claude shell tells the agent', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('claude-session');
    await useHusky(repo);
    const exec = () => ({ status: 0, stdout: 'omp 18.10.4', stderr: '' });
    const env = { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: path.resolve('.') };
    const out = [];
    await session({ cwd: repo, env, exec, out: (line) => out.push(line) });
    assert.match(JSON.parse(out[0]).hookSpecificOutput.additionalContext, /Commits here are NOT reviewed/);
  });

  it('Given sync-targets on the command line, Then a repository that would commit unreviewed is listed and fails the run', async () => {
    const { makeRepo, base } = await open();
    const repo = await makeRepo('cli-sync');
    await useHusky(repo);
    const run = spawnSync(process.execPath, [path.resolve('scripts', 'sync-targets.mjs'), repo], { encoding: 'utf8', windowsHide: true, cwd: base });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /NOT-REVIEWED\(git runs a missing pre-commit, core\.hooksPath \.husky/);
  });
});

describe('Feature: the Claude Code plugin registers the commit guard', () => {
  it('Given hooks.json, Then Bash commands go through the guard and sessions through the session hook', async () => {
    const hooks = JSON.parse(await readFile(path.resolve('claude-plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
    const pre = hooks.PreToolUse;
    assert.equal(pre.length, 1);
    assert.equal(pre[0].matcher, 'Bash');
    assert.match(pre[0].hooks[0].command, /bridge\.mjs" guard$/);
    assert.match(hooks.SessionStart[0].hooks[0].command, /bridge\.mjs" session$/);
  });
});
