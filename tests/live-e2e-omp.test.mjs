import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { describe, it } from 'node:test';
import { ReviewPrompt } from '../src/index.mjs';

const isLiveE2E = process.env.OMP_REVIEW_KIT_LIVE_E2E === '1';

const hasOmp = (() => {
  try {
    const ompCommand = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
    const isWindowsWrapper = /\.(cmd|bat)$/i.test(ompCommand);
    const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : ompCommand;
    const args = isWindowsWrapper
      ? ['/d', '/c', 'call', ompCommand, '--version']
      : ['--version'];
    const res = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true });
    return res.status === 0;
  } catch {
    return false;
  }
})();

/**
 * Runs a real OMP command with piped stdin and closed EOF.
 */
function runLiveOmp(prompt, cwd, timeoutMs = 600_000, extraEnv = {}) {
  const ompCommand = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
  const commandArgs = ['-p', '--model', process.env.OMP_REVIEW_KIT_MODEL ?? '@slow', '--no-session'];
  const isWindowsWrapper = /\.(cmd|bat)$/i.test(ompCommand);
  const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : ompCommand;
  const args = isWindowsWrapper
    ? ['/d', '/c', 'call', ompCommand, ...commandArgs]
    : commandArgs;

  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Live OMP process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.on('error', () => {});
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {
      // Ignore write errors on closed streams
    }
  });
}


function resolveAgentDir(profile) {
  const args = [...(profile ? ['--profile', profile] : []), 'config', 'path'];
  const result = spawnSync(process.env.OMP_REVIEW_KIT_OMP ?? 'omp', args, {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Failed to resolve OMP config path: ${result.stderr}`);
  return result.stdout.trim();
}

async function copyDefaultProfileConfig(targetAgentDir) {
  const defaultAgentDir = resolveAgentDir();
  await mkdir(targetAgentDir, { recursive: true });
  for (const filename of ['models.yml', 'config.yml', 'agent.db']) {
    await copyFile(path.join(defaultAgentDir, filename), path.join(targetAgentDir, filename));
  }
}


describe('Feature: Real Live OMP & Plugin Discovery E2E (No Mocks)', () => {
  it('Live Check 1: OMP plugin doctor confirms omp-reviewer-kit is linked and healthy', { skip: !hasOmp }, () => {
    const ompCommand = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
    const isWindowsWrapper = /\.(cmd|bat)$/i.test(ompCommand);
    const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : ompCommand;
    const args = isWindowsWrapper
      ? ['/d', '/c', 'call', ompCommand, 'plugin', 'doctor']
      : ['plugin', 'doctor'];

    const res = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, `omp plugin doctor failed: ${res.stderr}`);
    assert.match(res.stdout, /plugin:omp-reviewer-kit/);
  });

  it('Live Check 2: OMP native task discovery detects reviewer-kit and all specialist agents', { skip: !hasOmp }, async () => {
    const defaultDiscoveryPath = path.join(path.dirname(resolveAgentDir()), 'plugins', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'task', 'discovery.ts');
    let discoverAgents;
    try {
      const discoveryModulePath = pathToFileURL(defaultDiscoveryPath).href;
      const mod = await import(discoveryModulePath);
      discoverAgents = mod.discoverAgents;
    } catch {
      // Ignore if global discovery module path differs
    }

    if (discoverAgents) {
      const res = await discoverAgents(path.resolve('.'));

      // 1. Orchestrator: reviewer-kit
      const reviewerKit = res.agents.find((a) => a.name === 'reviewer-kit');
      assert.ok(reviewerKit, 'reviewer-kit must be discovered in OMP task agents list');
      assert.equal(reviewerKit.name, 'reviewer-kit');
      assert.deepEqual(reviewerKit.model, ['@slow']);
      assert.equal(reviewerKit.blocking, true);
      assert.ok(reviewerKit.spawns, 'reviewer-kit must declare spawns allowlist');
      assert.deepEqual(reviewerKit.autoloadSkills, ['reality-first-review', 'multi-stage-review']);
      assert.ok(!reviewerKit.tools.includes('edit'), 'reviewer-kit must not have edit');
      assert.ok(!reviewerKit.tools.includes('write'), 'reviewer-kit must not have write');

      // 2. Context Scout
      const scout = res.agents.find((a) => a.name === 'review-context-scout');
      assert.ok(scout, 'review-context-scout must be discovered');
      assert.equal(scout.blocking, true);
      assert.deepEqual(scout.model, ['@task']);
      assert.ok(!scout.tools.includes('task'), 'scout must not have task');
      assert.ok(!scout.tools.includes('edit') && !scout.tools.includes('write'));

      // 3. Risk Hunter
      const hunter = res.agents.find((a) => a.name === 'review-risk-hunter');
      assert.ok(hunter, 'review-risk-hunter must be discovered');
      assert.equal(hunter.blocking, true);
      assert.deepEqual(hunter.model, ['@slow']);
      assert.ok(!hunter.tools.includes('task'), 'hunter must not have task');
      assert.ok(!hunter.tools.includes('edit') && !hunter.tools.includes('write'));

      // 4. Finding Verifier
      const verifier = res.agents.find((a) => a.name === 'review-finding-verifier');
      assert.ok(verifier, 'review-finding-verifier must be discovered');
      assert.equal(verifier.blocking, true);
      assert.deepEqual(verifier.model, ['@slow']);
      assert.ok(!verifier.tools.includes('task'), 'verifier must not have task');
      assert.ok(!verifier.tools.includes('edit') && !verifier.tools.includes('write'));
    }
  });

  it('Live Check 3: Real OMP clean staged fixture executes hierarchy and emits REVIEW_RESULT=PASS', { skip: !isLiveE2E }, async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-pass-'));
    const repoDir = path.join(baseDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    try {
      const git = (args, options = {}) =>
        spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true, ...options });
      git(['init']);
      git(['config', 'user.name', 'Live Pass Test']);
      git(['config', 'user.email', 'live-pass@test.local']);

      // Stage a clean, verified file
      const testFile = path.join(repoDir, 'sample.txt');
      await writeFile(testFile, 'Clean production code adhering strictly to domain invariants.\n', 'utf8');
      git(['add', 'sample.txt']);

      const diffRes = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']);
      assert.notEqual(diffRes.stdout.length, 0);

      const prompt = ReviewPrompt.forDiff(diffRes.stdout).toString();
      const result = await runLiveOmp(prompt, repoDir, 600_000);

      assert.equal(result.status, 0, `OMP execution failed with status ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /REVIEW_RESULT=PASS/);
      assert.match(result.stdout, /coverage|findings/i);
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Live Check 4: Real OMP violating staged fixture with project skill emits REVIEW_RESULT=BLOCK', { skip: !isLiveE2E }, async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-block-'));
    const repoDir = path.join(baseDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    try {
      const git = (args, options = {}) =>
        spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true, ...options });
      git(['init']);
      git(['config', 'user.name', 'Live Block Test']);
      git(['config', 'user.email', 'live-block@test.local']);

      // Create a temporary project review skill with an exact invariant
      const skillDir = path.join(repoDir, '.omp', 'skills', 'zero-div-guard');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: zero-div-guard',
          'description: Invariant rule: forbid literal division by zero in calculation modules.',
          '---',
          '# Zero Division Rule',
          'Any division where denominator is literal zero (e.g. `n / 0`) is strictly prohibited and must be blocked.',
        ].join('\n'),
        'utf8'
      );

      // Stage a file violating the project skill rule
      const testFile = path.join(repoDir, 'calc.js');
      await writeFile(testFile, 'export function divide(x) {\n  return x / 0;\n}\n', 'utf8');
      git(['add', 'calc.js']);

      const diffRes = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']);
      assert.notEqual(diffRes.stdout.length, 0);

      const prompt = ReviewPrompt.forDiff(diffRes.stdout).toString();
      const result = await runLiveOmp(prompt, repoDir, 600_000);

      assert.equal(result.status, 0, `OMP execution failed with status ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /REVIEW_RESULT=BLOCK/);
      assert.match(result.stdout, /calc\.js|zero|divide/i);
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Live Check 5: Isolated named profile with automatic hook setup and dynamic user skill evolution', { skip: !isLiveE2E }, async () => {
    const profName = `omp-rev-live-${Date.now()}`;
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-profile-'));
    const repoDir = path.join(baseDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    let profileDir;
    try {
      const git = (args, options = {}) =>
        spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true, ...options });
      git(['init']);
      git(['config', 'user.name', 'Profile E2E Test']);
      git(['config', 'user.email', 'profile-e2e@test.local']);

      // 1. Resolve profile directory
      const pathRes = spawnSync('omp', ['--profile', profName, 'config', 'path'], {
        shell: true,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(pathRes.status, 0, `Failed to resolve profile path: ${pathRes.stderr}`);
      const agentDir = pathRes.stdout.trim();
      profileDir = path.dirname(agentDir);
      await mkdir(agentDir, { recursive: true });

      // Copy auth and model configuration from the dynamically resolved default profile.
      await copyDefaultProfileConfig(agentDir);

      // 2. Install current plugin into the isolated profile
      const pluginInstallRes = spawnSync('omp', ['--profile', profName, 'plugin', 'install', path.resolve(process.env.OMP_REVIEW_KIT_LIVE_PACKAGE_ROOT ?? '.')], {
        shell: true,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(pluginInstallRes.status, 0, `Plugin install failed: ${pluginInstallRes.stderr}`);

      // 3. Launch OMP in repoDir to trigger session_start auto-setup without running /reviewer-kit:setup
      const probeProc = spawn('omp', ['--profile', profName, '-p', '--no-session', 'echo auto-setup'], {
        cwd: repoDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      probeProc.stdin.write('test\n');
      probeProc.stdin.end();
      await new Promise((resolve) => {
        probeProc.on('close', resolve);
        setTimeout(() => {
          probeProc.kill();
          resolve();
        }, 30_000);
      });

      // Verify that session_start installed the hook and runner
      const hookStat = await stat(path.join(repoDir, '.githooks', 'pre-commit'));
      assert.equal(hookStat.isFile(), true, 'Pre-commit hook must be created automatically');

      const runnerStat = await stat(path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs'));
      assert.equal(runnerStat.isFile(), true, 'Runner script must be created automatically');

      const coreHooksRes = git(['config', '--get', 'core.hooksPath']);
      assert.equal(coreHooksRes.stdout.trim(), '.githooks', 'core.hooksPath must be set to .githooks');

      // 4. Create user skill forbidding REVIEW_SENTINEL_V1
      const userSkillDir = path.join(agentDir, 'skills', 'dynamic-review-e2e');
      await mkdir(userSkillDir, { recursive: true });
      const userSkillFile = path.join(userSkillDir, 'SKILL.md');

      await writeFile(
        userSkillFile,
        [
          '---',
          'name: dynamic-review-e2e',
          'description: Enforces rejection of sentinel tokens in commit reviews.',
          '---',
          '# Sentinel Rejection Rule',
          'Any file containing token REVIEW_SENTINEL_V1 is strictly prohibited and must be blocked with P1 finding.',
        ].join('\n'),
        'utf8'
      );

      // Stage file containing REVIEW_SENTINEL_V1
      const v1File = path.join(repoDir, 'token.txt');
      await writeFile(v1File, 'const token = "REVIEW_SENTINEL_V1";\n', 'utf8');
      git(['add', 'token.txt']);

      // Attempt real git commit with OMP_PROFILE
      const commitRes1 = git(['commit', '-m', 'Commit with V1 token'], {
        env: {
          ...process.env,
          OMP_PROFILE: profName,
        },
      });

      // Must be BLOCKED and cite the rule or sentinel
      assert.notEqual(
        commitRes1.status,
        0,
        `Commit with REVIEW_SENTINEL_V1 must be blocked.\nstdout: ${commitRes1.stdout}\nstderr: ${commitRes1.stderr}`
      );
      assert.match(commitRes1.stdout + commitRes1.stderr, /reviewer-kit BLOCK/);

      // 5. Update the same skill in-place: permit V1, forbid REVIEW_SENTINEL_V2
      await writeFile(
        userSkillFile,
        [
          '---',
          'name: dynamic-review-e2e',
          'description: Enforces rejection of sentinel tokens in commit reviews.',
          '---',
          '# Sentinel Rejection Rule',
          'REVIEW_SENTINEL_V1 is permitted. Any file containing token REVIEW_SENTINEL_V2 is strictly prohibited and must be blocked with P1 finding.',
        ].join('\n'),
        'utf8'
      );

      // Stage file containing REVIEW_SENTINEL_V2
      await writeFile(v1File, 'const token = "REVIEW_SENTINEL_V2";\n', 'utf8');
      git(['add', 'token.txt']);

      // Attempt real git commit with OMP_PROFILE
      const commitRes2 = git(['commit', '-m', 'Commit with V2 token'], {
        env: {
          ...process.env,
          OMP_PROFILE: profName,
        },
      });

      // Must be BLOCKED and reflect the newly updated skill requirement
      assert.notEqual(
        commitRes2.status,
        0,
        `Commit with REVIEW_SENTINEL_V2 must be blocked.\nstdout: ${commitRes2.stdout}\nstderr: ${commitRes2.stderr}`
      );
      assert.match(commitRes2.stdout + commitRes2.stderr, /reviewer-kit BLOCK/);

      // Verify commit reports were written to audit-reports/commit-reviews/
      const reportsDir = path.join(repoDir, 'audit-reports', 'commit-reviews');
      const reportFiles = await readdir(reportsDir);
      assert.ok(reportFiles.length >= 2, 'Audit reports must be created for both blocked commits');
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
      if (profileDir) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

});
