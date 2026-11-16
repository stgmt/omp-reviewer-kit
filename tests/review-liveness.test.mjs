// Given/When/Then over the one question a bare terminal cannot answer: is this review working,
// quiet, stalled or dead? Pure: the clock, the progress age, the process facts and the waiter are
// all supplied by the caller, so no test waits on a real review.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIVENESS, QUIET_MS, STALL_MS, classifyLiveness, formatLivenessLine } from '../src/domain/review-liveness.mjs';
import { gitCommitWaiting, indexLockExists, probeRun } from '../src/infra/review-liveness-probe.mjs';

const NOW = Date.parse('2026-11-16T02:20:00.000Z');
const started = minutesUsing => new Date(NOW - minutesUsing * 60_000).toISOString();
const running = (overrides = {}) => ({
  state: 'running',
  startedAt: started(6),
  stage: { agent: 'review-context-scout', status: 'running', durationMs: 120_000, tokens: 40_000, requests: 12 },
  progressAgeMs: 5_000,
  runnerAlive: true,
  commitWaiting: true,
  ...overrides,
});

test('Given a stage that wrote progress seconds ago, When the run is classified, Then it is working, never hung', () => {
  const result = classifyLiveness(running(), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(result.kind, LIVENESS.working);
  assert.match(result.text, /working at review-context-scout running \(2m00s, 40000 tok, 12 req\)/);
  assert.match(result.text, /last progress 5s ago/);
});

test('Given a silence shorter than the stall window, When the run is classified, Then it is quiet and says a long model call is still possible', () => {
  const result = classifyLiveness(running({ progressAgeMs: QUIET_MS + 2_000 }), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(result.kind, LIVENESS.quiet);
  assert.match(result.text, /no progress for 1m02s/);
  assert.match(result.text, /not a hang yet/);
});

test('Given a silence past the stall window, When the run is classified, Then it is stalled and names when the deadline stops it', () => {
  const ageMs = STALL_MS;
  const result = classifyLiveness(running({ progressAgeMs: ageMs, startedAt: started(10) }), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(result.kind, LIVENESS.stalled);
  assert.match(result.text, /silent for 5m00s/);
  assert.match(result.text, /a stage that never answers is stopped by its own deadline/);
  assert.equal(result.progressAgeMs, ageMs);
});

test('Given a live runner with no git commit waiting, When the run is classified, Then the kind still follows progress and the waiter is only context', () => {
  const busy = classifyLiveness(running({ commitWaiting: false }), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(busy.kind, LIVENESS.working);
  assert.match(busy.text, /no git commit is waiting \(a manual run, or a commit that is gone\)/);
  // Silence wins over the waiter: a manual review that stopped reporting is stalled, not "unawaited".
  const waited = classifyLiveness(running({ commitWaiting: true }), { now: NOW, deadlineMs: 1_200_000 });
  assert.match(waited.text, /a git commit is waiting for this verdict/);
  const unknown = classifyLiveness(running({ commitWaiting: null }), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(unknown.text.includes('git commit'), false, 'an unasked machine prints neither answer');
  const silent = classifyLiveness(running({ commitWaiting: false, progressAgeMs: STALL_MS }), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(silent.kind, LIVENESS.stalled);
  assert.match(silent.text, /silent for 5m00s/);
  assert.match(silent.text, /no git commit is waiting/);
});

test('Given the runner process is gone and the record never settled, When it is classified, Then the record is dead, not quiet', () => {
  const result = classifyLiveness(running({ runnerAlive: false, progressAgeMs: 5_000 }), { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(result.kind, LIVENESS.exited);
  assert.match(result.text, /runner process is gone/);
});

test('Given a finished run read hours later, When it is classified, Then its measured duration is reported, not the time since it started', () => {
  const result = classifyLiveness({ state: 'blocked', verdict: 'BLOCK', startedAt: started(200), durationMs: 240_000, reportPath: 'C:/reports/x.md' }, { now: NOW });
  assert.equal(result.kind, LIVENESS.finished);
  assert.match(result.text, /review blocked \(BLOCK\) in 4m00s; report written/);
  assert.equal(result.elapsedMs, 240_000);
});

test('Given unknown timings, When the line is formatted, Then they say unknown instead of zero', () => {
  const result = classifyLiveness({ state: 'running', startedAt: null, progressAgeMs: null, runnerAlive: true, commitWaiting: true }, { now: NOW, deadlineMs: 1_200_000 });
  assert.equal(result.kind, LIVENESS.working);
  assert.match(result.text, /last progress unknown/);
  assert.match(formatLivenessLine('run-1', result), /^run-1 \| working \| /);
});

test('Given a runner pid that answers while the record cannot be read, When the run is classified, Then liveness is unknown, never "the process is gone"', async () => {
  const boom = () => { throw new Error('EBUSY'); };
  const row = await probeRun(
    { runId: 'odd-1', state: 'running', startedAt: started(6), runnerPid: 4242, repoRoot: 'E:/repos/x', stages: [{ agent: 'review-context-scout', status: 'running' }] },
    { dir: 'C:/runs', now: NOW, deadlineMs: 1_200_000, stat: boom, alive: () => true, waiter: () => { throw new Error('must not be asked'); } },
  );
  assert.equal(row.kind, LIVENESS.unknown);
  assert.match(row.text, /runner process is alive but progress age is unknown/);
  assert.equal(row.text.includes('process is gone'), false);
});

test('Given a finished record probed hours later, When the probe runs, Then it reports the measured duration and touches no process or git state', async () => {
  const boom = () => { throw new Error('must not be called for a finished record'); };
  const row = await probeRun(
    { runId: 'done-1', state: 'passed', verdict: 'PASS', startedAt: started(200), durationMs: 240_000, runnerPid: 1, repoRoot: 'E:/repos/x' },
    { dir: 'C:/runs', now: NOW, deadlineMs: 1_200_000, stat: boom, alive: boom, waiter: boom },
  );
  assert.equal(row.kind, LIVENESS.finished);
  assert.match(row.text, /review passed \(PASS\) in 4m00s/);
});

test('Given a git commit still waiting, When the waiter is probed, Then the lock answers alone and a foreign repository does not count', () => {
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => true, processList: () => { throw new Error('must not be read'); } }), true);
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git -C E:/repos/x commit -m x' }), true);
  // A pathless commit line cannot be attributed to a repository: unknown, never a false "nobody waits".
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git commit -m x' }), null);
  // `-c key=value` is configuration, not the `-C <path>` directory flag: still unattributable.
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git -c user.name=a commit -m x' }), null);
  // A prefix of another repository's path is not this repository.
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git -C E:/repos/xy commit -m x' }), false);
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git -C E:/repos/x/sub commit -m x' }), true);
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git -C E:/repos/other commit -m x' }), false);
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => '1234 git -C E:/repos/x status' }), false);
  assert.equal(gitCommitWaiting('E:/repos/x', { lockExists: () => false, processList: () => { throw new Error('no ps'); } }), null);
  assert.equal(gitCommitWaiting('', { lockExists: () => true }), null);
});

test('Given a real repository, When the index lock appears and disappears, Then the waiter follows the lock file', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'liveness-lock-'));
  try {
    execFileSync('git', ['init', '-q', dir], { windowsHide: true, stdio: 'ignore' });
    const lock = String(execFileSync('git', ['-C', dir, 'rev-parse', '--git-path', 'index.lock'], { encoding: 'utf8', windowsHide: true })).trim();
    const lockFile = path.resolve(dir, lock);
    assert.equal(indexLockExists(dir), false);
    await writeFile(lockFile, '');
    assert.equal(indexLockExists(dir), true);
    await rm(lockFile, { force: true });
    assert.equal(indexLockExists(dir), false);
    assert.equal(indexLockExists(''), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
