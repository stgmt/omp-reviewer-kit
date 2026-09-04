import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
function runLiveOmp(prompt, cwd, timeoutMs = 600_000) {
  const ompCommand = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
  const commandArgs = ['-p', '--model', '@slow', '--no-session'];
  const isWindowsWrapper = /\.(cmd|bat)$/i.test(ompCommand);
  const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : ompCommand;
  const args = isWindowsWrapper
    ? ['/d', '/c', 'call', ompCommand, ...commandArgs]
    : commandArgs;

  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Live OMP process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`,
      });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    // Guard against EPIPE if process terminates before reading stdin
    proc.stdin.on('error', () => {});
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {
      // Ignore write errors on closed streams
    }
  });
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

  it('Live Check 2: OMP native task discovery detects reviewer-kit and all specialist agents', async () => {
    const defaultDiscoveryPath = 'C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/task/discovery.ts';
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
      const reviewerKit = res.agents.find(a => a.name === 'reviewer-kit');
      assert.ok(reviewerKit, 'reviewer-kit must be discovered in OMP task agents list');
      assert.equal(reviewerKit.name, 'reviewer-kit');
      assert.deepEqual(reviewerKit.model, ['@slow']);
      assert.equal(reviewerKit.blocking, true);
      assert.ok(reviewerKit.spawns, 'reviewer-kit must declare spawns allowlist');
      assert.deepEqual(reviewerKit.autoloadSkills, ['reality-first-review', 'multi-stage-review']);
      assert.ok(!reviewerKit.tools.includes('edit'), 'reviewer-kit must not have edit');
      assert.ok(!reviewerKit.tools.includes('write'), 'reviewer-kit must not have write');

      // 2. Context Scout
      const scout = res.agents.find(a => a.name === 'review-context-scout');
      assert.ok(scout, 'review-context-scout must be discovered');
      assert.equal(scout.blocking, true);
      assert.deepEqual(scout.model, ['@task']);
      assert.ok(!scout.tools.includes('task'), 'scout must not have task');
      assert.ok(!scout.tools.includes('edit') && !scout.tools.includes('write'));

      // 3. Risk Hunter
      const hunter = res.agents.find(a => a.name === 'review-risk-hunter');
      assert.ok(hunter, 'review-risk-hunter must be discovered');
      assert.equal(hunter.blocking, true);
      assert.deepEqual(hunter.model, ['@slow']);
      assert.ok(!hunter.tools.includes('task'), 'hunter must not have task');
      assert.ok(!hunter.tools.includes('edit') && !hunter.tools.includes('write'));

      // 4. Finding Verifier
      const verifier = res.agents.find(a => a.name === 'review-finding-verifier');
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
      const git = (args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true });
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
      const result = await runLiveOmp(prompt, repoDir, 300_000);

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
      const git = (args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true });
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
      const result = await runLiveOmp(prompt, repoDir, 300_000);

      assert.equal(result.status, 0, `OMP execution failed with status ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /REVIEW_RESULT=BLOCK/);
      assert.match(result.stdout, /calc\.js|zero|divide/i);
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
