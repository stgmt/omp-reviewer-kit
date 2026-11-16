// Given/When/Then over the read-only runs command and the follow watcher. Every case works on a
// temporary runs folder; nothing here writes a record, stops a review or needs a model.
import { test } from 'node:test';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { followRun, formatRunDetail, formatRunLine, main, parseArgs, statusReport } from '../scripts/review-runs.mjs';
import { probeRun } from '../src/infra/review-liveness-probe.mjs';
import { writeRunRecord } from '../src/infra/review-run-store.mjs';

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-runs-cli-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function record(overrides = {}) {
  return {
    schema: 'review-run-record@2',
    runId: 'run-1',
    state: 'passed',
    verdict: 'PASS',
    startedAt: '2026-11-01T09:12:33.120Z',
    durationMs: 252_340,
    repoName: 'omp-reviewer-kit',
    repoRoot: path.resolve('E:/repos/omp-reviewer-kit'),
    stages: [
      { agent: 'review-context-scout', status: 'completed', durationMs: 62_000, tokens: 18_000, requests: 12, counts: { behaviors: 5 } },
      { agent: 'review-risk-hunter', status: 'completed', durationMs: 130_000, tokens: 61_000, requests: 19, counts: {} },
    ],
    ...overrides,
  };
}

function capture() {
  const lines = [];
  return { lines, out: line => lines.push(line), err: line => lines.push(`ERR ${line}`) };
}

test('Given flags, When they are parsed, Then each mode is set and an unknown flag is a usage error', () => {
  assert.deepEqual(parseArgs([]).mode, 'list');
  assert.equal(parseArgs(['--all']).mode, 'all');
  assert.equal(parseArgs(['--last']).mode, 'last');
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--run', 'run-1']).runId, 'run-1');
  assert.equal(parseArgs(['--run=run-2']).runId, 'run-2');
  assert.equal(parseArgs(['--follow', 'run-3']).mode, 'follow');
  assert.equal(parseArgs(['--repo', 'E:/repos/x']).repo, path.resolve('E:/repos/x'));
  assert.equal(parseArgs(['--timeout', '30']).timeoutMs, 30_000);
  assert.throws(() => parseArgs(['--nonsense']), /unknown argument/);
  assert.throws(() => parseArgs(['--run']), /needs a value/);
});

test('Given a record, When one line is formatted, Then it shows the verdict, the duration, the repository and the stage timings', () => {
  assert.equal(formatRunLine(record()), 'run-1  PASS     4m12s  omp-reviewer-kit  scout 1m02s · hunter 2m10s');
});

test('Given a record with no duration, When one line is formatted, Then it says unknown instead of inventing seconds', () => {
  assert.match(formatRunLine(record({ durationMs: null, stages: [] })), /unknown/);
});

test('Given a record, When its detail is formatted, Then the stage table and the report path are shown', () => {
  const detail = formatRunDetail(record({ reportPath: 'C:/reports/x.md' }));
  assert.match(detail, /^Run: run-1$/m);
  assert.match(detail, /^State: passed \(PASS\)$/m);
  assert.match(detail, /^Report: C:\/reports\/x\.md$/m);
  assert.match(detail, /review-context-scout \| completed \| 1m02s \| 18000 \| 12 \| behaviors 5/);
});

test('Given stored records, When the command lists them, Then the newest comes first and an empty store exits 1', async () => {
  await withDir(async dir => {
    const env = { OMP_REVIEW_KIT_RUNS_DIR: dir };
    const empty = capture();
    assert.equal(await main([], { env, out: empty.out, err: empty.err }), 1);
    assert.match(empty.lines.join('\n'), /no run records/);

    await writeRunRecord(record({ runId: 'run-old', startedAt: '2026-10-01T00:00:00.000Z' }), { dir });
    await writeRunRecord(record({ runId: 'run-new', startedAt: '2026-11-01T00:00:00.000Z' }), { dir });
    const listed = capture();
    assert.equal(await main([], { env, out: listed.out, err: listed.err }), 0);
    assert.match(listed.lines[0], /^run-new/);

    const one = capture();
    assert.equal(await main(['--last'], { env, out: one.out, err: one.err }), 0);
    assert.equal(one.lines.length, 1);
    assert.match(one.lines[0], /^run-new/);

    const json = capture();
    assert.equal(await main(['--all', '--json'], { env, out: json.out, err: json.err }), 0);
    assert.equal(JSON.parse(json.lines.join('\n')).length, 2);
  });
});

test('Given one stored record, When it is requested by id, Then its detail is printed and an unknown id exits 1', async () => {
  await withDir(async dir => {
    const env = { OMP_REVIEW_KIT_RUNS_DIR: dir };
    await writeRunRecord(record(), { dir });
    const found = capture();
    assert.equal(await main(['--run', 'run-1'], { env, out: found.out, err: found.err }), 0);
    assert.match(found.lines.join('\n'), /^Run: run-1$/m);

    const missing = capture();
    assert.equal(await main(['--run', 'run-absent'], { env, out: missing.out, err: missing.err }), 1);
  });
});

test('Given a usage error, When the command runs, Then it prints the usage and exits 2', async () => {
  const io = capture();
  assert.equal(await main(['--nonsense'], { env: {}, out: io.out, err: io.err }), 2);
  assert.match(io.lines.join('\n'), /^ERR unknown argument/);
});

test('Given a repository filter, When the command lists runs, Then only that repository is shown', async () => {
  await withDir(async dir => {
    const env = { OMP_REVIEW_KIT_RUNS_DIR: dir };
    const repo = path.resolve('E:/repos/omp-reviewer-kit');
    await writeRunRecord(record({ runId: 'mine', repoRoot: repo }), { dir });
    await writeRunRecord(record({ runId: 'theirs', repoRoot: path.resolve('E:/repos/other') }), { dir });
    const io = capture();
    assert.equal(await main(['--repo', repo], { env, out: io.out, err: io.err }), 0);
    assert.deepEqual(io.lines.map(line => line.split(' ')[0]), ['mine']);
  });
});

test('Given one checkout spelled another way, When the command filters by it, Then the same runs are shown', async () => {
  await withDir(async dir => {
    // The checkout is a folder that really exists, so its identity is the real path: a junction and
    // another letter case are the same repository and must reach the same record.
    const checkout = path.join(dir, 'checkout');
    await mkdir(checkout, { recursive: true });
    const runsRoot = path.join(dir, 'runs');
    await writeRunRecord(record({ runId: 'aliased', repoRoot: checkout }), { dir: runsRoot });

    const spellings = [checkout, ...(process.platform === 'win32' ? [checkout.toUpperCase()] : [])];
    for (const spelling of spellings) {
      const io = capture();
      assert.equal(await main(['--repo', spelling], { env: { OMP_REVIEW_KIT_RUNS_DIR: runsRoot }, out: io.out, err: io.err }), 0, spelling);
      assert.deepEqual(io.lines.map(line => line.split(' ')[0]), ['aliased'], spelling);
    }
  });
});

test('Given a run that settles while watched, When follow polls it, Then every transition is printed once and it exits 0', async () => {
  await withDir(async dir => {
    const runId = 'run-live';
    await writeRunRecord(record({ runId, state: 'running', runnerPid: process.pid, durationMs: null, stages: [] }), { dir });
    const lines = [];
    // The writes happen while the follower polls, and they are awaited before the folder is removed:
    // a write still in flight when the temporary folder disappears is a test leak, not a product defect.
    const duringFollow = [
      delay(30).then(() => writeRunRecord(record({ runId, state: 'running', runnerPid: process.pid, durationMs: null, stages: [{ agent: 'review-context-scout', status: 'completed', durationMs: 62_000 }] }), { dir })),
      delay(90).then(() => writeRunRecord(record({ runId }), { dir })),
    ];
    try {
      const settled = await followRun({ dir, runId, out: line => lines.push(line), intervalMs: 10, timeoutMs: 5_000 });
      assert.equal(settled, true);
      assert.match(lines[0], /^stage review-context-scout completed 1m02s$/);
      assert.match(lines[lines.length - 1], /^run-live  PASS/);
    } finally {
      await Promise.allSettled(duringFollow);
    }
  });
});

test('Given a run whose runner is gone, When follow polls it, Then it reports the interruption and exits 1', async () => {
  await withDir(async dir => {
    await writeRunRecord(record({ runId: 'run-dead', state: 'running', runnerPid: 999_999_999, durationMs: null, stages: [] }), { dir });
    const lines = [];
    const settled = await followRun({ dir, runId: 'run-dead', out: line => lines.push(line), intervalMs: 10, timeoutMs: 1_000 });
    assert.equal(settled, false);
    assert.match(lines.join('\n'), /interrupted/);
  });
});

test('Given a run id that does not exist, When follow starts, Then it says so and exits 1', async () => {
  await withDir(async dir => {
    const lines = [];
    assert.equal(await followRun({ dir, runId: 'run-absent', out: line => lines.push(line), intervalMs: 10 }), false);
    assert.match(lines.join('\n'), /not found/);
  });
});

test('Given a watcher with a timeout, When the run never settles, Then it stops watching instead of hanging', async () => {
  await withDir(async dir => {
    await writeRunRecord(record({ runId: 'run-slow', state: 'running', runnerPid: process.pid, durationMs: null, stages: [] }), { dir });
    let clock = 0;
    const lines = [];
    const settled = await followRun({ dir, runId: 'run-slow', out: line => lines.push(line), intervalMs: 10, timeoutMs: 1, now: () => (clock += 10) });
    assert.equal(settled, false);
    assert.match(lines.join('\n'), /still running/);
  });
});

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review-runs.mjs');

function runScript(argv, runsDir) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, OMP_REVIEW_KIT_RUNS_DIR: runsDir },
  });
}

test('Given the script is run directly with --help, When it starts, Then it prints the usage and exits 0', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-runs-help-'));
  try {
    const result = runScript(['--help'], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: node scripts\/review-runs\.mjs/m);
    assert.equal(result.stderr, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given an empty store, When the script is run directly, Then it says so and exits 1', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-runs-empty-'));
  try {
    const result = runScript([], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^no run records in /m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the status flag, When arguments are parsed, Then the mode is status', () => {
  assert.equal(parseArgs(['--status']).mode, 'status');
});

test('Given a running review whose runner is alive and whose commit waits, When status is asked, Then it reports working, not hung', async () => {
  await withDir(async (dir) => {
    await writeRunRecord({
      schema: 'review-run-record@2',
      runId: 'run-live',
      state: 'running',
      startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      runnerPid: 4242,
      repoRoot: path.resolve('E:/repos/omp-reviewer-kit'),
      repoName: 'omp-reviewer-kit',
      stages: [{ agent: 'review-context-scout', status: 'running', durationMs: 120_000, tokens: 40_000, requests: 12 }],
    } , path.join(dir, 'run-live.json'));
    const lines = [];
    const code = await statusReport({
      dir,
      records: [{ schema: 'review-run-record@2', runId: 'run-live', state: 'running', startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), runnerPid: 4242, repoRoot: 'E:/repos/omp-reviewer-kit', repoName: 'omp-reviewer-kit', stages: [{ agent: 'review-context-scout', status: 'running', durationMs: 120_000, tokens: 40_000, requests: 12 }] }],
      out: line => lines.push(line),
      env: {},
      probe: async (record, { now }) => probeRun(record, { dir, now, deadlineMs: 1_200_000, stat: async () => ({ mtimeMs: now - 5_000 }), alive: () => true, waiter: () => true }),
    });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /run-live \| working \| working at review-context-scout running/);
    assert.equal(lines.join('\n').includes('hung'), false);
  });
});

test('Given a pid that was recycled and a record nobody has touched for a day, When status is asked, Then the record is dead, not a live orphan', async () => {
  await withDir(async (dir) => {
    const record = { schema: 'review-run-record@2', runId: 'run-old', state: 'running', startedAt: '2026-11-15T00:00:00.000Z', runnerPid: 4242, repoRoot: 'E:/repos/omp-reviewer-kit', stages: [{ agent: 'reviewkkit', status: 'running' }] };
    const lines = [];
    await statusReport({
      dir,
      records: [record],
      out: line => lines.push(line),
      env: {},
      now: () => Date.parse('2026-11-16T02:00:00.000Z'),
      probe: async (entry, { now }) => probeRun(entry, { dir, now, deadlineMs: 1_200_000, stat: async () => ({ mtimeMs: now - 26 * 60 * 60_000 }), alive: () => true, waiter: () => false }),
    });
    // A day-old dead record is history: the report says so instead of presenting it as a live run.
    assert.match(lines.join('\n'), /no review is running; 1 unfinished record\(s\) from earlier/);
  });
});

test('Given no running review but a finished one, When status is asked, Then the finished run is the context and the exit code is 0', async () => {
  await withDir(async (dir) => {
    const lines = [];
    const code = await statusReport({
      dir,
      records: [{ schema: 'review-run-record@2', runId: 'run-done', state: 'passed', verdict: 'PASS', startedAt: '2026-11-16T00:00:00.000Z', durationMs: 240_000 }],
      out: line => lines.push(line),
      env: {},
      now: () => Date.parse('2026-11-16T02:00:00.000Z'),
      probe: async (record, { now }) => probeRun(record, { dir, now, deadlineMs: 1_200_000, stat: async () => ({ mtimeMs: now }), alive: () => true, waiter: () => true }),
    });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /^run-done \| finished \| review passed \(PASS\) in 4m00s/m);
    assert.equal(lines.join('\n').includes('no review runs'), false);
  });
});

test('Given hidden abandoned records and a JSON request, When status is asked, Then the output is one parseable document with no prose after it', async () => {
  await withDir(async (dir) => {
    const startedAt = '2026-11-16T01:00:00.000Z';
    const records = ['a', 'b', 'c'].map((id, index) => ({ schema: 'review-run-record@2', runId: `old-${id}`, state: 'running', startedAt, runnerPid: 100 + index, repoRoot: 'E:/repos/x' }));
    const lines = [];
    await statusReport({
      dir,
      records,
      out: line => lines.push(line),
      env: {},
      json: true,
      now: () => Date.parse('2026-11-16T02:00:00.000Z'),
      probe: async (record, { now }) => probeRun(record, { dir, now, deadlineMs: 1_200_000, stat: async () => ({ mtimeMs: now - 10 * 60_000 }), alive: () => false, waiter: () => false }),
    });
    const rows = JSON.parse(lines.join('\n'));
    assert.equal(Array.isArray(rows), true);
    assert.equal(rows.length, 2);
    assert.equal(lines.join('\n').includes('plus'), false);
  });
});

test('Given an empty runs folder asked in JSON, When status is asked, Then it prints an empty array and reports nothing found', async () => {
  await withDir(async (dir) => {
    const lines = [];
    const code = await statusReport({ dir, records: [], out: line => lines.push(line), env: {}, json: true });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(lines.join('\n')), []);
  });
});

test('Given a finished record and the script run directly with --status, When it starts, Then it prints the liveness line and exits 0', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-runs-status-'));
  try {
    await writeRunRecord({
      schema: 'review-run-record@2',
      runId: 'run-status-1',
      state: 'passed',
      verdict: 'PASS',
      startedAt: '2026-11-16T00:00:00.000Z',
      durationMs: 240_000,
      repoRoot: path.resolve('E:/repos/omp-reviewer-kit'),
      repoName: 'omp-reviewer-kit',
      stages: [{ agent: 'review-context-scout', status: 'completed', durationMs: 120_000 }],
    }, { dir });
    const result = runScript(['--status'], dir);
    assert.equal(result.status, 0, result.stderr);
    // The liveness line, not the `<runId>  STATE duration  repo` list line: a --status that fell
    // through to the list path would print the repo name and the stage summary instead.
    assert.match(result.stdout, /^run-status-1 \| finished \| review passed \(PASS\) in 4m00s/m);
    assert.equal(result.stdout.includes('omp-reviewer-kit  scout'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the same record and --status --json, When the script runs, Then stdout is one parseable document and nothing else', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-runs-status-json-'));
  try {
    await writeRunRecord({
      schema: 'review-run-record@2',
      runId: 'run-status-2',
      state: 'blocked',
      verdict: 'BLOCK',
      startedAt: '2026-11-16T00:00:00.000Z',
      durationMs: 60_000,
      repoRoot: path.resolve('E:/repos/omp-reviewer-kit'),
      repoName: 'omp-reviewer-kit',
      stages: [],
    }, { dir });
    const result = runScript(['--status', '--json'], dir);
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.equal(Array.isArray(rows), true);
    assert.equal(rows[0].runId, 'run-status-2');
    assert.equal(rows[0].kind, 'finished');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
