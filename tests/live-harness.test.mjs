import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  writeSessionedOmpWrapper,
  patchArtifactSpillThreshold,
  DEFAULT_EVIDENCE_PATTERN,
  INFRA_RETRY_PATTERN,
} from './live-e2e-omp.test.mjs';

function resolveNodeExecutable() {
  if (process.platform === 'win32') {
    const resolved = spawnSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true });
    const candidates = (resolved.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (candidates.length > 0) return candidates[0];
  }
  return process.execPath;
}

function resolveShExecutable() {
  if (process.platform !== 'win32') {
    return 'sh';
  }
  const gitWhere = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true });
  const gitPaths = (gitWhere.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  for (const gitPath of gitPaths) {
    const candidate = path.resolve(path.dirname(gitPath), '..', 'bin', 'sh.exe');
    if (existsSync(candidate)) return candidate;
  }
  const fallback = 'C:\\Program Files\\Git\\bin\\sh.exe';
  if (existsSync(fallback)) return fallback;
  return null;
}

const ARGV_MATRIX = [
  {
    name: 'strips bare trailing --no-session',
    input: ['--model', 'foo', '--no-session'],
    expected: ['--model', 'foo'],
  },
  {
    name: 'strips bare leading --no-session',
    input: ['--no-session', '--model', 'foo'],
    expected: ['--model', 'foo'],
  },
  {
    name: 'strips bare mid --no-session',
    input: ['-p', '--model', '@slow', '--no-session', 'some prompt'],
    expected: ['-p', '--model', '@slow', 'some prompt'],
  },
  {
    name: 'preserves comma in --tools task,read',
    input: ['--tools', 'task,read'],
    expected: ['--tools', 'task,read'],
  },
  {
    name: 'preserves comma and strips mid --no-session in complex invocation',
    input: ['-p', '--model', '@slow', '--tools', 'task,read', '--no-session'],
    expected: ['-p', '--model', '@slow', '--tools', 'task,read'],
  },
];

describe('Feature: Live E2E Sessioned OMP Wrapper Shims', () => {
  it('.cmd shim strips bare trailing/mid --no-session and preserves --tools task,read comma', { skip: process.platform !== 'win32' }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'omp-cmd-lock-'));
    const nodePath = resolveNodeExecutable();
    try {
      const echoScript = path.join(dir, 'echo-argv.mjs');
      await writeFile(echoScript, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');

      const echoFakeCmd = path.join(dir, 'echo-fake.cmd');
      await writeFile(echoFakeCmd, [
        '@echo off',
        `"${nodePath}" "${echoScript}" %*`,
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'), 'utf8');

      const wrapper = await writeSessionedOmpWrapper(dir, echoFakeCmd, { platform: 'win32' });

      for (const testCase of ARGV_MATRIX) {
        const res = spawnSync('cmd.exe', ['/c', wrapper, ...testCase.input], {
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(res.status, 0, `Command failed for ${testCase.name}: ${res.stderr}`);
        const parsed = JSON.parse(res.stdout.trim());
        assert.deepEqual(parsed, testCase.expected, `Failed on ${testCase.name}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  const shExecutable = resolveShExecutable();
  it('POSIX .sh shim strips bare trailing/mid --no-session and preserves --tools task,read comma via git-bash / sh', { skip: !shExecutable }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'omp-sh-lock-'));
    const nodePath = resolveNodeExecutable().replace(/\\/g, '/');
    try {
      const echoScript = path.join(dir, 'echo-argv.mjs').replace(/\\/g, '/');
      await writeFile(echoScript, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');

      const echoFakeSh = path.join(dir, 'echo-fake.sh').replace(/\\/g, '/');
      await writeFile(echoFakeSh, [
        '#!/bin/sh',
        `"${nodePath}" "${echoScript}" "$@"`,
        '',
      ].join('\n'), 'utf8');
      await chmod(echoFakeSh, 0o755);

      const wrapper = await writeSessionedOmpWrapper(dir, echoFakeSh, { platform: 'posix' });

      for (const testCase of ARGV_MATRIX) {
        const res = spawnSync(shExecutable, [wrapper, ...testCase.input], {
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(res.status, 0, `Command failed for ${testCase.name}: ${res.stderr}`);
        const parsed = JSON.parse(res.stdout.trim());
        assert.deepEqual(parsed, testCase.expected, `Failed on ${testCase.name}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('Feature: Artifact Spill Threshold Config Patcher', () => {
  it('replaces existing artifactSpillThreshold with relaxed limit', () => {
    const config = [
      'tools:',
      '  artifactSpillThreshold: 15',
      '  artifactTailBytes: 8',
      '',
    ].join('\n');
    const patched = patchArtifactSpillThreshold(config, 1024);
    assert.equal(patched, [
      'tools:',
      '  artifactSpillThreshold: 1024',
      '  artifactTailBytes: 8',
      '',
    ].join('\n'));
  });

  it('appends tools section with artifactSpillThreshold when absent', () => {
    const config = [
      'modelRoles:',
      '  default: devin/swe-2:max',
      '',
    ].join('\n');
    const patched = patchArtifactSpillThreshold(config, 1024);
    assert.equal(patched, [
      'modelRoles:',
      '  default: devin/swe-2:max',
      'tools:',
      '  artifactSpillThreshold: 1024',
      '',
    ].join('\n'));
  });

  it('preserves custom threshold when specified', () => {
    const config = 'tools:\n  artifactSpillThreshold: 20\n';
    const patched = patchArtifactSpillThreshold(config, 2048);
    assert.equal(patched, 'tools:\n  artifactSpillThreshold: 2048\n');
  });
});

describe('Feature: Native Review Finding Evidence Regex', () => {
  it('accepts positive phrasing: adds no product capability', () => {
    const phrase = 'The proposed wrapper adds no product capability beyond WorkflowService.advance';
    assert.ok(DEFAULT_EVIDENCE_PATTERN.test(phrase));
  });

  it('accepts positive phrasing: only wraps without domain logic', () => {
    const phrase = 'This implementation only wraps existing subprocess calls without new domain logic';
    assert.ok(DEFAULT_EVIDENCE_PATTERN.test(phrase));
  });

  it('accepts positive phrasing: tautological assertion true by construction', () => {
    const phrase = 'The test assertion is tautological and true by construction, so it can never fail';
    assert.ok(DEFAULT_EVIDENCE_PATTERN.test(phrase));
  });

  it('rejects vacuous sample: generic approval phrase', () => {
    const phrase = 'Code looks good, ready to merge';
    assert.ok(!DEFAULT_EVIDENCE_PATTERN.test(phrase));
  });

  it('rejects vacuous sample: generic refactoring description', () => {
    const phrase = 'Refactored variable names for clarity and performance';
    assert.ok(!DEFAULT_EVIDENCE_PATTERN.test(phrase));
  });
});

describe('Feature: Infra Failure Detection Pattern', () => {
  it('matches rate-limiting 429 and quota exhaustion signatures', () => {
    assert.ok(INFRA_RETRY_PATTERN.test('HTTP 429 Too Many Requests: quota exhausted'));
    assert.ok(INFRA_RETRY_PATTERN.test('RESOURCE_EXHAUSTED: daily limit reached'));
  });

  it('matches network disconnect and process timeout signatures', () => {
    assert.ok(INFRA_RETRY_PATTERN.test('fetch failed: socket connection was closed'));
    assert.ok(INFRA_RETRY_PATTERN.test('Live OMP process timed out after 600000ms'));
    assert.ok(INFRA_RETRY_PATTERN.test('Request timed out waiting for backend stream'));
  });

  it('rejects review verdict blocks and normal test assertions', () => {
    assert.ok(!INFRA_RETRY_PATTERN.test('reviewer-kit BLOCK: rejected staged changes'));
    assert.ok(!INFRA_RETRY_PATTERN.test('AssertionError [ERR_ASSERTION]: Expected PASS'));
    assert.ok(!INFRA_RETRY_PATTERN.test('reviewer-kit PASS: clean changes approved'));
    assert.ok(!INFRA_RETRY_PATTERN.test('SyntaxError: Unexpected token'));
  });
});
