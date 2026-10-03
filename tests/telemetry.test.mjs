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
    omp: async (prompt, cwd, timeout, options) => {
      options?.onSpawn?.(31337);
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '', pid: 31337 };
    },
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
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 1);
  const lastRun = JSON.parse(await readFile(
    path.join(root, 'audit-reports', 'commit-reviews', 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'blocked');
  assert.equal(lastRun.verdict, 'BLOCK');
});

test('a new run tombstones a stale live last-run.json left by a killed review', async () => {
  const root = await makeRoot();
  const reportsDir = path.join(root, 'audit-reports', 'commit-reviews');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(reportsDir, { recursive: true });
  // A killed previous run left a live 'reviewing' state pointing at a dead pid.
  await writeFile(path.join(reportsDir, 'last-run.json'), `${JSON.stringify({
    schema: 'review-last-run@1',
    runId: '2026-09-28T00-00-00-000Z-deadbeef',
    repoRoot: root,
    updatedAt: '2026-09-28T00:10:00.000Z',
    state: 'reviewing',
    model: '@smol',
    pid: 2 ** 31 - 1,
  })}\n`, 'utf8');

  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff --staged-content'),
    omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    now: new Date('2026-09-28T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 0);
  const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
  const abandoned = events.find((event) => event.type === 'run_abandoned');
  assert.ok(abandoned, 'stale run must be tombstoned');
  assert.equal(abandoned.runId, '2026-09-28T00-00-00-000Z-deadbeef');
  assert.equal(abandoned.pid, 2 ** 31 - 1);
  assert.equal(abandoned.state, 'reviewing');
  assert.match(abandoned.error, /no finish event/i);
  // The new run still records its own trace and ends in a terminal state.
  const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'passed');
  assert.equal(lastRun.runId, events.find((event) => event.type === 'run_started').runId);
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

test('a provider outage blocks the run after one attempt with actionable stderr detail', async () => {
  const root = await makeRoot();
  const calls = [];
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff'),
    omp: async () => {
      calls.push('attempt');
      return { status: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests: quota exhausted' };
    },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.deepEqual(calls, ['attempt']);
  assert.match(result.details, /infrastructure failure/);
  assert.match(result.details, /does not choose models/);

  const reportsDir = path.join(root, 'audit-reports', 'commit-reviews');
  const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
  const finished = events.find((event) => event.type === 'run_finished');
  assert.equal(finished.verdict, 'BLOCK');
  assert.deepEqual(finished.modelsTried ?? [], []);
  const attemptFinished = events.find((event) => event.type === 'review_attempt_finished');
  assert.equal(attemptFinished.providerFailure, true);
  const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
  assert.equal(lastRun.state, 'blocked');
});

test('a failed model-less health call blocks the run in seconds without starting the review', async () => {
  const root = await makeRoot();
  let reviewCalls = 0;
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff'),
    omp: async () => {
      reviewCalls += 1;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
    ompOptions: {
      preflight: async () => ({ status: 1, stdout: '', stderr: 'Set an API key environment variable' }),
    },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(reviewCalls, 0);
  assert.match(result.details, /infrastructure failure/);
  assert.match(result.details, /Set an API key environment variable/);
  const events = await readJsonl(path.join(root, 'audit-reports', 'commit-reviews', 'runs.jsonl'));
  assert.equal(events.find((event) => event.type === 'preflight_finished').healthy, false);
  assert.equal(events.some((event) => event.type === 'review_attempt_started'), false);
});

test('a hard child crash with no output is re-run once by the distributable runner', async () => {
  const root = await makeRoot();
  let calls = 0;
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, 'diff'),
    omp: async () => {
      calls += 1;
      return calls === 1
        ? { status: 3221226505, stdout: '', stderr: '' }
        : { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
    now: new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls, 2);
});

test('provider outage message is actionable and marker-free', () => {
  const message = formatProviderOutageError('HTTP 429 quota');
  assert.doesNotMatch(message, /REVIEW_RESULT=/);
  assert.match(message, /infrastructure failure/);
  assert.match(message, /does not choose models/);
  assert.match(message, /retry\.fallbackChains/);
  assert.doesNotMatch(message, /OMP_REVIEW_KIT_(MODEL|FALLBACK_MODELS)/);
  assert.match(message, /429 quota/);
});

for (const state of ['started', 'executing', 'probing', 'reemitting']) {
  test(`a new run tombstones a stale '${state}' last-run.json identified by its dead runnerPid`, async () => {
    // Given a killed run whose live state carries no attempt pid, only the runner pid
    const root = await makeRoot();
    const reportsDir = path.join(root, 'audit-reports', 'commit-reviews');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(reportsDir, { recursive: true });
    await writeFile(path.join(reportsDir, 'last-run.json'), `${JSON.stringify({
      schema: 'review-last-run@1',
      runId: '2026-09-28T00-00-00-000Z-cafe',
      repoRoot: root,
      runnerPid: 2 ** 31 - 1,
      state,
    })}\n`, 'utf8');

    // When a new run starts
    const result = await runReview({
      cwd: root,
      git: fakeGit(root, 'diff --staged-content'),
      omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
      now: new Date('2026-09-28T12:00:00.000Z'),
    });

    // Then the stale run is tombstoned and the new run stamps its own runnerPid
    assert.equal(result.exitCode, 0);
    const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
    const abandoned = events.find((event) => event.type === 'run_abandoned');
    assert.ok(abandoned, `stale '${state}' run must be tombstoned`);
    assert.equal(abandoned.state, state);
    const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
    assert.equal(lastRun.runnerPid, process.pid);
  });
}
