// Given/When/Then over the run record store: where records live, how one is written atomically,
// what a reader accepts and what it silently drops. Nothing here reaches the network or the user's
// real folders: every case uses a temporary runs directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isRunAlive,
  latestRunRecord,
  pruneRuns,
  readRunRecord,
  readRunRecords,
  runRecordFile,
  runsRootDir,
  writeRunRecord,
} from '../src/infra/review-run-store.mjs';
import { RUN_SCHEMA } from '../src/domain/review-run-summary.mjs';

async function withRuns(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-runs-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function record(overrides = {}) {
  return {
    schema: 'review-run-record@2',
    runId: '2026-11-01T09-12-33-120Z-aaaaaa',
    state: 'passed',
    verdict: 'PASS',
    startedAt: '2026-11-01T09:12:33.120Z',
    durationMs: 252_340,
    repoRoot: 'E:/repos/x',
    ...overrides,
  };
}

test('Given no override, When the runs root is resolved, Then it is one folder per user outside every repository', () => {
  const dir = runsRootDir({ env: {}, home: 'C:/Users/somebody' });
  assert.equal(dir, path.join('C:/Users/somebody', '.omp', 'review-kit-runs'));
});

test('Given an override, When the runs root is resolved, Then it is absolute and used as given', () => {
  const dir = runsRootDir({ env: { OMP_REVIEW_KIT_RUNS_DIR: './tmp/runs' }, home: 'C:/Users/somebody' });
  assert.equal(dir, path.resolve('tmp/runs'));
});

test('Given a run id that could escape the folder, When its file is named, Then it is refused', () => {
  assert.throws(() => runRecordFile('C:/runs', '../secrets'));
  assert.throws(() => runRecordFile('C:/runs', 'a/b'));
  assert.throws(() => runRecordFile('C:/runs', ''));
  assert.equal(runRecordFile('C:/runs', 'runs-1'), path.join('C:/runs', 'runs-1.json'));
});

test('Given a record, When it is written, Then the file holds it and no temporary file is left behind', async () => {
  await withRuns(async dir => {
    const file = await writeRunRecord(record(), { dir });
    const names = await readdir(dir);
    assert.deepEqual(names, [path.basename(file)]);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.runId, '2026-11-01T09-12-33-120Z-aaaaaa');
    assert.equal(stored.schema, 'review-run-record@2');
  });
});

test('Given a foreign or broken file, When it is read, Then it is absent instead of half-trusted', async () => {
  await withRuns(async dir => {
    const legacy = path.join(dir, 'legacy.json');
    await writeFile(legacy, JSON.stringify({ schema: 'review-run-record@1', runId: 'legacy', durationMs: 1 }));
    assert.equal(await readRunRecord(legacy), null, 'no legacy fallback');

    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{"schema": "review-run-record@2", ');
    assert.equal(await readRunRecord(broken), null);

    assert.equal(await readRunRecord(path.join(dir, 'missing.json')), null);
  });
});

test('Given several records, When they are listed, Then they come newest first, one repository can be selected and unknown files are skipped', async () => {
  await withRuns(async dir => {
    await writeRunRecord(record({ runId: 'run-old', startedAt: '2026-10-01T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'run-new', startedAt: '2026-11-01T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'run-other', startedAt: '2026-10-15T00:00:00.000Z', repoRoot: 'E:/repos/other' }), { dir });
    await writeFile(path.join(dir, 'notes.txt'), 'not a record');

    const all = await readRunRecords({ dir });
    assert.deepEqual(all.map(entry => entry.runId), ['run-new', 'run-other', 'run-old']);
    assert.deepEqual((await readRunRecords({ dir, limit: 2 })).map(entry => entry.runId), ['run-new', 'run-other']);

    const filtered = await readRunRecords({ dir, repoRoot: 'E:/repos/x' });
    assert.deepEqual(filtered.map(entry => entry.runId), ['run-new', 'run-old']);
    assert.equal((await latestRunRecord({ dir })).runId, 'run-new');
  });
});

test('Given records that name no repository, When one repository is selected, Then they stay out and nothing throws', async () => {
  await withRuns(async dir => {
    await writeRunRecord(record({ runId: 'run-named' }), { dir });
    // A record without a repository cannot be attributed to one: it must never satisfy a filter and
    // must never make the reader throw, and a filter that is not a path matches nothing at all.
    await writeRunRecord(record({ runId: 'run-anonymous', repoRoot: undefined, startedAt: '2026-10-20T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'run-blank', repoRoot: '   ', startedAt: '2026-10-21T00:00:00.000Z' }), { dir });

    assert.deepEqual((await readRunRecords({ dir, repoRoot: 'E:/repos/x' })).map(entry => entry.runId), ['run-named']);
    assert.deepEqual(await readRunRecords({ dir, repoRoot: 42 }), [], 'a filter that is not a path matches nothing');
    assert.equal((await readRunRecords({ dir, repoRoot: null })).length, 3, 'no filter still lists every record');
  });
});

test('Given no runs folder at all, When it is listed, Then the answer is empty rather than an error', async () => {
  const dir = path.join(tmpdir(), `absent-runs-${Date.now()}`);
  assert.deepEqual(await readRunRecords({ dir }), []);
  assert.equal(await pruneRuns({ dir }), 0);
});

test('Given more records than the limit, When retention runs, Then the oldest go and the newest and a live run stay', async () => {
  await withRuns(async dir => {
    for (let index = 0; index < 5; index += 1) {
      await writeRunRecord(record({ runId: `run-${index}`, startedAt: `2026-10-0${index + 1}T00:00:00.000Z` }), { dir });
    }
    await writeRunRecord(record({ runId: 'run-live', state: 'running', startedAt: '2026-09-30T00:00:00.000Z', runnerPid: process.pid }), { dir });

    const removed = await pruneRuns({ dir, keep: 2, keepDays: 3650 });
    assert.equal(removed, 3);
    const left = (await readRunRecords({ dir })).map(entry => entry.runId);
    assert.equal(left.includes('run-live'), true, 'a running record is never pruned');
    assert.equal(left.includes('run-4'), true, 'the newest record is never pruned');
    assert.equal(left.length, 3);
  });
});

test('Given an old record, When retention runs with a day window, Then it is pruned even under the count limit', async () => {
  await withRuns(async dir => {
    await writeRunRecord(record({ runId: 'run-newest', startedAt: '2026-11-01T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'run-stale', startedAt: '2026-01-01T00:00:00.000Z' }), { dir });
    const removed = await pruneRuns({ dir, keep: 200, keepDays: 30, now: Date.parse('2026-11-01T00:00:00.000Z') });
    assert.equal(removed, 1);
    assert.deepEqual((await readRunRecords({ dir })).map(entry => entry.runId), ['run-newest']);
  });
});

test('Given a record whose runner is gone, When liveness is asked, Then it is not alive; a running record with a live pid is', () => {
  const dead = () => {
    const error = new Error('no such process');
    error.code = 'ESRCH';
    throw error;
  };
  assert.equal(isRunAlive({ state: 'running', runnerPid: 4242 }, { kill: dead }), false);
  assert.equal(isRunAlive({ state: 'running', runnerPid: 4242 }, { kill: () => true }), true);
  assert.equal(isRunAlive({ state: 'passed', runnerPid: process.pid }), false, 'a settled run is never alive');
  assert.equal(isRunAlive({ state: 'running' }), false, 'a record without a pid cannot claim liveness');

  const denied = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(isRunAlive({ state: 'running', runnerPid: 1 }, { kill: denied }), true, 'a foreign process still exists');
});

test('Given a newest record older than the window, When retention runs, Then the newest record is still kept', async () => {
  await withRuns(async dir => {
    await writeRunRecord(record({ runId: 'old-newest', startedAt: '2026-01-01T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'older', startedAt: '2025-12-01T00:00:00.000Z' }), { dir });
    const removed = await pruneRuns({ dir, keep: 0, keepDays: 30, now: Date.parse('2026-11-01T00:00:00.000Z') });
    assert.equal(removed, 1);
    assert.deepEqual((await readRunRecords({ dir })).map(entry => entry.runId), ['old-newest']);
  });
});

test('Given a record file that cannot be parsed, When retention runs, Then the file is left alone and the readable ones still prune', async () => {
  await withRuns(async dir => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'broken.json'), 'not json');
    await writeRunRecord(record({ runId: 'run-old', startedAt: '2026-01-01T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'run-new', startedAt: '2026-11-01T00:00:00.000Z' }), { dir });
    const removed = await pruneRuns({ dir, keep: 1, keepDays: 30, now: Date.parse('2026-11-01T00:00:00.000Z') });
    assert.equal(removed, 1);
    assert.deepEqual((await readdir(dir)).sort(), ['broken.json', 'run-new.json']);
  });
});

test('Given a rename that fails once with EBUSY, When the record is written, Then the write is retried, the record is readable and no temporary file remains', async () => {
  await withRuns(async dir => {
    let attempts = 0;
    const renameFile = async (from, to) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('busy');
        error.code = 'EBUSY';
        throw error;
      }
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    };
    const file = await writeRunRecord({ runId: 'retry-1', schema: RUN_SCHEMA, startedAt: '2026-11-01T00:00:00.000Z' }, { dir, renameFile });
    assert.equal(attempts, 2);
    assert.equal((await readRunRecord(file)).runId, 'retry-1');
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), []);
  });
});

test('Given two writes of one record at once, When both run, Then both land and no temporary file is left behind', async () => {
  await withRuns(async dir => {
    const record = { runId: 'twice', schema: RUN_SCHEMA, startedAt: '2026-11-01T00:00:00.000Z' };
    await Promise.all([writeRunRecord(record, { dir }), writeRunRecord(record, { dir })]);
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), []);
    assert.equal((await readRunRecord(path.join(dir, 'twice.json'))).runId, 'twice');
  });
});
