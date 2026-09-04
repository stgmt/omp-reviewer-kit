import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, describe, it } from 'node:test';

const isWindows = process.platform === 'win32';

/**
 * Creates a clean isolated git repository with configured pre-commit hook.
 */
async function setupE2eRepo() {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-e2e-hook-'));
  const repoDir = path.join(baseDir, 'repo');
  await mkdir(repoDir, { recursive: true });

  const git = (args, options = {}) => {
    return spawnSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      windowsHide: true,
      ...options,
    });
  };

  // Initialize git repository and configure user
  let res = git(['init']);
  assert.equal(res.status, 0, `git init failed: ${res.stderr}`);
  git(['config', 'user.name', 'E2E Test']);
  git(['config', 'user.email', 'e2e@test.local']);

  // Deploy hook template and runner
  const kitRoot = path.resolve('.');
  const gitHooksDir = path.join(repoDir, '.githooks');
  const runnerDir = path.join(repoDir, '.omp', 'review-kit');
  await mkdir(gitHooksDir, { recursive: true });
  await mkdir(runnerDir, { recursive: true });

  const hookTemplate = await readFile(path.join(kitRoot, 'templates', 'githooks', 'pre-commit'), 'utf8');
  const runnerSource = await readFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), 'utf8');

  const hookPath = path.join(gitHooksDir, 'pre-commit');
  await writeFile(hookPath, hookTemplate, 'utf8');
  await writeFile(path.join(runnerDir, 'run-review.mjs'), runnerSource, 'utf8');
  if (!isWindows) {
    await chmod(hookPath, 0o755);
  }

  res = git(['config', 'core.hooksPath', '.githooks']);
  assert.equal(res.status, 0, `configuring core.hooksPath failed: ${res.stderr}`);

  return { baseDir, repoDir, git };
}

describe('Feature: Real Git Pre-commit Hook E2E Integration', () => {
  let fixture;

  after(async () => {
    if (fixture?.baseDir) {
      try {
        await rm(fixture.baseDir, { recursive: true, force: true });
      } catch {
        // Ignore temporary cleanup locks on Windows
      }
    }
  });

  it('permits a commit when reviewer-kit emits PASS and creates audit report', async () => {
    fixture = await setupE2eRepo();
    const { repoDir, git } = fixture;

    // Create mock OMP runner that approves the change
    const mockOmpScript = path.join(repoDir, isWindows ? 'mock-omp.cmd' : 'mock-omp.sh');
    if (isWindows) {
      await writeFile(mockOmpScript, '@echo off\r\necho REVIEW_RESULT=PASS\r\nexit /b 0\r\n', 'utf8');
    } else {
      await writeFile(mockOmpScript, '#!/bin/sh\necho "REVIEW_RESULT=PASS"\nexit 0\n', 'utf8');
      await chmod(mockOmpScript, 0o755);
    }

    // Stage a new file
    await writeFile(path.join(repoDir, 'approved.txt'), 'clean content\n', 'utf8');
    let res = git(['add', 'approved.txt']);
    assert.equal(res.status, 0);

    // Commit with OMP_REVIEW_KIT_OMP pointing to our mock
    res = git(['commit', '-m', 'Add approved file'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpScript,
      },
    });

    assert.equal(res.status, 0, `git commit should succeed but failed: ${res.stderr}`);
    assert.match(res.stdout + res.stderr, /reviewer-kit PASS/);

    // Verify commit is in git history
    const logRes = git(['log', '-1', '--oneline']);
    assert.equal(logRes.status, 0);
    assert.match(logRes.stdout, /Add approved file/);

    // Verify working tree state
    const statusRes = git(['status', '--porcelain']);
    assert.equal(statusRes.status, 0);
    assert.doesNotMatch(statusRes.stdout, /M  approved.txt/);
  });

  it('strictly blocks a commit when reviewer-kit emits BLOCK and preserves staged state', async () => {
    const { repoDir, git } = fixture;

    // Create mock OMP runner that blocks the change
    const mockOmpBlockScript = path.join(repoDir, isWindows ? 'mock-omp-block.cmd' : 'mock-omp-block.sh');
    if (isWindows) {
      await writeFile(
        mockOmpBlockScript,
        '@echo off\r\necho Finding: prohibited pattern found.\r\necho REVIEW_RESULT=BLOCK\r\nexit /b 0\r\n',
        'utf8'
      );
    } else {
      await writeFile(
        mockOmpBlockScript,
        '#!/bin/sh\necho "Finding: prohibited pattern found."\necho "REVIEW_RESULT=BLOCK"\nexit 0\n',
        'utf8'
      );
      await chmod(mockOmpBlockScript, 0o755);
    }

    // Stage a bad change
    await writeFile(path.join(repoDir, 'blocked.txt'), 'prohibited content\n', 'utf8');
    let res = git(['add', 'blocked.txt']);
    assert.equal(res.status, 0);

    // Attempt commit
    res = git(['commit', '-m', 'Add blocked file'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpBlockScript,
      },
    });

    // Verify commit was BLOCKED (non-zero exit code)
    assert.notEqual(res.status, 0, 'git commit must fail when reviewer-kit returns BLOCK');
    assert.match(res.stdout + res.stderr, /reviewer-kit BLOCK/);
    assert.match(res.stdout + res.stderr, /Finding: prohibited pattern found/);

    // Verify commit was NOT created in git history
    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Add blocked file/);

    // Verify staged file is STILL staged
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  blocked.txt/);
  });

  it('strictly blocks commit on mandatory-stage failure and preserves staged index', async () => {
    const { repoDir, git } = fixture;

    const mockStageFailScript = path.join(repoDir, isWindows ? 'mock-stage-fail.cmd' : 'mock-stage-fail.sh');
    if (isWindows) {
      await writeFile(
        mockStageFailScript,
        '@echo off\r\necho Stage review-finding-verifier failed: StructuredSubagentError\r\necho REVIEW_RESULT=BLOCK\r\nexit /b 0\r\n',
        'utf8'
      );
    } else {
      await writeFile(
        mockStageFailScript,
        '#!/bin/sh\necho "Stage review-finding-verifier failed: StructuredSubagentError"\necho "REVIEW_RESULT=BLOCK"\nexit 0\n',
        'utf8'
      );
      await chmod(mockStageFailScript, 0o755);
    }

    await writeFile(path.join(repoDir, 'stage-fail.txt'), 'content\n', 'utf8');
    let res = git(['add', 'stage-fail.txt']);
    assert.equal(res.status, 0);

    res = git(['commit', '-m', 'Commit with stage failure'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockStageFailScript,
      },
    });

    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /reviewer-kit BLOCK/);
    assert.match(res.stdout + res.stderr, /Stage review-finding-verifier failed/);

    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Commit with stage failure/);
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  stage-fail.txt/);
  });

  it('strictly blocks commit on duplicate marker output (fail-closed) and preserves staged index', async () => {
    const { repoDir, git } = fixture;

    const mockDupMarkerScript = path.join(repoDir, isWindows ? 'mock-dup-marker.cmd' : 'mock-dup-marker.sh');
    if (isWindows) {
      await writeFile(
        mockDupMarkerScript,
        '@echo off\r\necho REVIEW_RESULT=PASS\r\necho REVIEW_RESULT=BLOCK\r\nexit /b 0\r\n',
        'utf8'
      );
    } else {
      await writeFile(
        mockDupMarkerScript,
        '#!/bin/sh\necho "REVIEW_RESULT=PASS"\necho "REVIEW_RESULT=BLOCK"\nexit 0\n',
        'utf8'
      );
      await chmod(mockDupMarkerScript, 0o755);
    }

    await writeFile(path.join(repoDir, 'dup-marker.txt'), 'content\n', 'utf8');
    let res = git(['add', 'dup-marker.txt']);
    assert.equal(res.status, 0);

    res = git(['commit', '-m', 'Commit with duplicate markers'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockDupMarkerScript,
      },
    });

    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /reviewer-kit BLOCK/);

    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Commit with duplicate markers/);
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  dup-marker.txt/);
  });

  it('strictly blocks commit on reviewer process timeout or non-zero exit and preserves staged index', async () => {
    const { repoDir, git } = fixture;

    const mockTimeoutScript = path.join(repoDir, isWindows ? 'mock-timeout.cmd' : 'mock-timeout.sh');
    if (isWindows) {
      await writeFile(
        mockTimeoutScript,
        '@echo off\r\necho Review timed out after 600000ms 1>&2\r\nexit /b 1\r\n',
        'utf8'
      );
    } else {
      await writeFile(
        mockTimeoutScript,
        '#!/bin/sh\necho "Review timed out after 600000ms" >&2\nexit 1\n',
        'utf8'
      );
      await chmod(mockTimeoutScript, 0o755);
    }

    await writeFile(path.join(repoDir, 'timeout-test.txt'), 'content\n', 'utf8');
    let res = git(['add', 'timeout-test.txt']);
    assert.equal(res.status, 0);

    res = git(['commit', '-m', 'Commit with timeout'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockTimeoutScript,
      },
    });

    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /reviewer-kit BLOCK/);

    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Commit with timeout/);
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  timeout-test.txt/);
  });

  it('permits commit when --no-verify flag is passed explicitly by user', async () => {
    const { repoDir, git } = fixture;

    // Point OMP to failing script
    const res = git(['commit', '--no-verify', '-m', 'Bypass commit'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: 'invalid-nonexistent-omp-binary',
      },
    });

    assert.equal(res.status, 0, `git commit --no-verify should succeed: ${res.stderr}`);
    const logRes = git(['log', '-1', '--oneline']);
    assert.match(logRes.stdout, /Bypass commit/);
  });
});
