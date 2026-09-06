import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import initExtension from '../src/extension.mjs';

async function createTempRepo() {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-ext-test-'));
  const repoDir = path.join(baseDir, 'repo');
  await mkdir(repoDir, { recursive: true });

  const git = (args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true });
  git(['init']);
  git(['config', 'user.name', 'Extension Test']);
  git(['config', 'user.email', 'ext@test.local']);

  return { baseDir, repoDir, git };
}

function createExtensionHarness() {
  const registeredCommands = new Map();
  const registeredEvents = new Map();
  const logs = [];

  const fakePi = {
    registerCommand(name, options) {
      registeredCommands.set(name, options);
    },
    on(event, handler) {
      registeredEvents.set(event, handler);
    },
    logger: {
      warn(msg) {
        logs.push({ level: 'warn', msg });
      },
      error(msg) {
        logs.push({ level: 'error', msg });
      },
    },
  };

  initExtension(fakePi);

  const makeCtx = (cwd) => {
    const notifications = [];
    let status = null;
    return {
      cwd,
      notifications,
      getStatus: () => status,
      ui: {
        notify(msg, type) {
          notifications.push({ msg, type });
        },
        setStatus(key, text) {
          if (key === 'reviewer-kit') {
            status = text;
          }
        },
      },
    };
  };

  return {
    commands: registeredCommands,
    events: registeredEvents,
    logs,
    makeCtx,
  };
}

describe('Feature: Native OMP Extension & Installer Service', () => {
  it('Scenario 1: empty git repo + session_start creates hook and runner, configures core.hooksPath, sets active status', async () => {
    const { baseDir, repoDir, git } = await createTempRepo();
    try {
      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);

      const sessionStart = harness.events.get('session_start');
      assert.ok(sessionStart, 'session_start handler must be registered');
      await sessionStart({}, ctx);

      assert.equal(ctx.getStatus(), 'reviewer-kit: active');

      const hookContent = await readFile(path.join(repoDir, '.githooks', 'pre-commit'), 'utf8');
      assert.match(hookContent, /run-review\.mjs/);

      const runnerContent = await readFile(path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs'), 'utf8');
      assert.match(runnerContent, /runReview/);

      const configRes = git(['config', '--get', 'core.hooksPath']);
      assert.equal(configRes.stdout.trim(), '.githooks');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 2: repeated session_start on active repo returns active and preserves files unchanged', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);
      const sessionStart = harness.events.get('session_start');

      // First run: installs
      await sessionStart({}, ctx);
      assert.equal(ctx.getStatus(), 'reviewer-kit: active');

      const hookPath = path.join(repoDir, '.githooks', 'pre-commit');
      const runnerPath = path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs');
      const hookInitial = await readFile(hookPath, 'utf8');
      const runnerInitial = await readFile(runnerPath, 'utf8');

      // Second run: active, no changes
      await sessionStart({}, ctx);
      assert.equal(ctx.getStatus(), 'reviewer-kit: active');

      const hookSecond = await readFile(hookPath, 'utf8');
      const runnerSecond = await readFile(runnerPath, 'utf8');
      assert.equal(hookSecond, hookInitial);
      assert.equal(runnerSecond, runnerInitial);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 3: stale runner with owned hook is updated to current runner', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const installer = new PluginInstallerService();
      await installer.setup(repoDir);

      const runnerPath = path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs');
      await writeFile(runnerPath, '// stale runner v0.0.1\n', 'utf8');

      const staleStatus = await installer.status(repoDir);
      assert.equal(staleStatus.state, 'stale');
      assert.equal(staleStatus.runnerCurrent, false);

      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);
      const sessionStart = harness.events.get('session_start');
      await sessionStart({}, ctx);

      assert.equal(ctx.getStatus(), 'reviewer-kit: active');

      const updatedRunner = await readFile(runnerPath, 'utf8');
      assert.match(updatedRunner, /runReview/);

      const finalStatus = await installer.status(repoDir);
      assert.equal(finalStatus.state, 'active');
      assert.equal(finalStatus.runnerCurrent, true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 3b: legacy owned hook is migrated to the trusted path-based template', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const installer = new PluginInstallerService();
      await installer.setup(repoDir);
      const hookPath = path.join(repoDir, '.githooks', 'pre-commit');
      const legacyHook = '#!/bin/sh\nset -eu\n\nroot=$(git rev-parse --show-toplevel)\nexec node "$root/.omp/review-kit/run-review.mjs"\n';
      await writeFile(hookPath, legacyHook, 'utf8');

      const staleStatus = await installer.status(repoDir);
      assert.equal(staleStatus.state, 'stale');
      assert.equal(staleStatus.hookOwned, true);
      assert.equal(staleStatus.hookCurrent, false);

      const result = await installer.setup(repoDir);
      const migratedHook = await readFile(hookPath, 'utf8');

      assert.equal(result.success, true);
      assert.equal(result.state, 'updated');
      assert.equal((await installer.status(repoDir)).state, 'active');
      assert.match(migratedHook, /hook_dir=\$\(CDPATH= cd/);
      assert.doesNotMatch(migratedHook, /git rev-parse/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 4: foreign .githooks/pre-commit remains byte-for-byte identical and reports conflict', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const githooksDir = path.join(repoDir, '.githooks');
      await mkdir(githooksDir, { recursive: true });
      const foreignHook = '#!/bin/sh\n# foreign proprietary hook\nexit 0\n';
      const hookPath = path.join(githooksDir, 'pre-commit');
      await writeFile(hookPath, foreignHook, 'utf8');

      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);
      const sessionStart = harness.events.get('session_start');
      await sessionStart({}, ctx);

      assert.equal(ctx.getStatus(), 'reviewer-kit: conflict');

      const hookAfter = await readFile(hookPath, 'utf8');
      assert.equal(hookAfter, foreignHook);

      const installer = new PluginInstallerService();
      const status = await installer.status(repoDir);
      assert.equal(status.state, 'conflict');
      assert.match(status.conflictReason, /Existing \.githooks\/pre-commit does not match/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 4b: unrelated .githooks hook remains inactive and byte-for-byte identical during session_start', async () => {
      const { baseDir, repoDir, git } = await createTempRepo();
      try {
        const hooksDir = path.join(repoDir, '.githooks');
        const foreignHookPath = path.join(hooksDir, 'commit-msg');
        const foreignHook = '#!/bin/sh\nexit 0\n';
        await mkdir(hooksDir, { recursive: true });
        await writeFile(foreignHookPath, foreignHook, 'utf8');

        const harness = createExtensionHarness();
        const ctx = harness.makeCtx(repoDir);
        await harness.events.get('session_start')({}, ctx);

        assert.equal(ctx.getStatus(), 'reviewer-kit: conflict');
        assert.equal(await readFile(foreignHookPath, 'utf8'), foreignHook);
        assert.notEqual(git(['config', '--get', 'core.hooksPath']).status, 0);
        await assert.rejects(readFile(path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs'), 'utf8'), { code: 'ENOENT' });
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    });

    it('Scenario 5: foreign core.hooksPath (.husky) and its files remain untouched and report conflict', async () => { const { baseDir, repoDir, git } = await createTempRepo();
    try {
      git(['config', 'core.hooksPath', '.husky']);
      const huskyDir = path.join(repoDir, '.husky');
      await mkdir(huskyDir, { recursive: true });
      const huskyHook = '#!/bin/sh\nnpm test\n';
      await writeFile(path.join(huskyDir, 'pre-commit'), huskyHook, 'utf8');

      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);
      const sessionStart = harness.events.get('session_start');
      await sessionStart({}, ctx);

      assert.equal(ctx.getStatus(), 'reviewer-kit: conflict');

      const configRes = git(['config', '--get', 'core.hooksPath']);
      assert.equal(configRes.stdout.trim(), '.husky');

      const huskyAfter = await readFile(path.join(huskyDir, 'pre-commit'), 'utf8');
      assert.equal(huskyAfter, huskyHook);

      const installer = new PluginInstallerService();
      const status = await installer.status(repoDir);
      assert.equal(status.state, 'conflict');
      assert.match(status.conflictReason, /core\.hooksPath is configured to "\.husky"/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    } });

  it('Scenario 6: user file in standard .git/hooks is not disabled, .githooks not created, reports conflict', async () => {
    const { baseDir, repoDir, git } = await createTempRepo();
    try {
      const standardHooksDir = path.join(repoDir, '.git', 'hooks');
      await mkdir(standardHooksDir, { recursive: true });
      const customHook = '#!/bin/sh\necho custom pre-commit\n';
      const hookPath = path.join(standardHooksDir, 'pre-commit');
      await writeFile(hookPath, customHook, 'utf8');

      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);
      const sessionStart = harness.events.get('session_start');
      await sessionStart({}, ctx);

      assert.equal(ctx.getStatus(), 'reviewer-kit: conflict');

      const configRes = git(['config', '--get', 'core.hooksPath']);
      assert.equal(configRes.stdout.trim(), '', 'core.hooksPath must remain unset');

      const hookAfter = await readFile(hookPath, 'utf8');
      assert.equal(hookAfter, customHook);

      const installer = new PluginInstallerService();
      const status = await installer.status(repoDir);
      assert.equal(status.state, 'conflict');
      assert.match(status.conflictReason, /Existing hooks found in standard hooks directory/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 7: non-executable owned hook is reported stale and repaired', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX executable mode is not enforced by Git on Windows');
      return;
    }

    const { baseDir, repoDir } = await createTempRepo();
    try {
      const installer = new PluginInstallerService();
      await installer.setup(repoDir);
      const hookPath = path.join(repoDir, '.githooks', 'pre-commit');
      await chmod(hookPath, 0o644);

      const stale = await installer.status(repoDir);
      assert.equal(stale.state, 'stale');
      assert.equal(stale.hookExecutable, false);

      const repaired = await installer.setup(repoDir);
      assert.equal(repaired.success, true);
      assert.equal((await installer.status(repoDir)).state, 'active');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 8: unreadable hook path is reported as conflict and never overwritten', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const githooksDir = path.join(repoDir, '.githooks');
      const hookPath = path.join(githooksDir, 'pre-commit');
      await mkdir(githooksDir, { recursive: true });
      await mkdir(hookPath);
      const installer = new PluginInstallerService();

      const result = await installer.setup(repoDir);

      assert.equal(result.success, false);
      assert.equal(result.state, 'conflict');
      assert.match(result.message, /Unable to inspect existing .githooks\/pre-commit/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 9: repository-controlled hook directory symlink is rejected before writes', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Symlink creation requires elevated Windows privileges');
      return;
    }

    const { baseDir, repoDir } = await createTempRepo();
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'omp-ext-outside-'));
    try {
      await symlink(outsideDir, path.join(repoDir, '.githooks'), 'dir');
      const installer = new PluginInstallerService();

      const result = await installer.setup(repoDir);

      assert.equal(result.success, false);
      assert.equal(result.state, 'conflict');
      assert.match(result.message, /symlink component/);
      assert.equal(await readFile(path.join(outsideDir, 'pre-commit'), 'utf8').catch(() => null), null);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('native hooks inspection failure is reported as conflict before switching hooksPath', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const standardHooksDir = path.join(repoDir, '.git', 'hooks');
      await rm(standardHooksDir, { recursive: true, force: true });
      await writeFile(standardHooksDir, 'native hooks path is not readable as a directory', 'utf8');
      const installer = new PluginInstallerService();

      const result = await installer.setup(repoDir);

      assert.equal(result.success, false);
      assert.equal(result.state, 'conflict');
      assert.match(result.message, /Unable to inspect standard hooks directory/);
      assert.equal(await readFile(path.join(repoDir, '.git', 'config'), 'utf8').then(content => content.includes('hooksPath')).catch(() => false), false);
      assert.equal(await readFile(path.join(repoDir, '.githooks', 'pre-commit'), 'utf8').catch(() => null), null);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('Scenario 10: directory outside Git does not create files or throw during session_start', async () => {
    const nonGitDir = await mkdtemp(path.join(tmpdir(), 'omp-non-git-'));
    try {
      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(nonGitDir);
      const sessionStart = harness.events.get('session_start');

      await assert.doesNotReject(async () => {
        await sessionStart({}, ctx);
      });

      assert.equal(ctx.getStatus(), null, 'Status must not be set for non-git directory');
      assert.equal(harness.logs.length, 0, 'No error logs for normal non-git directory');

      const installer = new PluginInstallerService();
      const status = await installer.status(nonGitDir);
      assert.equal(status.isGitRepo, false);
      assert.equal(status.state, 'not-git');
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('Scenario 11: /reviewer-kit:setup on conflict emits warning notification and keeps conflict status', async () => {
    const { baseDir, repoDir, git } = await createTempRepo();
    try {
      git(['config', 'core.hooksPath', '.custom-hooks']);

      const harness = createExtensionHarness();
      const ctx = harness.makeCtx(repoDir);
      const setupCmd = harness.commands.get('reviewer-kit:setup');
      assert.ok(setupCmd, 'reviewer-kit:setup must be registered');

      await setupCmd.handler('', ctx);

      assert.equal(ctx.getStatus(), 'reviewer-kit: conflict');
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].type, 'warning');
      assert.match(ctx.notifications[0].msg, /reviewer-kit setup conflict/);

      const doctorReport = await new PluginInstallerService().doctor(repoDir);
      const conflictCheck = doctorReport.checks.find((c) => c.name === 'Pre-commit hook conflict');
      assert.ok(conflictCheck);
      assert.equal(conflictCheck.status, 'WARN');
      assert.match(conflictCheck.message, /core\.hooksPath is configured to "\.custom-hooks"/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('shows live Git commit hook progress and final BLOCK status', async () => {
    const harness = createExtensionHarness();
    const ctx = harness.makeCtx(process.cwd());
    const start = harness.events.get('tool_execution_start');
    const update = harness.events.get('tool_execution_update');
    const end = harness.events.get('tool_execution_end');

    await start({ type: 'tool_execution_start', toolCallId: 'commit-1', toolName: 'bash', args: { command: 'git commit -m "test"' } }, ctx);
    assert.match(ctx.getStatus(), /commit hook review/);
    assert.match(ctx.getStatus(), /10%/);

    await update({
      type: 'tool_execution_update',
      toolCallId: 'commit-1',
      toolName: 'bash',
      args: { command: 'git commit -m "test"' },
      partialResult: { content: [{ type: 'text', text: 'reviewer-kit progress: [reviewing] commit hook review running; no automatic cancellation; waiting for model response · model @slow · elapsed 15s\n' }] },
    }, ctx);
    assert.match(ctx.getStatus(), /50%/);
    assert.match(ctx.getStatus(), /no automatic cancellation/);

    await end({
      type: 'tool_execution_end',
      toolCallId: 'commit-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'reviewer-kit BLOCK: E:/repo/audit.md\n' }] },
      isError: true,
    }, ctx);
    assert.match(ctx.getStatus(), /100%/);
    assert.match(ctx.getStatus(), /BLOCK/);
  });

  it('prioritizes BLOCK when tool output contains stale PASS text', async () => {
    const harness = createExtensionHarness();
    const ctx = harness.makeCtx(process.cwd());
    const start = harness.events.get('tool_execution_start');
    const end = harness.events.get('tool_execution_end');

    await start({
      type: 'tool_execution_start',
      toolCallId: 'mixed-verdict-commit',
      toolName: 'bash',
      args: { command: 'git commit -m "mixed"' },
    }, ctx);
    await end({
      type: 'tool_execution_end',
      toolCallId: 'mixed-verdict-commit',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'reviewer-kit PASS: stale-report.md\nreviewer-kit BLOCK: current-report.md\n' }] },
      isError: true,
    }, ctx);

    assert.match(ctx.getStatus(), /BLOCK/);
    assert.doesNotMatch(ctx.getStatus(), /PASS ·/);
  });

  it('does not show review progress for commits that skip hooks', async () => {
    const harness = createExtensionHarness();
    const ctx = harness.makeCtx(process.cwd());
    const start = harness.events.get('tool_execution_start');

    for (const [toolCallId, command] of [
      ['no-verify-long', 'git commit --no-verify -m "test"'],
      ['no-verify-short', 'git commit -n -m "test"'],
      ['no-verify-clustered-short', 'git commit -nq -m "test"'],
    ]) {
      await start({
        type: 'tool_execution_start',
        toolCallId,
        toolName: 'bash',
        args: { command },
      }, ctx);
      assert.equal(ctx.getStatus(), null);
    }
  });

  it('tracks commits whose message merely mentions bypass flags', async () => {
    const harness = createExtensionHarness();
    const ctx = harness.makeCtx(process.cwd());
    const start = harness.events.get('tool_execution_start');

    for (const [toolCallId, command] of [
      ['message-mentions-long-flag', 'git commit -m "--no-verify"'],
      ['message-mentions-short-flag', 'git commit -m "-n"'],
    ]) {
      await start({
        type: 'tool_execution_start',
        toolCallId,
        toolName: 'bash',
        args: { command },
      }, ctx);
      assert.match(ctx.getStatus(), /commit hook review/);
    }
  });

  it('shows skipped status for an empty staged change', async () => {
    const harness = createExtensionHarness();
    const ctx = harness.makeCtx(process.cwd());
    const start = harness.events.get('tool_execution_start');
    const end = harness.events.get('tool_execution_end');

    await start({
      type: 'tool_execution_start',
      toolCallId: 'empty-commit',
      toolName: 'bash',
      args: { command: 'git commit -m "empty"' },
    }, ctx);
    await end({
      type: 'tool_execution_end',
      toolCallId: 'empty-commit',
      toolName: 'bash',
      result: { skipped: true },
      isError: false,
    }, ctx);

    assert.match(ctx.getStatus(), /100%/);
    assert.match(ctx.getStatus(), /SKIPPED/);
    assert.match(ctx.getStatus(), /no staged changes/);
  });

  it('ignores shell text that merely mentions git commit', async () => {
    const harness = createExtensionHarness();
    const ctx = harness.makeCtx(process.cwd());
    const start = harness.events.get('tool_execution_start');

    for (const [toolCallId, command] of [
      ['log-format', 'git log --format="git commit"'],
      ['printf-text', "printf 'git commit\n'"],
    ]) {
      await start({
        type: 'tool_execution_start',
        toolCallId,
        toolName: 'bash',
        args: { command },
      }, ctx);
      assert.equal(ctx.getStatus(), null);
    }
  });

  it('PluginInstallerService doctor reports diagnostic health checks', async () => {
    const { baseDir, repoDir } = await createTempRepo();
    try {
      const installer = new PluginInstallerService();
      await installer.setup(repoDir);

      const report = await installer.doctor(repoDir);
      assert.equal(typeof report.ok, 'boolean');
      assert.ok(report.checks.length >= 4);

      const nodeCheck = report.checks.find((c) => c.name === 'Node.js runtime');
      assert.ok(nodeCheck);
      assert.equal(nodeCheck.status, 'OK');

      const gitCheck = report.checks.find((c) => c.name === 'Git executable');
      assert.ok(gitCheck);
      assert.equal(gitCheck.status, 'OK');

      const hookCheck = report.checks.find((c) => c.name === 'Pre-commit hook');
      assert.ok(hookCheck);
      assert.equal(hookCheck.status, 'OK');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
