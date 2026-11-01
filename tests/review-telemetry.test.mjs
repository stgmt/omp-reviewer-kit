// Given/When/Then over the bridge from OMP's native task result to one run record. Every case uses
// a temporary runs folder; no case needs a model, a network or the owner's configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildRunRecord,
  createRunId,
  createRunRecorder,
  formatStageEvent,
  recordStages,
} from '../src/native/review-telemetry.mjs';
import { readRunRecord } from '../src/infra/review-run-store.mjs';

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-telemetry-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function result(overrides = {}) {
  return {
    staged: true,
    diffHash: 'ab'.repeat(32),
    profile: 'full',
    lanes: ['correctness'],
    changedPaths: ['src/a.mjs'],
    provenance: { role: 'task', model: 'resolved-model' },
    fallback: { applied: false, requested: null },
    stages: [
      {
        agent: 'review-context-scout',
        exitCode: 0,
        aborted: false,
        structuredStatus: 'valid',
        role: 'task',
        model: 'resolved-model',
        durationMs: 62_000,
        tokens: 18_000,
        requests: 12,
        counts: { behaviors: 5 },
      },
    ],
    verdict: { pass: true, verdict: 'PASS', reasons: [] },
    runSummary: {
      durationMs: 252_340,
      reviewer: { durationMs: 251_000, tokens: 410_000, requests: 38, sessionFile: 'C:/s/Review.jsonl' },
      timings: { snapshotMs: 1_200, nativeTaskMs: 251_000, verdictMs: 40 },
    },
    ...overrides,
  };
}

test('Given a start time, When a run id is created, Then it sorts by time and carries a random tail', () => {
  const at = Date.parse('2026-11-01T09:12:33.120Z');
  const first = createRunId(at, { random: () => 'aaaaaa' });
  const second = createRunId(at + 1, { random: () => 'bbbbbb' });
  assert.equal(first, '2026-11-01T09-12-33-120Z-aaaaaa');
  assert.ok(first < second, 'ids of later runs sort after earlier ones');
});

test('Given a live stage event, When it is formatted, Then the log names the stage, its lane and its numbers', () => {
  assert.equal(
    formatStageEvent({ agent: 'review-risk-hunter', lane: 'correctness', status: 'completed', durationMs: 130_000, tokens: 61_000, requests: 19 }),
    'review: stage review-risk-hunter lane=correctness completed (2m10s, 61k tok, 19 req)',
  );
  assert.equal(formatStageEvent({ agent: 'review-finding-verifier', status: 'running' }), 'review: stage review-finding-verifier running');
});

test('Given a native stage with a structured payload, When the record stage is built, Then it keeps counts and drops the payload', () => {
  const [stage] = recordStages([{ agent: 'review-risk-hunter', exitCode: 0, structuredStatus: 'valid', data: { candidates: [{}], coverage_gaps: [{}, {}], note: 'private text' } }]);
  assert.equal(stage.status, 'completed');
  assert.deepEqual(stage.counts, { candidates: 1, coverage_gaps: 2 });
  assert.equal(JSON.stringify(stage).includes('private text'), false);
});

test('Given a finished review, When the record is built, Then state, verdict and every timing are carried over', () => {
  const record = buildRunRecord({
    runId: 'run-1',
    record: { startedAt: '2026-11-01T09:12:33.120Z', repoRoot: 'E:/repos/x' },
    result: result(),
    reportPath: 'C:/reports/x.md',
    reportMs: 15,
    finishedAt: '2026-11-01T09:16:45.460Z',
    durationMs: 252_340,
  });
  assert.equal(record.state, 'passed');
  assert.equal(record.verdict, 'PASS');
  assert.equal(record.durationMs, 252_340);
  assert.equal(record.reviewer.tokens, 410_000);
  assert.equal(record.timings.reportMs, 15);
  assert.equal(record.changedPaths, 1);
  assert.equal(record.reportPath, 'C:/reports/x.md');
});

test('Given a review that never reached a verdict, When the record is built, Then it is skipped or failed, never passed', () => {
  const skipped = buildRunRecord({
    runId: 'run-2',
    record: {},
    result: { staged: false, runSummary: { timings: { snapshotMs: 9 } } },
    finishedAt: '2026-11-01T09:16:45.460Z',
    durationMs: 10,
  });
  assert.equal(skipped.state, 'skipped');
  assert.equal(skipped.verdict, null);
  const failed = buildRunRecord({ runId: 'run-3', record: {}, result: {}, finishedAt: '2026-11-01T09:16:45.460Z', durationMs: 10 });
  assert.equal(failed.state, 'failed');
});

test('Given a recorder, When a run starts and settles, Then the file goes from running to the final verdict and stays outside the repository', async () => {
  await withDir(async dir => {
    const recorder = createRunRecorder({ repo: path.join(dir, 'repo'), env: { OMP_REVIEW_KIT_RUNS_DIR: dir }, kitVersion: '0.24.0', pid: 4242 });
    const started = await recorder.start();
    const running = await readRunRecord(started);
    assert.equal(running.state, 'running');
    assert.equal(running.runnerPid, 4242);
    assert.equal(running.kitVersion, '0.24.0');
    assert.equal(path.dirname(started), dir);

    await recorder.event({ agent: 'review-context-scout', status: 'completed', durationMs: 62_000, tokens: 18_000, requests: 12 });
    const live = await readRunRecord(started);
    assert.equal(live.stages.length, 1);
    assert.equal(live.stages[0].status, 'completed');

    await recorder.complete({ result: result(), reportPath: 'C:/reports/x.md', reportMs: 15 });
    const finished = await readRunRecord(started);
    assert.equal(finished.state, 'passed');
    assert.equal(finished.reviewer.tokens, 410_000);
    assert.equal(finished.stages.length, 1);
    assert.equal(finished.stages[0].durationMs, 62_000);
    assert.equal(recorder.writeFailure, null);
  });
});

test('Given a run that throws, When the recorder records the failure, Then the record says failed and names the reason', async () => {
  await withDir(async dir => {
    const recorder = createRunRecorder({ repo: path.join(dir, 'repo'), env: { OMP_REVIEW_KIT_RUNS_DIR: dir } });
    const file = await recorder.start();
    await recorder.fail(new Error('reviewer task exit 1'));
    const record = await readRunRecord(file);
    assert.equal(record.state, 'failed');
    assert.equal(record.verdict, 'FAILED');
    assert.deepEqual(record.reasons, ['reviewer task exit 1']);
  });
});

test('Given a store that refuses every write, When the recorder runs, Then it reports the failure once and never throws', async () => {
  await withDir(async dir => {
    const recorder = createRunRecorder({
      repo: path.join(dir, 'repo'),
      env: { OMP_REVIEW_KIT_RUNS_DIR: dir },
      write: async () => {
        throw new Error('disk is a brick');
      },
    });
    await assert.doesNotReject(() => recorder.start());
    await assert.doesNotReject(() => recorder.complete({ result: result() }));
    await assert.doesNotReject(() => recorder.fail(new Error('later')));
    assert.match(recorder.writeFailure, /disk is a brick/);
    assert.deepEqual(await readdir(dir), [], 'a failed write leaves no partial file');
  });
});

test('Given a live event with no agent, When the recorder sees it, Then nothing is recorded and nothing throws', async () => {
  await withDir(async dir => {
    const recorder = createRunRecorder({ repo: path.join(dir, 'repo'), env: { OMP_REVIEW_KIT_RUNS_DIR: dir } });
    const file = await recorder.start();
    await recorder.event({});
    await recorder.event(null);
    const record = await readFile(file, 'utf8');
    assert.equal(JSON.parse(record).stages.length, 0);
  });
});

test('Given finished events and the terminal write fired without awaiting, When the record is persisted, Then writes never overlap and the settled state is the last one written', async () => {
  await withDir(async dir => {
    let active = 0;
    let maxActive = 0;
    const states = [];
    const write = async (record, { dir: target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      states.push(record.state);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return path.join(target, `${record.runId}.json`);
    };
    const recorder = createRunRecorder({
      repo: 'repo',
      env: { OMP_REVIEW_KIT_RUNS_DIR: dir },
      now: () => 1_000,
      write,
      prune: async () => {},
    });
    await recorder.start();
    const first = recorder.event({ agent: 'review-context-scout', status: 'completed', durationMs: 1_000 });
    const second = recorder.event({ agent: 'review-risk-hunter', status: 'completed', durationMs: 2_000 });
    const done = recorder.complete({ result: { staged: true, verdict: { pass: true, reasons: [] }, stages: [] } });
    await Promise.all([first, second, done]);
    assert.equal(maxActive, 1);
    assert.equal(recorder.writeFailure, null);
    // The terminal write is the last one, so no queued progress write can leave the record running.
    assert.equal(states.at(-1), 'passed');
    assert.ok(states.length >= 2);
  });
});
