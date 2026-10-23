import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { guard } from '../claude-plugin/scripts/bridge.mjs';
import { parseConfigOrigin, PluginInstallerService } from '../src/application/installer-service.mjs';
import { isGitCommitCommand } from '../src/domain/git-commit-command.mjs';
import { HOOK_SHIM, HOOK_SHIM_FORMAT, isOwnedShim, isShimNewer, parseShimMarker } from '../src/domain/hook-shim.mjs';
import initExtension from '../src/extension.mjs';
import { syncTarget } from '../scripts/sync-targets.mjs';
import { workspace } from './target-workspace.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
const hooksPathOf = (cwd) => git(cwd, 'config', '--get', 'core.hooksPath').stdout.trim();
const FOREIGN_HOOK = '#!/bin/sh\necho "another tool"\nexit 0\n';

let current;
afterEach(async () => {
  delete process.env.OMP_REVIEW_KIT_GUARD;
  delete process.env.OMP_REVIEW_KIT_AUTO_SYNC;
  await current?.cleanup();
  current = undefined;
});
const open = async () => (current = await workspace());

describe('Feature: the hook shim in git\'s default hooks directory', () => {
  it('Given the shim, Then it is owned, versioned by its format and any edit makes it nobody\'s', () => {
    assert.equal(isOwnedShim(HOOK_SHIM), true);
    assert.equal(parseShimMarker(HOOK_SHIM).format, HOOK_SHIM_FORMAT);
    assert.equal(isOwnedShim(HOOK_SHIM.replace('exit 0', 'exit 1')), false);
    assert.equal(isOwnedShim(HOOK_SHIM.replace(/\n/g, '\r\n')), true);
    assert.equal(isOwnedShim('#!/bin/sh\nexit 0\n'), false);
  });

  it('Given an unedited shim of a newer format, Then it is newer; an older or edited one is not', () => {
    const newer = HOOK_SHIM.replace(`hook-shim v${HOOK_SHIM_FORMAT} `, `hook-shim v${HOOK_SHIM_FORMAT + 1} `);
    assert.equal(isOwnedShim(newer), true);
    assert.equal(isShimNewer(newer), true);
    assert.equal(isShimNewer(HOOK_SHIM), false);
    assert.equal(isShimNewer(newer.replace('exit 0', 'exit 2')), false);
  });

  it('Given git config --show-origin output, Then the file and the value are split, with or without an origin', () => {
    assert.deepEqual(parseConfigOrigin('file:C:/r/.git/config\t.githooks\n'), { file: 'C:/r/.git/config', value: '.githooks' });
    assert.deepEqual(parseConfigOrigin('file:"C:/my repo/.git/config.worktree"\tC:/x\n'), { file: 'C:/my repo/.git/config.worktree', value: 'C:/x' });
    assert.deepEqual(parseConfigOrigin('plain'), { file: null, value: 'plain' });
    assert.equal(parseConfigOrigin(''), null);
  });

  it('Given a repository that installs the kit, Then the shim is stored next to git\'s default hooks and reinstalling keeps it', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('shim-repo');
    const shim = path.join(repo, '.git', 'hooks', 'pre-commit');
    assert.equal(await readFile(shim, 'utf8'), HOOK_SHIM);
    assert.equal((await current.installer.setup(repo)).state, 'active');
    assert.equal(await readFile(shim, 'utf8'), HOOK_SHIM);
  });

  it('Given a foreign pre-commit in the default hooks directory, Then setup reports a conflict and leaves it alone', async () => {
    const { base } = await open();
    const repo = path.join(base, 'foreign-default');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), FOREIGN_HOOK, { mode: 0o755 });
    const result = await current.installer.setup(repo);
    assert.equal(result.state, 'conflict');
    assert.equal(await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8'), FOREIGN_HOOK);
  });

  it('Given an edited shim, Then it is treated as a foreign hook and kept', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('edited-shim');
    const shim = path.join(repo, '.git', 'hooks', 'pre-commit');
    const edited = HOOK_SHIM.replace('exit 0', 'exit 0 # edited');
    await writeFile(shim, edited, { mode: 0o755 });
    await current.installer.setup(repo);
    assert.equal(await readFile(shim, 'utf8'), edited);
  });

  it('Given an unedited shim of an older format, When setup runs, Then it is replaced by this release\'s', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('old-shim');
    const shim = path.join(repo, '.git', 'hooks', 'pre-commit');
    const older = HOOK_SHIM.replace(`hook-shim v${HOOK_SHIM_FORMAT} `, 'hook-shim v0 ');
    assert.equal(isOwnedShim(older), true);
    await writeFile(shim, older, { mode: 0o755 });
    await current.installer.setup(repo);
    assert.equal(await readFile(shim, 'utf8'), HOOK_SHIM);
  });

  it('Given the shim and core.hooksPath unset, Then the shim is not a conflict and setup restores .githooks', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('unset-path');
    git(repo, 'config', '--unset', 'core.hooksPath');
    assert.notEqual((await installer.status(repo)).state, 'conflict');
    assert.equal((await installer.setup(repo)).success, true);
    assert.equal(hooksPathOf(repo), '.githooks');
  });
});

describe('Feature: a stray core.hooksPath on git\'s default hooks directory is repaired', () => {
  it('Given the kit installed and core.hooksPath moved to .git/hooks, Then the repository is stale and setup puts .githooks back', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('stray');
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));

    const before = await installer.status(repo);
    assert.equal(before.state, 'stale');
    assert.equal(before.hooksPathRepairable, true);

    const result = await installer.setup(repo);
    assert.equal(result.success, true);
    assert.match(result.message, /Repaired core\.hooksPath/);
    assert.equal(hooksPathOf(repo), '.githooks');
    assert.equal((await installer.status(repo)).state, 'active');
  });

  it('Given the stray value, When registered repositories are healed, Then it is repaired without a session in that repository', async () => {
    const { makeRepo, installer, registry } = await open();
    const repo = await makeRepo('healed');
    await installer.registerTarget(repo);
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    const summary = await installer.healTargets();
    assert.deepEqual(summary.healed, [repo]);
    assert.equal(hooksPathOf(repo), '.githooks');
    assert.deepEqual(await registry.list(), [repo]);
  });

  it('Given the stray value and OMP_REVIEW_KIT_AUTO_SYNC=0, Then healing changes nothing', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('no-auto');
    await installer.registerTarget(repo);
    const stray = path.join(repo, '.git', 'hooks');
    git(repo, 'config', 'core.hooksPath', stray);
    process.env.OMP_REVIEW_KIT_AUTO_SYNC = '0';
    assert.deepEqual((await installer.healTargets()).healed, []);
    assert.equal(hooksPathOf(repo), stray);
  });

  it('Given real hooks in the directory the value names, Then it is a conflict and nothing is rewritten', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('has-hooks');
    const hooks = path.join(repo, '.git', 'hooks');
    await writeFile(path.join(hooks, 'commit-msg'), FOREIGN_HOOK, { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', hooks);
    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.equal(status.hooksPathRepairable, false);
    assert.equal((await installer.setup(repo)).state, 'conflict');
    assert.equal(hooksPathOf(repo), hooks);
  });

  it('Given the kit hook next to the repository\'s own pre-push, Then the stray value is repaired; without the kit hook the other hooks still block activation', async () => {
    const { makeRepo, installer, base } = await open();
    const repo = await makeRepo('with-pre-push');
    await writeFile(path.join(repo, '.githooks', 'pre-push'), FOREIGN_HOOK, { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    const status = await installer.status(repo);
    assert.equal(status.state, 'stale');
    assert.equal(status.conflictReason, null);
    assert.match((await installer.setup(repo)).message, /Repaired core\.hooksPath/);

    const bare = path.join(base, 'pre-push-only');
    await mkdir(path.join(bare, '.githooks'), { recursive: true });
    git(bare, 'init', '-q');
    await writeFile(path.join(bare, '.githooks', 'pre-push'), FOREIGN_HOOK, { mode: 0o755 });
    git(bare, 'config', 'core.hooksPath', path.join(bare, '.git', 'hooks'));
    const refused = await installer.status(bare);
    assert.equal(refused.state, 'conflict');
    assert.match(refused.conflictReason, /pre-push/);
  });

  it('Given another tool\'s hooks directory (.husky), Then it is a conflict, never repaired', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('husky');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    assert.equal((await installer.status(repo)).state, 'conflict');
    assert.equal((await installer.setup(repo)).success, false);
    assert.equal(hooksPathOf(repo), '.husky');
  });

  it('Given a worktree whose own config.worktree holds the stray value, Then it is replaced where it lives', async () => {
    const { makeRepo, installer, base } = await open();
    const repo = await makeRepo('wt-main');
    git(repo, 'config', 'user.name', 'T');
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A', '--', 'a.txt');
    assert.equal(git(repo, 'commit', '-q', '--no-verify', '-m', 'init').status, 0);
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    const worktree = path.join(base, 'wt-feature');
    assert.equal(git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree).status, 0);
    // the worktree checkout carries the committed hook pair, like a real consumer branch
    await installer.setup(worktree);
    git(worktree, 'config', '--worktree', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    assert.equal((await installer.status(worktree)).hooksPathRepairable, true);
    const result = await installer.setup(worktree);
    assert.match(result.message, /Repaired core\.hooksPath/);
    assert.equal(git(worktree, 'config', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
    assert.equal(git(worktree, 'config', '--worktree', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
  });
});

describe('Feature: the commit-time guard', () => {
  it('Given the review hook is what git runs, Then the commit is allowed untouched', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('healthy');
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
  });

  it('Given a stray core.hooksPath and no shim, When a commit starts, Then the guard repairs the checkout and allows it', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('guard-repair');
    await rm(path.join(repo, '.git', 'hooks', 'pre-commit'), { force: true });
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    assert.equal((await installer.assessHook(repo)).effective, false);

    const result = await installer.guardCommit(repo);
    assert.equal(result.action, 'allow');
    assert.equal(result.repaired, true);
    assert.match(result.message, /repaired this checkout/);
    assert.equal(hooksPathOf(repo), '.githooks');
    assert.equal((await installer.assessHook(repo)).effective, true);
  });

  it('Given a stray core.hooksPath but the shim in place, Then git still reaches the review hook and the guard allows without a rewrite', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('shim-covers');
    const stray = path.join(repo, '.git', 'hooks');
    git(repo, 'config', 'core.hooksPath', stray);
    const assessment = await installer.assessHook(repo);
    assert.equal(assessment.kind, 'shim');
    assert.equal(assessment.effective, true);
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
    assert.equal(hooksPathOf(repo), stray);
  });

  it('Given another tool\'s hook is what git runs, When a commit starts, Then the guard refuses it and names the fix', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('guard-block');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    await writeFile(path.join(repo, '.husky', 'pre-commit'), FOREIGN_HOOK, { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', '.husky');

    const result = await installer.guardCommit(repo);
    assert.equal(result.action, 'block');
    assert.match(result.message, /would not be reviewed/);
    assert.match(result.message, /config core\.hooksPath \.githooks/);
    assert.match(result.message, /OMP_REVIEW_KIT_GUARD=0/);
    assert.equal(hooksPathOf(repo), '.husky');
  });

  it('Given a hook that is missing or not executable, Then the guard refuses and says why', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('guard-missing');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    const result = await installer.guardCommit(repo);
    assert.equal(result.action, 'block');
    assert.match(result.message, /does not exist/);
    if (process.platform !== 'win32') {
      await writeFile(path.join(repo, '.husky', 'pre-commit'), FOREIGN_HOOK, { mode: 0o644 });
      await chmod(path.join(repo, '.husky', 'pre-commit'), 0o644);
      assert.match((await installer.guardCommit(repo)).message, /not executable/);
    }
  });

  it('Given a repository that never adopted the kit, Then nothing is guarded', async () => {
    const { base, installer } = await open();
    const repo = path.join(base, 'plain');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
    assert.deepEqual(await installer.guardCommit(base), { action: 'allow' });
  });

  it('Given a checkout the kit never writes to, Then it is not guarded even when git runs another hook', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('tp-worker');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
    assert.equal((await installer.assessHook(repo)).kitExpected, false);
    assert.equal(hooksPathOf(repo), '.husky');
  });

  it("Given a repository whose own .githooks/pre-commit is another tool's, Then the kit is not expected and the guard stays out", async () => {
    const { base, installer } = await open();
    const repo = path.join(base, 'own-hook');
    await mkdir(path.join(repo, '.githooks'), { recursive: true });
    git(repo, 'init', '-q');
    await writeFile(path.join(repo, '.githooks', 'pre-commit'), FOREIGN_HOOK, { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', '.githooks');
    assert.equal((await installer.assessHook(repo)).kitExpected, false);
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
    assert.equal(await readFile(path.join(repo, '.githooks', 'pre-commit'), 'utf8'), FOREIGN_HOOK);
  });

  it('Given OMP_REVIEW_KIT_GUARD=0 or OMP_REVIEW_KIT_AUTO_SYNC=0, Then the guard stands aside or only reports', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('guard-switches');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    process.env.OMP_REVIEW_KIT_GUARD = '0';
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
    delete process.env.OMP_REVIEW_KIT_GUARD;
    process.env.OMP_REVIEW_KIT_AUTO_SYNC = '0';
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    await rm(path.join(repo, '.git', 'hooks', 'pre-commit'), { force: true });
    const result = await installer.guardCommit(repo);
    assert.equal(result.action, 'block');
    assert.equal(hooksPathOf(repo), path.join(repo, '.git', 'hooks'));
  });
});

describe('Feature: a worktree whose shared core.hooksPath was overwritten still runs the review', () => {
  it('Given Agent Teams style: the worktree creation writes .git/hooks into the shared config, When a commit is made, Then the review hook runs through the shim', async () => {
    const { makeRepo, base } = await open();
    const repo = await makeRepo('teams-main');
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '--', 'a.txt');
    assert.equal(git(repo, 'commit', '-q', '--no-verify', '-m', 'init').status, 0);
    // the consumer repository tracks the hook pair, so a worktree checkout has it too
    git(repo, 'add', '-f', '--', '.githooks/pre-commit', '.omp/review-kit/run-review.mjs');
    assert.equal(git(repo, 'commit', '-q', '--no-verify', '-m', 'track kit').status, 0);
    const worktree = path.join(base, 'teams-wt');
    assert.equal(git(repo, 'worktree', 'add', '-q', '-b', 'team', worktree).status, 0);
    git(worktree, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    assert.equal(hooksPathOf(repo), path.join(repo, '.git', 'hooks'));

    // Stand-in for the review: records that it ran in this checkout and blocks the commit.
    const marker = path.join(base, 'review-ran.txt');
    await writeFile(path.join(worktree, '.omp', 'review-kit', 'run-review.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, process.cwd());\nprocess.exit(1);\n`);
    await writeFile(path.join(worktree, 'b.txt'), 'b\n');
    git(worktree, 'add', '--', 'b.txt');

    const commit = git(worktree, 'commit', '-m', 'work');
    assert.notEqual(commit.status, 0, 'the stand-in review blocks the commit');
    assert.equal(realpathSync.native(await readFile(marker, 'utf8')).toLowerCase(), realpathSync.native(worktree).toLowerCase());
  });
});

describe('Feature: doctor and sync report the hook git really runs', () => {
  it('Given a healthy repository, Then the doctor shows the effective hook as OK', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('doctor-ok');
    const check = (await installer.doctor(repo)).checks.find((c) => c.name === 'Effective pre-commit hook');
    assert.equal(check.status, 'OK');
    assert.match(check.message, /\(kit\)/);
  });

  it('Given git runs another tool\'s hook, Then the doctor fails and the registry check names the repository', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('doctor-bad');
    await installer.registerTarget(repo);
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    await writeFile(path.join(repo, '.husky', 'pre-commit'), FOREIGN_HOOK, { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', '.husky');
    const report = await installer.doctor(repo);
    const check = report.checks.find((c) => c.name === 'Effective pre-commit hook');
    assert.equal(check.status, 'FAIL');
    assert.match(check.message, /NOT reviewed/);
    assert.equal(report.ok, false);
    const registered = report.checks.find((c) => c.name === 'Registered repositories');
    assert.equal(registered.status, 'WARN');
    assert.ok(registered.message.includes(repo));
  });

  it('Given a stray value, Then the doctor says it is repaired on the next session or commit', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('doctor-stray');
    await rm(path.join(repo, '.git', 'hooks', 'pre-commit'), { force: true });
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    const report = await installer.doctor(repo);
    assert.match(report.checks.find((c) => c.name === 'Pre-commit hook').message, /default hooks directory/);
    assert.equal(report.checks.find((c) => c.name === 'Effective pre-commit hook').status, 'FAIL');
  });

  it('Given copies that are current but git runs another hook, Then sync-targets reports drift, and --apply repairs only a stray default', async () => {
    const { makeRepo } = await open();
    const stray = await makeRepo('sync-stray');
    const husky = await makeRepo('sync-husky');
    for (const repo of [stray, husky]) await rm(path.join(repo, '.git', 'hooks', 'pre-commit'), { force: true });
    git(stray, 'config', 'core.hooksPath', path.join(stray, '.git', 'hooks'));
    await mkdir(path.join(husky, '.husky'), { recursive: true });
    await writeFile(path.join(husky, '.husky', 'pre-commit'), FOREIGN_HOOK, { mode: 0o755 });
    git(husky, 'config', 'core.hooksPath', '.husky');

    assert.equal((await syncTarget(stray)).status, 'drift');
    assert.equal((await syncTarget(stray, { apply: true })).status, 'synced');
    assert.equal(hooksPathOf(stray), '.githooks');
    const blocked = await syncTarget(husky, { apply: true });
    assert.equal(blocked.status, 'drift');
    assert.equal(blocked.hook.kind, 'foreign');
    assert.equal(hooksPathOf(husky), '.husky');
  });
});

describe('Feature: the extension and the Claude shell stop an unreviewed commit', () => {
  const harness = () => {
    const handlers = new Map();
    initExtension({ registerCommand() {}, on: (event, handler) => handlers.set(event, handler), logger: {} });
    return handlers;
  };

  it('Given git runs another hook, When the agent runs git commit, Then OMP refuses the tool call with the reason; other commands pass', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('omp-guard');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    const handlers = harness();
    const notices = [];
    const ctx = { cwd: repo, ui: { notify: (...args) => notices.push(args) } };

    const blocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'git commit -m "x"' } }, ctx);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? '', /would not be reviewed/);
    assert.equal(await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'git status' } }, ctx), undefined);
    assert.equal(await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'git commit --no-verify -m x' } }, ctx), undefined);
    assert.equal(await handlers.get('tool_call')({ toolName: 'read', input: { path: 'a' } }, ctx), undefined);
    assert.equal(await handlers.get('tool_call')({ toolName: 'read', input: { command: 'git commit -m "x"' } }, ctx), undefined, 'only shell tools run commits');
  });

  it('Given a stray value, When the agent runs git commit, Then OMP repairs it, tells the user and lets the call through', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('omp-repair');
    await rm(path.join(repo, '.git', 'hooks', 'pre-commit'), { force: true });
    git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    const handlers = harness();
    const notices = [];
    const result = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'git commit -m "x"' } }, { cwd: repo, ui: { notify: (...args) => notices.push(args) } });
    assert.equal(result, undefined);
    assert.equal(hooksPathOf(repo), '.githooks');
    assert.equal(notices.length, 1);
    assert.match(notices[0][0], /repaired this checkout/);
  });

  it('Given git runs another hook, Then status exposes the effective hook as not reviewed', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('omp-status');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    const status = await new PluginInstallerService().status(repo);
    assert.equal(status.effectiveHook.kitExpected, true);
    assert.equal(status.effectiveHook.effective, false);
  });

  const claudeInput = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

  it('Given a Bash command that is not a commit, Then the Claude guard does not even load the plugin', async () => {
    // The plugin is pinned to this checkout, so it is found on every machine (CI has no installed OMP
    // plugin). Only the commit prefilter can then decide whether the plugin is loaded.
    const env = { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: path.resolve('.') };
    let loaded = 0;
    const out = [];
    const status = await guard({ input: claudeInput('ls -la', '/x'), env, load: async () => { loaded += 1; return null; }, out: (line) => out.push(line) });
    assert.equal(status, 0);
    for (const command of ['git status', 'git log --oneline', 'echo commit']) {
      await guard({ input: claudeInput(command, '/x'), env, load: async () => { loaded += 1; return null; }, out: (line) => out.push(line) });
    }
    assert.equal(loaded, 0);
    assert.deepEqual(out, []);
  });

  it('Given a blocked commit, Then the Claude guard denies the tool call with the reason; a repair is shown as a system message', async () => {
    const out = [];
    const load = async (decision) => ({ isGitCommitCommand, installer: { guardCommit: async () => decision } });
    const env = { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: path.resolve('.') };
    await guard({ input: claudeInput('git commit -m x', '/r'), env, load: () => load({ action: 'block', message: 'no review' }), out: (line) => out.push(line) });
    assert.equal(out.length, 1, 'a refused commit is denied');
    assert.deepEqual(JSON.parse(out[0]), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no review' } });
    await guard({ input: claudeInput('git commit -m x', '/r'), env, load: () => load({ action: 'allow', repaired: true, message: 'fixed' }), out: (line) => out.push(line) });
    assert.equal(out.length, 2, 'a repair is shown');
    assert.deepEqual(JSON.parse(out[1]), { systemMessage: 'fixed' });
    await guard({ input: claudeInput('git commit --no-verify -m x', '/r'), env, load: () => load({ action: 'block', message: 'x' }), out: (line) => out.push(line) });
    assert.equal(out.length, 2);
  });

  it('Given a plugin without the guard or a guard that throws, Then the command is allowed', async () => {
    const out = [];
    const env = { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: path.resolve('.') };
    assert.equal(await guard({ input: claudeInput('git commit -m x', '/r'), env, load: async () => null, out: (line) => out.push(line) }), 0);
    assert.equal(await guard({ input: claudeInput('git commit -m x', '/r'), env, load: async () => { throw new Error('boom'); }, out: (line) => out.push(line) }), 0);
    assert.deepEqual(out, []);
  });

  it('Given the real plugin and a repository git does not review, Then the Claude guard denies the commit end to end', async () => {
    const { makeRepo } = await open();
    const repo = await makeRepo('claude-e2e');
    await mkdir(path.join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    const out = [];
    const env = { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: path.resolve('.') };
    await guard({ input: claudeInput('cd x && git commit -m "m"', repo), env, out: (line) => out.push(line) });
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('Feature: git commit detection', () => {
  it('Given commands, Then only commits that run the hook are recognised', () => {
    assert.equal(isGitCommitCommand('git commit -m "a b"'), true);
    assert.equal(isGitCommitCommand('cd r && git -C r commit -m x'), true);
    assert.equal(isGitCommitCommand('GIT_X=1 git commit'), true);
    assert.equal(isGitCommitCommand('git commit --no-verify -m x'), false);
    assert.equal(isGitCommitCommand('git status; echo commit'), false);
    assert.equal(isGitCommitCommand("echo 'git commit'"), false);
    assert.equal(isGitCommitCommand('git commit -m "--no-verify"'), true);
    assert.equal(isGitCommitCommand('git commit -m -n'), true);
    assert.equal(isGitCommitCommand('git commit -m x --no-verify'), false);
  });

  it('Given a message attached to -m or -F that contains the letter n, Then it is a commit that runs the hook', () => {
    // The shell joins `-m"new feature"` into one word; the letter n inside the message is text, not -n.
    assert.equal(isGitCommitCommand('git commit -m"new feature"'), true);
    assert.equal(isGitCommitCommand('git commit -mnote'), true);
    assert.equal(isGitCommitCommand('git commit -Fnotes.txt'), true);
    assert.equal(isGitCommitCommand('git commit -mn'), true);
    assert.equal(isGitCommitCommand('git commit -am -n'), true, 'a value option that ends a cluster takes the next word, so -n is the message');
  });

  it('Given a short-option cluster that contains n before any value option, Then it is --no-verify and the commit is not guarded', () => {
    assert.equal(isGitCommitCommand('git commit -an -m x'), false);
    assert.equal(isGitCommitCommand('git commit -n -m x'), false);
    assert.equal(isGitCommitCommand('git commit -nm x'), false);
    assert.equal(isGitCommitCommand('git commit -Sn'), true, 'the letter after -S is its key id, not an option');
    assert.equal(isGitCommitCommand('git commit -- -n'), true, 'after -- every word is a pathspec');
  });
});
