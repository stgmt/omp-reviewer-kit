import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, describe, it } from 'node:test';

import { PluginInstallerService } from '../src/application/installer-service.mjs';

const isWindows = process.platform === 'win32';

/**
 * Creates a clean isolated git repository with configured pre-commit hook using PluginInstallerService.
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

  // Deploy hook using PluginInstallerService
  const installer = new PluginInstallerService();
  const installRes = await installer.setup(repoDir);
  assert.equal(installRes.success, true, `Installer setup failed: ${installRes.message}`);

  return { baseDir, repoDir, git };
}


function stagedDiffHash(git) {
  const result = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']);
  assert.equal(result.status, 0);
  return createHash('sha256').update(result.stdout).digest('hex');
}

function rejectionOutputForHash(diffHash, { kind = 'confirmed_findings', filePath = 'blocked.txt' } = {}) {
  const value = kind === 'review_failure'
    ? {
        schema: 'review-rejection-envelope@1',
        kind,
        diff_hash: diffHash,
        findings: [],
        failure: {
          code: 'execution_failure',
          message: 'The reviewer process did not complete successfully.',
        },
      }
    : {
        schema: 'review-rejection-envelope@1',
        kind,
        diff_hash: diffHash,
        findings: [{
          finding_id: 'correctness-1',
          priority: 'P2',
          defect_class: 'correctness',
          file_path: filePath,
          line_start: 1,
          line_end: 1,
          verifier_argument: 'The repository already provides the same responsibility.',
          counterexample: 'The staged layer only re-wraps the existing mechanism.',
        }],
      };
  return ['REVIEW_REJECTION_ENVELOPE_BEGIN', JSON.stringify(value), 'REVIEW_REJECTION_ENVELOPE_END', 'REVIEW_RESULT=BLOCK', ''].join('\n');
}

const MOCK_ROLES_JSON = '{"key":"modelRoles","value":{"smol":"acme/smol-flash:high","task":"acme/task-fast:high","slow":"acme/slow-max:max"}}';

async function writeMockReviewer(scriptPath, output, reemitOutput = output, captureStdinPath = null) {
  const handlerPath = path.join(path.dirname(scriptPath), `${path.basename(scriptPath, path.extname(scriptPath))}-handler.mjs`);
  const captureExpr = captureStdinPath ? `try { const input = readFileSync(0, 'utf8'); writeFileSync(${JSON.stringify(captureStdinPath)}, input, 'utf8'); } catch {}` : '';
  const handlerCode = `import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'config') {
  process.stdout.write(${JSON.stringify(MOCK_ROLES_JSON)} + '\\n');
  process.exit(0);
}
${captureExpr}
const isReemit = args.includes('--no-tools');
const out = isReemit ? ${JSON.stringify(reemitOutput)} : ${JSON.stringify(output)};
process.stdout.write(out.endsWith('\\n') ? out : out + '\\n');
process.exit(0);
`;
  await writeFile(handlerPath, handlerCode, 'utf8');
  if (isWindows) {
    await writeFile(scriptPath, `@echo off\r\nnode "%~dp0${path.basename(handlerPath)}" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  } else {
    await writeFile(scriptPath, `#!/bin/sh\nnode "$(dirname "$0")/${path.basename(handlerPath)}" "$@"\n`, 'utf8');
    await chmod(scriptPath, 0o755);
  }
}

function rejectionReportPath(output) {
  const matches = [...output.matchAll(/^REVIEW_REJECTION_REPORT=(.+)$/gm)];
  assert.equal(matches.length, 1, 'BLOCK must emit exactly one report pointer');
  return matches[0][1].trim();
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
    await writeMockReviewer(mockOmpScript, 'REVIEW_RESULT=PASS\n');

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

  it('repeated installation via setup does not break hook execution', async () => {
    const { repoDir, git } = fixture;
    const installer = new PluginInstallerService();
    const result = await installer.setup(repoDir);
    assert.equal(result.success, true);
    assert.equal(result.state, 'active');

    const mockOmpScript = path.join(repoDir, isWindows ? 'mock-omp.cmd' : 'mock-omp.sh');
    await writeFile(path.join(repoDir, 'repeated-install.txt'), 'content\n', 'utf8');
    let res = git(['add', 'repeated-install.txt']);
    assert.equal(res.status, 0);

    res = git(['commit', '-m', 'Commit after repeated install'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpScript,
      },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout + res.stderr, /reviewer-kit PASS/);
  });

  it('scripts/setup-hook.mjs can configure hook in a fresh repository', async () => {
    const testBaseDir = await mkdtemp(path.join(tmpdir(), 'omp-cli-setup-'));
    const testRepoDir = path.join(testBaseDir, 'repo');
    await mkdir(testRepoDir, { recursive: true });

    try {
      const git = (args) => spawnSync('git', args, { cwd: testRepoDir, encoding: 'utf8', windowsHide: true });
      git(['init']);
      git(['config', 'user.name', 'CLI Test']);
      git(['config', 'user.email', 'cli@test.local']);

      const kitRoot = path.resolve('.');
      const setupScript = path.join(kitRoot, 'scripts', 'setup-hook.mjs');
      const setupExec = spawnSync(process.execPath, [setupScript, testRepoDir], {
        encoding: 'utf8',
        windowsHide: true,
      });

      assert.equal(setupExec.status, 0, `setup-hook.mjs failed: ${setupExec.stderr}`);
      assert.match(setupExec.stdout, /Configured pre-commit hook/);

      const status = await new PluginInstallerService().status(testRepoDir);
      assert.equal(status.state, 'active');
      assert.equal(status.isFullyActive, true);
    } finally {
      await rm(testBaseDir, { recursive: true, force: true });
    }
  });

  it('strictly blocks a commit when reviewer-kit emits BLOCK and preserves staged state', async () => {
    const { repoDir, git } = fixture;

    const mockOmpBlockScript = path.join(repoDir, isWindows ? 'mock-omp-block.cmd' : 'mock-omp-block.sh');

    // Stage a bad change
    await writeFile(path.join(repoDir, 'blocked.txt'), 'prohibited content\n', 'utf8');
    let res = git(['add', 'blocked.txt']);
    assert.equal(res.status, 0);
    await writeMockReviewer(mockOmpBlockScript, rejectionOutputForHash(stagedDiffHash(git)));

    // Attempt commit
    res = git(['commit', '-m', 'Add blocked file'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpBlockScript,
      },
    });

    // Verify commit was BLOCKED (non-zero exit code)
    assert.notEqual(res.status, 0, 'git commit must fail when reviewer-kit returns BLOCK');
    const blockOutput = res.stdout + res.stderr;
    assert.match(blockOutput, /reviewer-kit BLOCK/);
    const reportPath = rejectionReportPath(blockOutput);
    assert.match(await readFile(reportPath, 'utf8'), /\"priority\": \"P2\"/);
    assert.doesNotMatch(blockOutput, /verifier_argument/);

    // Verify commit was NOT created in git history
    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Add blocked file/);

    // Verify staged file is STILL staged
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  blocked.txt/);
    assert.equal(git(['show', ':blocked.txt']).stdout, 'prohibited content\n');
  });

  it('strictly blocks commit on mandatory-stage failure and preserves staged index', async () => {
    const { repoDir, git } = fixture;

    const mockStageFailScript = path.join(repoDir, isWindows ? 'mock-stage-fail.cmd' : 'mock-stage-fail.sh');

    await writeFile(path.join(repoDir, 'stage-fail.txt'), 'content\n', 'utf8');
    let res = git(['add', 'stage-fail.txt']);
    assert.equal(res.status, 0);
    await writeMockReviewer(mockStageFailScript, rejectionOutputForHash(stagedDiffHash(git), { kind: 'review_failure' }));

    res = git(['commit', '-m', 'Commit with stage failure'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockStageFailScript,
      },
    });

    assert.notEqual(res.status, 0);
    const stageOutput = res.stdout + res.stderr;
    assert.match(stageOutput, /reviewer-kit BLOCK/);
    assert.match(await readFile(rejectionReportPath(stageOutput), 'utf8'), /\"code\": \"execution_failure\"/);

    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Commit with stage failure/);
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  stage-fail.txt/);
  });


  it('strictly blocks malformed rejection envelope and preserves staged bytes', async () => {
    const { repoDir, git } = fixture;
    const mockMalformedScript = path.join(repoDir, isWindows ? 'mock-malformed.cmd' : 'mock-malformed.sh');
    await writeFile(path.join(repoDir, 'malformed.txt'), 'malformed envelope content\n', 'utf8');
    let res = git(['add', 'malformed.txt']);
    assert.equal(res.status, 0);
    await writeMockReviewer(mockMalformedScript, 'REVIEW_REJECTION_ENVELOPE_BEGIN\n{not json}\nREVIEW_REJECTION_ENVELOPE_END\nREVIEW_RESULT=BLOCK\n');

    res = git(['commit', '-m', 'Commit with malformed envelope'], {
      env: { ...process.env, OMP_REVIEW_KIT_OMP: mockMalformedScript },
    });

    assert.notEqual(res.status, 0);
    const output = res.stdout + res.stderr;
    const report = await readFile(rejectionReportPath(output), 'utf8');
    assert.match(report, /malformed_rejection_envelope/);
    assert.doesNotMatch(git(['log', '-1', '--oneline']).stdout, /Commit with malformed envelope/);
    assert.equal(git(['show', ':malformed.txt']).stdout, 'malformed envelope content\n');
  });

  it('strictly blocks commit on duplicate marker output (fail-closed) and preserves staged index', async () => {
    const { repoDir, git } = fixture;

    const mockDupMarkerScript = path.join(repoDir, isWindows ? 'mock-dup-marker.cmd' : 'mock-dup-marker.sh');
    await writeMockReviewer(mockDupMarkerScript, 'REVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK\n');

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
        '@echo off\r\nif "%1"=="config" goto roles\r\necho Review timed out after 600000ms 1>&2\r\nexit /b 1\r\n:roles\r\necho ' + MOCK_ROLES_JSON + '\r\nexit /b 0\r\n',
        'utf8'
      );
    } else {
      await writeFile(
        mockTimeoutScript,
        '#!/bin/sh\nif [ "$1" = "config" ]; then printf "%s\\n" \'' + MOCK_ROLES_JSON + '\'; exit 0; fi\necho "Review timed out after 600000ms" >&2\nexit 1\n',
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

  it('recovers cleanly via verbatim re-emit when fake omp returns JSON-wrapped PASS', async () => {
    const { repoDir, git } = fixture;
    const mockOmpScript = path.join(repoDir, isWindows ? 'mock-reemit-pass.cmd' : 'mock-reemit-pass.sh');

    const reportText = '### Review coverage\n- Diff Hash: clean\n\n### Confirmed findings\nNone.\n\n### Verdict\nPASS';
    const wrappedPass = JSON.stringify({ verdict: 'PASS', report: reportText });
    const reemittedPass = `${reportText}\n\nREVIEW_RESULT=PASS\n`;

    await writeMockReviewer(mockOmpScript, wrappedPass, reemittedPass);

    await writeFile(path.join(repoDir, 'reemit-pass.txt'), 'clean content\n', 'utf8');
    let res = git(['add', 'reemit-pass.txt']);
    assert.equal(res.status, 0);

    res = git(['commit', '-m', 'Commit recovered via re-emit'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpScript,
      },
    });

    assert.equal(res.status, 0, `git commit should succeed via re-emit: ${res.stderr}`);
    const output = res.stdout + res.stderr;
    assert.match(output, /reviewer-kit PASS/);
    const passMatches = [...output.matchAll(/^reviewer-kit PASS: (.+)$/gm)];
    assert.equal(passMatches.length, 1, 'PASS must emit exactly one report pointer');
    const reportPath = passMatches[0][1].trim();
    const reportContent = await readFile(reportPath, 'utf8');
    assert.match(reportContent, /- result: PASS/);
    assert.match(reportContent, /REVIEW_RESULT=PASS/);

    const logRes = git(['log', '-1', '--oneline']);
    assert.equal(logRes.status, 0);
    assert.match(logRes.stdout, /Commit recovered via re-emit/);
  });

  it('strictly blocks when fake omp returns bare verdict JSON on both review and re-emit', async () => {
    const { repoDir, git } = fixture;
    const mockOmpScript = path.join(repoDir, isWindows ? 'mock-bare-verdict.cmd' : 'mock-bare-verdict.sh');

    const bareVerdict = '{"verdict":"PASS"}\n';
    await writeMockReviewer(mockOmpScript, bareVerdict, bareVerdict);

    await writeFile(path.join(repoDir, 'bare-verdict.txt'), 'content\n', 'utf8');
    let res = git(['add', 'bare-verdict.txt']);
    assert.equal(res.status, 0);

    res = git(['commit', '-m', 'Commit with bare verdict'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpScript,
      },
    });

    assert.notEqual(res.status, 0, 'git commit must fail when reviewer-kit returns BLOCK');
    const output = res.stdout + res.stderr;
    assert.match(output, /reviewer-kit BLOCK/);
    const reportPath = rejectionReportPath(output);
    const reportContent = await readFile(reportPath, 'utf8');
    assert.match(reportContent, /- result: BLOCK/);
    assert.match(reportContent, /missing_verdict_marker/);

    const logRes = git(['log', '-1', '--oneline']);
    assert.doesNotMatch(logRes.stdout, /Commit with bare verdict/);
    const statusRes = git(['status', '--porcelain']);
    assert.match(statusRes.stdout, /A  bare-verdict.txt/);
  });

  it('passes execution evidence to reviewer stdin when OMP_REVIEW_KIT_EXECUTE is enabled', async () => {
    const { repoDir, git } = fixture;
    const mockOmpScript = path.join(repoDir, isWindows ? 'mock-exec-omp.cmd' : 'mock-exec-omp.sh');
    const stdinCapturePath = path.join(repoDir, 'captured-stdin.txt');

    await writeMockReviewer(mockOmpScript, 'REVIEW_RESULT=PASS\n', 'REVIEW_RESULT=PASS\n', stdinCapturePath);

    await writeFile(path.join(repoDir, 'exec-test.txt'), 'content\n', 'utf8');
    git(['add', 'exec-test.txt']);

    const res = git(['commit', '-m', 'Commit with execution enabled'], {
      env: {
        ...process.env,
        OMP_REVIEW_KIT_OMP: mockOmpScript,
        OMP_REVIEW_KIT_EXECUTE: '1',
        OMP_REVIEW_KIT_EXECUTE_COMMAND: 'node -e "process.stdout.write(\'checks ran fine\'); process.exit(0)"',
      },
    });

    assert.equal(res.status, 0, `git commit should succeed: ${res.stderr}`);
    const captured = await readFile(stdinCapturePath, 'utf8');
    assert.match(captured, /Execution evidence \(opt-in, produced by the dispatcher before this review\):/);
    assert.match(captured, /checks ran fine/);
  });
});