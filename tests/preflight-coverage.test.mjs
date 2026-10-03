import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OmpCliReviewerAdapter } from '../src/infra/omp-cli-reviewer-adapter.mjs';

const isWindows = process.platform === 'win32';
const cwd = process.cwd();
const result = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });

for (const copy of ['../scripts/run-review.mjs', '../.omp/review-kit/run-review.mjs']) {
  test(`${copy.replace('../', '')}: a failed model-less health call blocks before the runner is invoked`, async () => {
    const { OmpCliReviewerAdapter: Adapter } = await import(copy);
    let runnerCalls = 0;
    const adapter = new Adapter({
      runner: async () => {
        runnerCalls += 1;
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
      preflight: async () => result(1, '', 'Set an API key environment variable'),
    });

    const review = await adapter.executeReview({ prompt: 'p', cwd });

    assert.equal(review.status, 1);
    assert.equal(runnerCalls, 0);
    assert.match(review.stderr, /reviewer-kit infrastructure failure/);
    assert.match(review.stderr, /does not choose models/);
  });

  test(`${copy.replace('../', '')}: a healthy health call lets the single review attempt run`, async () => {
    const { OmpCliReviewerAdapter: Adapter } = await import(copy);
    let runnerCalls = 0;
    const adapter = new Adapter({
      runner: async () => {
        runnerCalls += 1;
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
      preflight: async () => result(0, 'READY'),
    });

    const review = await adapter.executeReview({ prompt: 'p', cwd });

    assert.equal(review.status, 0);
    assert.equal(runnerCalls, 1);
  });
}

test('defaultPreflight spawns a no-tools model-less child fed the READY prompt', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-preflight-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const argsPath = path.join(baseDir, 'args.txt');
  const stdinPath = path.join(baseDir, 'stdin.txt');
  const command = isWindows
    ? '@echo off\n> "%OMP_REVIEW_TEST_ARGS%" echo %*\nmore > "%OMP_REVIEW_TEST_STDIN%"\necho READY\nexit /b 0\n'
    : '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_REVIEW_TEST_ARGS"\ncat > "$OMP_REVIEW_TEST_STDIN"\nprintf "READY\\n"\n';
  const saved = {
    command: process.env.OMP_REVIEW_KIT_OMP,
    args: process.env.OMP_REVIEW_TEST_ARGS,
    stdin: process.env.OMP_REVIEW_TEST_STDIN,
  };
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ARGS = argsPath;
  process.env.OMP_REVIEW_TEST_STDIN = stdinPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const probe = await OmpCliReviewerAdapter.defaultPreflight(cwd, 20_000);

    assert.equal(probe.status, 0, probe.stderr);
    const args = (await readFile(argsPath, 'utf8')).split(/\s+/).filter(Boolean);
    assert.ok(args.includes('--no-tools'), args.join(' '));
    assert.ok(!args.includes('--tools'));
    for (const flag of ['--model', '--smol', '--slow', '--thinking']) assert.ok(!args.includes(flag), flag);
    assert.match(await readFile(stdinPath, 'utf8'), /Respond with exactly READY/);
  } finally {
    for (const [key, name] of [['command', 'OMP_REVIEW_KIT_OMP'], ['args', 'OMP_REVIEW_TEST_ARGS'], ['stdin', 'OMP_REVIEW_TEST_STDIN']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('review_chain telemetry records the health-call timeout, or null when no health call runs', async () => {
  const chainPayload = async (options) => {
    const events = [];
    const telemetry = {
      record: async (type, payload) => events.push({ type, payload }),
      updateLastRun: async () => {},
    };
    const adapter = new OmpCliReviewerAdapter({ runner: async () => result(0, 'REVIEW_RESULT=PASS\n'), ...options });
    await adapter.executeReview({ prompt: 'p', cwd, telemetry });
    return events.find((event) => event.type === 'review_chain').payload;
  };

  assert.equal((await chainPayload({ preflight: async () => result(0, 'READY') })).preflightTimeoutMs, 90_000);
  assert.equal((await chainPayload({ preflight: async () => result(0, 'READY'), preflightTimeoutMs: 1234 })).preflightTimeoutMs, 1234);
  assert.equal((await chainPayload({})).preflightTimeoutMs, null);
});

test('analyze-review-run prints no model segment for attempts that carry no model', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-analyze-'));
  try {
    const dir = path.join(repo, 'audit-reports', 'commit-reviews');
    await mkdir(dir, { recursive: true });
    const at = '2026-10-03T00:00:00.000Z';
    const events = [
      { type: 'run_started', runId: 'r1', at },
      { type: 'review_attempt_started', runId: 'r1', at, attemptIndex: 0, pid: 111 },
      { type: 'review_attempt_finished', runId: 'r1', at, attemptIndex: 0, pid: 111, status: 0, durationMs: 5000, providerFailure: false },
      { type: 'run_finished', runId: 'r1', at, verdict: 'PASS', exitCode: 0, durationMs: 6000 },
    ];
    await writeFile(path.join(dir, 'runs.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

    const out = spawnSync(process.execPath, ['scripts/analyze-review-run.mjs', 'r1', '--repo', repo], { cwd, encoding: 'utf8' });

    assert.equal(out.status, 0, out.stderr);
    const line = out.stdout.split('\n').find((l) => l.includes('attempt #0'));
    assert.ok(line, out.stdout);
    assert.ok(!/ model /.test(line), line);
    assert.match(line, /pid 111/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('analyze-review-run reports the preflight health call with its status and duration', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-analyze-preflight-'));
  try {
    const dir = path.join(repo, 'audit-reports', 'commit-reviews');
    await mkdir(dir, { recursive: true });
    const at = '2026-10-03T00:00:00.000Z';
    const events = [
      { type: 'run_started', runId: 'r2', at },
      { type: 'preflight_started', runId: 'r2', at },
      { type: 'preflight_finished', runId: 'r2', at, status: 1, durationMs: 4300, healthy: false },
      { type: 'run_finished', runId: 'r2', at, verdict: 'BLOCK', exitCode: 1, durationMs: 4500 },
    ];
    await writeFile(path.join(dir, 'runs.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

    const out = spawnSync(process.execPath, ['scripts/analyze-review-run.mjs', 'r2', '--repo', repo], { cwd, encoding: 'utf8' });

    assert.equal(out.status, 0, out.stderr);
    const line = out.stdout.split('\n').find((l) => l.includes('preflight (OMP default role)'));
    assert.ok(line, out.stdout);
    assert.match(line, /status 1/);
    assert.match(line, /4\.3s|4300ms|4s/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a throwing preflight blocks with the infrastructure message instead of rejecting executeReview', async () => {
  let runnerCalls = 0;
  const adapter = new OmpCliReviewerAdapter({
    runner: async () => {
      runnerCalls += 1;
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
    preflight: async () => { throw new Error('preflight exploded'); },
  });

  const review = await adapter.executeReview({ prompt: 'p', cwd });

  assert.equal(review.status, 1);
  assert.equal(runnerCalls, 0);
  assert.match(review.stderr, /reviewer-kit infrastructure failure/);
  assert.match(review.stderr, /preflight exploded/);
});

test('without an injected runner or preflight the real health call runs before the real review', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-prod-path-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const countPath = path.join(baseDir, 'count.txt');
  const command = isWindows
    ? '@echo off\necho x>> "%OMP_REVIEW_TEST_COUNT%"\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\necho x >> "$OMP_REVIEW_TEST_COUNT"\nprintf "REVIEW_RESULT=PASS\n"\n';
  const saved = { command: process.env.OMP_REVIEW_KIT_OMP, count: process.env.OMP_REVIEW_TEST_COUNT };
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_COUNT = countPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await new OmpCliReviewerAdapter({}).executeReview({ prompt: 'p', cwd });

    assert.equal(review.status, 0, review.stderr);
    const invocations = (await readFile(countPath, 'utf8')).split(/\r?\n/).filter((l) => l.trim().startsWith('x')).length;
    assert.equal(invocations, 2);
    assert.equal(review.attempts.length, 1);
  } finally {
    for (const [key, name] of [['command', 'OMP_REVIEW_KIT_OMP'], ['count', 'OMP_REVIEW_TEST_COUNT']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    await rm(baseDir, { recursive: true, force: true });
  }
});
