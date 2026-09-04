import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, describe, it } from 'node:test';
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

describe('Feature: Native OMP Extension & Installer Service', () => {
  let fixture;

  after(async () => {
    if (fixture?.baseDir) {
      try {
        await rm(fixture.baseDir, { recursive: true, force: true });
      } catch {
        // Ignore lock errors on Windows
      }
    }
  });

  it('PluginInstallerService setup installs pre-commit hook and configures core.hooksPath', async () => {
    fixture = await createTempRepo();
    const { repoDir, git } = fixture;

    const installer = new PluginInstallerService();
    const initialStatus = await installer.status(repoDir);
    assert.equal(initialStatus.isFullyActive, false, 'Should be inactive before setup');

    const result = await installer.setup(repoDir);
    assert.equal(result.success, true);
    assert.match(result.message, /core\.hooksPath \.githooks/);

    const postStatus = await installer.status(repoDir);
    assert.equal(postStatus.isFullyActive, true, 'Should be fully active after setup');
    assert.equal(postStatus.hooksPathConfigured, true);
    assert.equal(postStatus.hookFilePresent, true);
    assert.equal(postStatus.runnerPresent, true);

    const hookContent = await readFile(path.join(repoDir, '.githooks', 'pre-commit'), 'utf8');
    assert.match(hookContent, /run-review\.mjs/);

    const runnerContent = await readFile(path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs'), 'utf8');
    assert.match(runnerContent, /runReview/);
  });

  it('PluginInstallerService doctor reports diagnostic health checks', async () => {
    const { repoDir } = fixture;
    const installer = new PluginInstallerService();

    const report = await installer.doctor(repoDir);
    assert.equal(typeof report.ok, 'boolean');
    assert.ok(report.checks.length >= 4);

    const nodeCheck = report.checks.find(c => c.name === 'Node.js runtime');
    assert.ok(nodeCheck);
    assert.equal(nodeCheck.status, 'OK');

    const gitCheck = report.checks.find(c => c.name === 'Git executable');
    assert.ok(gitCheck);
    assert.equal(gitCheck.status, 'OK');

    const hookCheck = report.checks.find(c => c.name === 'Pre-commit hook');
    assert.ok(hookCheck);
    assert.equal(hookCheck.status, 'OK');
  });

  it('initExtension registers native OMP commands and lifecycle handlers', async () => {
    const { repoDir } = fixture;

    const registeredCommands = new Map();
    const registeredEvents = new Map();

    const fakePi = {
      registerCommand(name, options) {
        registeredCommands.set(name, options);
      },
      on(event, handler) {
        registeredEvents.set(event, handler);
      },
    };

    // Initialize extension
    initExtension(fakePi);

    assert.ok(registeredCommands.has('reviewer-kit:setup'), 'Must register reviewer-kit:setup');
    assert.ok(registeredCommands.has('reviewer-kit:status'), 'Must register reviewer-kit:status');
    assert.ok(registeredCommands.has('reviewer-kit:doctor'), 'Must register reviewer-kit:doctor');
    assert.ok(registeredEvents.has('session_start'), 'Must register session_start');

    // Test command invocation: /reviewer-kit:status
    const notifications = [];
    let statusText = '';
    const fakeCtx = {
      cwd: repoDir,
      ui: {
        notify(msg, type) {
          notifications.push({ msg, type });
        },
        setStatus(key, text) {
          if (key === 'reviewer-kit') statusText = text;
        },
      },
    };

    const statusCmd = registeredCommands.get('reviewer-kit:status');
    await statusCmd.handler('', fakeCtx);
    assert.ok(notifications.length > 0);
    assert.match(notifications[0].msg, /ACTIVE \(commits guarded\)/);

    // Test command invocation: /reviewer-kit:doctor
    const doctorCmd = registeredCommands.get('reviewer-kit:doctor');
    notifications.length = 0;
    await doctorCmd.handler('', fakeCtx);
    assert.ok(notifications.length > 0);
    assert.match(notifications[0].msg, /\[OK\] Node\.js runtime/);

    // Test session_start handler
    const sessionStartHandler = registeredEvents.get('session_start');
    await sessionStartHandler({}, fakeCtx);
    assert.equal(statusText, 'reviewer-kit: active');
  });
});
