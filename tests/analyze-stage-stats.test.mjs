import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cwd = process.cwd();
const at = '2026-10-04T00:00:00.000Z';

const SCOUT = {
  stage: 'Scout', turns: 4, toolCalls: 7, tools: { read: 5, grep: 2 }, startedAtMs: 1, spanMs: 300_000,
  turnGapMedianMs: 90_000, turnGapP90Ms: 120_000, turnGapMaxMs: 150_000, model: 'model/scout',
};
const IDLE = {
  stage: 'Idle', turns: 1, toolCalls: 0, tools: {}, startedAtMs: 2, spanMs: 0,
  turnGapMedianMs: null, turnGapP90Ms: null, turnGapMaxMs: null, model: null,
};

async function analyze(events, extraArgs = []) {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-analyze-stages-'));
  // The analyzer looks for OMP logs under the home directory; an empty one keeps the output independent of the machine.
  const home = path.join(repo, 'home');
  await mkdir(home, { recursive: true });
  try {
    const dir = path.join(repo, 'audit-reports', 'commit-reviews');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'runs.jsonl'), `${events.map((event) => JSON.stringify({ runId: 'r1', at, ...event })).join('\n')}\n`, 'utf8');
    const out = spawnSync(process.execPath, ['scripts/analyze-review-run.mjs', 'r1', '--repo', repo, ...extraArgs], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

const run = (middle) => [
  { type: 'run_started' },
  { type: 'review_attempt_started', attemptIndex: 0, pid: 111 },
  ...middle,
  { type: 'review_attempt_finished', attemptIndex: 0, pid: 111, status: 0, durationMs: 5000, providerFailure: false },
  { type: 'run_finished', verdict: 'PASS', exitCode: 0, durationMs: 6000 },
];

test('Given a stage_stats event, When the run is analysed, Then the attempt carries the exact stages and survives the finished event', async () => {
  const json = JSON.parse(await analyze(run([{ type: 'stage_stats', attemptIndex: 0, stages: [SCOUT, IDLE] }]), ['--json']));
  assert.deepEqual(json.attempts[0].stageStats, [SCOUT, IDLE]);
  assert.equal(json.attempts[0].status, 0);
});

test('Given a stage_stats event without attemptIndex, Then it folds into the latest attempt', async () => {
  const json = JSON.parse(await analyze(run([{ type: 'stage_stats', stages: [SCOUT] }]), ['--json']));
  assert.deepEqual(json.attempts[0].stageStats, [SCOUT]);
});

test('Given a stage_stats event whose stages is not an array, Then the attempt carries an empty list', async () => {
  const json = JSON.parse(await analyze(run([{ type: 'stage_stats', attemptIndex: 0, stages: 'oops' }]), ['--json']));
  assert.deepEqual(json.attempts[0].stageStats, []);
});

test('Given stage stats, When the report is printed, Then each stage is one row and missing gaps render a dash without NaN', async () => {
  const out = await analyze(run([{ type: 'stage_stats', attemptIndex: 0, stages: [SCOUT, IDLE] }]));
  const rows = out.split('\n').filter((line) => line.includes('    stage '));
  assert.equal(rows.length, 2, out);
  assert.match(rows[0], /stage Scout: .*turns 4  tool calls 7 \(read×5 grep×2\)  turn gap median 90s p90 120s max 150s  model\/scout/);
  assert.match(rows[1], /stage Idle: .*turns 1  tool calls 0  turn gap median - p90 - max -$/);
  assert.equal(out.includes('NaN'), false);
});

test('Given an attempt without stage stats, Then no stage row is printed and the report does not crash', async () => {
  const out = await analyze(run([]));
  assert.equal(out.split('\n').some((line) => line.includes('    stage ')), false);
  assert.match(out, /attempt #0/);
});

test('Given two attempts of which one has stage stats, Then exactly one stage row is printed', async () => {
  const events = [
    { type: 'run_started' },
    { type: 'review_attempt_started', attemptIndex: 0, pid: 111 },
    { type: 'stage_stats', attemptIndex: 0, stages: [SCOUT] },
    { type: 'review_attempt_finished', attemptIndex: 0, pid: 111, status: 0, durationMs: 5000 },
    { type: 'review_attempt_started', attemptIndex: 1, pid: 222 },
    { type: 'review_attempt_finished', attemptIndex: 1, pid: 222, status: 0, durationMs: 5000 },
    { type: 'run_finished', verdict: 'PASS', exitCode: 0, durationMs: 11_000 },
  ];
  const out = await analyze(events);
  assert.equal(out.split('\n').filter((line) => line.includes('    stage ')).length, 1, out);
});
