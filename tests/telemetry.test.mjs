import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runReview } from '../scripts/run-review.mjs';
import {
  FileSystemTelemetryAdapter,
  NullTelemetryAdapter,
  safeRunTelemetry,
  formatProviderOutageError,
} from '../src/infra/filesystem-telemetry-adapter.mjs';

const TEST_ROLES = { smol: 'acme/smol-flash:high', task: 'acme/task-fast:high', slow: 'acme/slow-max:max' };
const testRoleResolver = () => TEST_ROLES;

async function makeRoot(prefix = 'omp-telemetry-') {
  const reportRoot = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(reportRoot, 'project');
}

function fakeGit(root, diff) {
  return (args) => {
    if (args[0] === 'rev-parse') return Buffer.from(`${root}\n`);
    if (args[0] === 'diff') return Buffer.from(diff);
    if (args[0] === 'ls-files') return Buffer.alloc(0);
    return Buffer.alloc(0);
  };
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('a PASS run persists runs.jsonl events and last-run.json state', async () => {
  const root = await makeRoot();
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff --staged-content'),
    omp: async (prompt, cwd, timeout, model, options) => {
      options?.onSpawn?.(31337);
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '', pid: 31337 };
    },
    ompOptions: { roleResolver: testRoleResolver },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 0);
  const reportsDir = path.join(root, 'audit-reports', 'commit-reviews');

  const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
  const types = events.map((event) => event.type);
  for (const expected of [
    'run_started',
    'diff_collected',
    'snapshot_materialized',
    'review_attempt_started',
    'review_attempt_finished',
    'verdict_evaluated',
    'report_written',
    'run_finished',
  ]) {
    assert.ok(types.includes(expected), `missing event ${expected} in ${types.join(',')}`);
  }

  const started = events.find((event) => event.type === 'run_started');
  assert.equal(started.schema, 'review-run-event@1');
  assert.equal(started.repoRoot, root);
  const attemptStarted = events.find((event) => event.type === 'review_attempt_started');
  assert.equal(attemptStarted.pid, 31337);
  const finished = events.find((event) => event.type === 'run_finished');
  assert.equal(finished.verdict, 'PASS');
  assert.equal(finished.exitCode, 0);
  assert.ok(Number.isFinite(finished.durationMs));
  assert.ok(finished.ompLogHints.some((hint) => hint.includes('31337')));

  const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
  assert.equal(lastRun.schema, 'review-last-run@1');
  assert.equal(lastRun.state, 'passed');
  assert.equal(lastRun.verdict, 'PASS');
  assert.equal(lastRun.exitCode, 0);
  assert.equal(lastRun.reportPath, result.reportPath);
  assert.equal(lastRun.runId, started.runId);
});

test('a BLOCK run is recorded with verdict and failure detail', async () => {
  const root = await makeRoot();
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff bad'),
    omp: async () => ({ status: 1, stdout: '', stderr: 'omp exploded' }),
    ompOptions: { roleResolver: testRoleResolver },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 1);
  const lastRun = JSON.parse(await readFile(
    path.join(root, 'audit-reports', 'commit-reviews', 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'blocked');
  assert.equal(lastRun.verdict, 'BLOCK');
});

test('a skipped run is recorded without a diff hash', async () => {
  const root = await makeRoot();
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, ''),
    omp: async () => { throw new Error('must not run'); },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.skipped, true);
  const reportsDir = path.join(root, 'audit-reports', 'commit-reviews');
  const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
  assert.ok(events.some((event) => event.type === 'run_skipped'));
  const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'skipped');
  assert.equal(lastRun.exitCode, 0);
  assert.match(lastRun.runId, /-skipped$/);
});

test('OMP_REVIEW_KIT_TELEMETRY=0 disables telemetry writes', async () => {
  const root = await makeRoot();
  const previous = process.env.OMP_REVIEW_KIT_TELEMETRY;
  process.env.OMP_REVIEW_KIT_TELEMETRY = '0';
  try {
    const result = await runReview({
      cwd: root,
      git: fakeGit(root, 'diff'),
      omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
      ompOptions: { roleResolver: testRoleResolver },
      now: new Date('2026-09-13T12:00:00.000Z'),
    });
    assert.equal(result.exitCode, 0);
    await assert.rejects(stat(path.join(root, 'audit-reports', 'commit-reviews', 'runs.jsonl')));
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_TELEMETRY;
    else process.env.OMP_REVIEW_KIT_TELEMETRY = previous;
  }
});

test('a throwing telemetry port cannot change the verdict', async () => {
  const root = await makeRoot();
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff'),
    omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    telemetry: {
      forRun() {
        return {
          record: async () => { throw new Error('disk exploded'); },
          updateLastRun: async () => { throw new Error('disk exploded'); },
        };
      },
    },
    ompOptions: { roleResolver: testRoleResolver },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 0);
});

test('a telemetry port that throws from forRun falls back to null telemetry', async () => {
  const root = await makeRoot();
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff'),
    omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    telemetry: {
      forRun() { throw new Error('no telemetry backend'); },
    },
    ompOptions: { roleResolver: testRoleResolver },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 0);
});

test('FileSystemTelemetryAdapter writes into the report directory', async () => {
  const root = await makeRoot();
  const adapter = new FileSystemTelemetryAdapter();
  const sink = adapter.forRun({ repoRoot: root, runId: 'test-run-1' });

  await sink.record('run_started', { marker: 'x' });
  await sink.updateLastRun({ state: 'reviewing', model: '@smol' }, { force: true });

  const events = await readJsonl(path.join(root, 'audit-reports', 'commit-reviews', 'runs.jsonl'));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[0].runId, 'test-run-1');
  assert.equal(events[0].marker, 'x');

  const lastRun = JSON.parse(await readFile(
    path.join(root, 'audit-reports', 'commit-reviews', 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'reviewing');
  assert.equal(lastRun.model, '@smol');
  assert.equal(lastRun.runId, 'test-run-1');
});

test('throttled last-run updates can be forced', async () => {
  const root = await makeRoot();
  const adapter = new FileSystemTelemetryAdapter();
  const sink = adapter.forRun({ repoRoot: root, runId: 'test-run-2' });

  await sink.updateLastRun({ state: 'one' }, { force: true });
  await sink.updateLastRun({ state: 'two' }); // throttled — dropped
  await sink.updateLastRun({ state: 'three' }, { force: true });

  const lastRun = JSON.parse(await readFile(
    path.join(root, 'audit-reports', 'commit-reviews', 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'three');
});

test('NullTelemetryAdapter and safeRunTelemetry absorb everything', async () => {
  const sink = new NullTelemetryAdapter().forRun({ repoRoot: '/x', runId: 'r' });
  await sink.record('run_started');
  await sink.updateLastRun({ state: 'x' }, { force: true });

  const wrapped = safeRunTelemetry({ record: 'nope', updateLastRun: undefined });
  await wrapped.record('x');
  await wrapped.updateLastRun({});

  const throwing = safeRunTelemetry({
    record: () => Promise.reject(new Error('nope')),
    updateLastRun: () => { throw new Error('nope'); },
  });
  await throwing.record('x');
  await throwing.updateLastRun({});
});

test('provider outage on every model blocks the run with actionable stderr detail', async () => {
  const root = await makeRoot();
  const calls = [];
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff'),
    omp: async (prompt, cwd, timeout, model) => {
      calls.push(model);
      return { status: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests: quota exhausted' };
    },
    ompOptions: {
      primaryModel: '@smol',
      modelsProvider: async () => ['@task'],
      modelProbe: async () => ({ status: 1, stdout: '', stderr: 'provider unavailable' }),
      roleResolver: () => ({ smol: 'acme/smol-flash:high', task: 'acme/task-fast:high' }),
    },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.deepEqual(calls, ['@smol']);
  assert.match(result.details, /infrastructure failure/);
  assert.match(result.details, /@smol -> @task/);

  const reportsDir = path.join(root, 'audit-reports', 'commit-reviews');
  const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
  const finished = events.find((event) => event.type === 'run_finished');
  assert.equal(finished.verdict, 'BLOCK');
  assert.deepEqual(finished.modelsTried, ['@smol', '@task']);
  const attemptFinished = events.find((event) => event.type === 'review_attempt_finished');
  assert.equal(attemptFinished.providerFailure, true);
  const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'blocked');
});

test('provider outage message is actionable and marker-free', () => {
  const message = formatProviderOutageError(['@smol', '@task'], 'HTTP 429 quota');
  assert.doesNotMatch(message, /REVIEW_RESULT=/);
  assert.match(message, /infrastructure failure/);
  assert.match(message, /@smol -> @task/);
  assert.match(message, /modelRoles\.smol/);
  assert.match(message, /OMP_REVIEW_KIT_FALLBACK_MODELS/);
  assert.match(message, /429 quota/);
});
