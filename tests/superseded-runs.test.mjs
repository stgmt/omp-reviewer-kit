import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareRunnerVersions, runnerVersionString } from '../src/domain/runner-version.mjs';
import { isSupersededRun } from '../src/domain/superseded-runs.mjs';
import { TERMINAL_RUN_STATES } from '../src/infra/filesystem-telemetry-adapter.mjs';
import { listProcesses, parseCimOutput, parsePsOutput, terminateTree } from '../src/infra/process-table.mjs';
import { matchesRunner, readRunnerFileVersion, stopSupersededRuns } from '../src/application/superseded-run-stopper.mjs';
import { formatStopResult, main as cliMain } from '../scripts/stop-superseded-runs.mjs';
import { workspace } from './target-workspace.mjs';

// Every test works in a throwaway runs directory. The variable is also set for this process, so that
// nothing reached from here can fall back to the per-user runs directory of the real reviews.
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'omp-superseded-'));
process.env.OMP_REVIEW_KIT_RUNS_DIR = path.join(SCRATCH, 'default-runs');
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const CLI_PATH = fileURLToPath(new URL('../scripts/stop-superseded-runs.mjs', import.meta.url));
const RUNNER_PATH = fileURLToPath(new URL('../scripts/run-review.mjs', import.meta.url));
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

function freshDir(name) {
  const dir = mkdtempSync(path.join(SCRATCH, `${name}-`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRecord(overrides = {}) {
  return {
    schema: 'review-run-record@1',
    runId: 'run-a',
    repoRoot: 'E:/repos/example',
    tag: 'session-1',
    runnerPid: 4242,
    state: 'reviewing',
    stage: 'risk',
    startedAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  };
}

function writeRecord(runsDir, record) {
  writeFileSync(path.join(runsDir, `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function readRecord(runsDir, runId) {
  return JSON.parse(readFileSync(path.join(runsDir, `${runId}.json`), 'utf8'));
}

/** A process that only sleeps, named run-review.mjs like a real runner. */
function startSleeper(dir) {
  const file = path.join(dir, 'run-review.mjs');
  writeFileSync(file, 'setInterval(() => {}, 1000);\n', 'utf8');
  return spawn(process.execPath, [file], { stdio: 'ignore', windowsHide: true });
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child, timeoutMs = 15_000) {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Only ever called on a child that this test spawned itself. */
async function disposeChild(child) {
  if (isRunning(child)) child.kill('SIGKILL');
  await waitForExit(child, 5_000);
}

// ---------------------------------------------------------------------------
// Version helpers

test('Given runner markers and versions, When they are read and compared, Then strings parse and invalid input yields null', () => {
  assert.equal(runnerVersionString('// omp-reviewer-kit runner v0.20.1\nimport x;'), '0.20.1');
  assert.equal(runnerVersionString('// no marker here\n'), null);
  assert.equal(compareRunnerVersions('0.19.9', '0.20.1'), -1);
  assert.equal(compareRunnerVersions('0.20.1', '0.20.1'), 0);
  assert.equal(compareRunnerVersions('0.20.10', '0.20.9'), 1);
  assert.equal(compareRunnerVersions('0.20', '0.20.1'), null);
  assert.equal(compareRunnerVersions('0.20.1', 'abc'), null);
  assert.equal(compareRunnerVersions(undefined, '0.20.1'), null);
});

// ---------------------------------------------------------------------------
// Decision table

test('Given the five terminal states, When the run is older, Then it is never superseded and the list matches the adapter', () => {
  for (const state of TERMINAL_RUN_STATES) {
    assert.equal(isSupersededRun(makeRecord({ state, runnerVersion: '0.1.0' }), '0.20.1'), false, state);
  }
  for (const state of ['passed', 'blocked', 'failed', 'skipped', 'interrupted']) {
    assert.ok(TERMINAL_RUN_STATES.has(state), state);
  }
  assert.equal(TERMINAL_RUN_STATES.size, 5);
});

test('Given a live run, When its runner is older, equal or newer than the installed one, Then only the older one is superseded', () => {
  assert.equal(isSupersededRun(makeRecord({ runnerVersion: '0.20.0' }), '0.20.1'), true);
  assert.equal(isSupersededRun(makeRecord({ runnerVersion: '0.9.9' }), '0.20.1'), true);
  assert.equal(isSupersededRun(makeRecord({ runnerVersion: '0.20.1' }), '0.20.1'), false);
  assert.equal(isSupersededRun(makeRecord({ runnerVersion: '0.20.2' }), '0.20.1'), false);
  assert.equal(isSupersededRun(makeRecord({ runnerVersion: '1.0.0' }), '0.20.1'), false);
});

test('Given a live run without runnerVersion, When it is judged, Then it counts as older', () => {
  assert.equal(isSupersededRun(makeRecord(), '0.20.1'), true);
  assert.equal(isSupersededRun(makeRecord({ runnerVersion: null }), '0.20.1'), true);
});

test('Given a runnerVersion that is not x.y.z, When it is judged, Then the run is kept', () => {
  for (const runnerVersion of ['', 'v0.20.0', '0.20', 'latest', 20, {}]) {
    assert.equal(isSupersededRun(makeRecord({ runnerVersion }), '0.20.1'), false, String(runnerVersion));
  }
});

test('Given an installed version that is not x.y.z, When any run is judged, Then nothing is superseded', () => {
  for (const current of [null, undefined, '', 'abc', '0.20', 'v0.20.1']) {
    assert.equal(isSupersededRun(makeRecord({ runnerVersion: '0.1.0' }), current), false, String(current));
    assert.equal(isSupersededRun(makeRecord(), current), false, String(current));
  }
});

test('Given a record whose runnerPid is not an integer, When it is judged, Then it is kept', () => {
  for (const runnerPid of [undefined, null, '4242', 1.5, Number.NaN]) {
    assert.equal(isSupersededRun(makeRecord({ runnerPid, runnerVersion: '0.1.0' }), '0.20.1'), false, String(runnerPid));
  }
});

// ---------------------------------------------------------------------------
// Identity check

const STARTED = Date.parse('2026-10-10T11:59:00.000Z');
const identityRecord = makeRecord({ runnerPid: 4242, startedAt: new Date(STARTED).toISOString() });
const identityProcess = {
  pid: 4242,
  ppid: 1,
  startedAt: STARTED - 500,
  commandLine: 'node C:\\plugin\\scripts\\run-review.mjs',
};

test('Given a process that is the runner, When the identity is checked, Then it matches', () => {
  assert.equal(matchesRunner(identityRecord, identityProcess, { selfPid: 1 }), true);
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, startedAt: STARTED + 2000 }, { selfPid: 1 }), true);
});

test('Given a process with another pid, When the identity is checked, Then it does not match', () => {
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, pid: 4243 }, { selfPid: 1 }), false);
});

test('Given a command line without run-review.mjs, When the identity is checked, Then it does not match', () => {
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, commandLine: 'node other-script.mjs' }, { selfPid: 1 }), false);
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, commandLine: null }, { selfPid: 1 }), false);
});

test('Given a process that started after the record, When the identity is checked, Then it is a reused pid and does not match', () => {
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, startedAt: STARTED + 2001 }, { selfPid: 1 }), false);
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, startedAt: STARTED + 3_600_000 }, { selfPid: 1 }), false);
});

test('Given an unknown start time, When the identity is checked, Then it does not match', () => {
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, startedAt: null }, { selfPid: 1 }), false);
  assert.equal(matchesRunner(identityRecord, { ...identityProcess, startedAt: Number.NaN }, { selfPid: 1 }), false);
  assert.equal(matchesRunner({ ...identityRecord, startedAt: 'not a date' }, identityProcess, { selfPid: 1 }), false);
});

test('Given a record that names this very process, When the identity is checked, Then it never matches', () => {
  const own = makeRecord({ runnerPid: process.pid, startedAt: new Date(STARTED).toISOString() });
  assert.equal(matchesRunner(own, { ...identityProcess, pid: process.pid }), false);
});

// ---------------------------------------------------------------------------
// Parsers

test('Given ps output, When it is parsed, Then pid, parent, start time and the full args come out', () => {
  const text = [
    '    1     0 Sat Oct 10 08:00:00 2026 /sbin/init',
    '  812   640 Sat Oct 10 12:34:56 2026 node /home/u/scripts/run-review.mjs --mode a | b',
    'garbage line',
    '',
  ].join('\n');
  const rows = parsePsOutput(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 1, ppid: 0, startedAt: new Date(2026, 9, 10, 8, 0, 0).getTime(), commandLine: '/sbin/init' });
  assert.equal(rows[1].pid, 812);
  assert.equal(rows[1].ppid, 640);
  assert.equal(rows[1].startedAt, new Date(2026, 9, 10, 12, 34, 56).getTime());
  assert.equal(rows[1].commandLine, 'node /home/u/scripts/run-review.mjs --mode a | b');
});

test('Given CIM output with a pipe inside a command line, When it is parsed, Then the command line keeps every pipe', () => {
  const text = [
    '4242|100|2026-10-10T12:34:56.1234567+03:00|"C:\\node.exe" "C:\\k\\run-review.mjs" --x "a|b" | c',
    '7|0||System',
    'not|a|process',
    'x|1|2026-10-10T12:34:56.0000000+03:00|bad pid',
    '',
  ].join('\r\n');
  const rows = parseCimOutput(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 4242);
  assert.equal(rows[0].ppid, 100);
  assert.equal(rows[0].startedAt, Date.parse('2026-10-10T12:34:56.123+03:00'));
  assert.equal(rows[0].commandLine, '"C:\\node.exe" "C:\\k\\run-review.mjs" --x "a|b" | c');
  assert.deepEqual(rows[1], { pid: 7, ppid: 0, startedAt: null, commandLine: 'System' });
});

// ---------------------------------------------------------------------------
// terminateTree refuses

test('Given this process or its parent, When terminateTree is asked to stop it, Then it refuses and signals nothing', async () => {
  assert.deepEqual(await terminateTree(process.pid, { table: null, graceMs: 0 }), { signalled: [], refused: true });
  assert.deepEqual(await terminateTree(process.ppid, { table: null, graceMs: 0 }), { signalled: [], refused: true });
  const grandparent = 9_999_001;
  const table = [
    { pid: process.pid, ppid: process.ppid },
    { pid: process.ppid, ppid: grandparent },
  ];
  assert.deepEqual(await terminateTree(grandparent, { table, graceMs: 0 }), { signalled: [], refused: true });
  assert.deepEqual(await terminateTree(-5, { table, graceMs: 0 }), { signalled: [], refused: true });
});

// ---------------------------------------------------------------------------
// Stopper with a fake process table

function fakeWorld({ alive = true } = {}) {
  const state = { alive, tableReads: 0, terminated: [] };
  return {
    state,
    processTable: () => {
      state.tableReads += 1;
      return [{ pid: 4242, ppid: 1, startedAt: NOW - 120_000, commandLine: 'node /x/run-review.mjs' }];
    },
    terminate: async (pid) => {
      state.terminated.push(pid);
      state.alive = false;
      return { signalled: [pid], refused: false };
    },
    liveness: () => (state.alive ? 'alive' : 'dead'),
  };
}

test('Given no superseded run, When the stopper runs, Then the process table is never read', async () => {
  const runsDir = freshDir('fast');
  writeRecord(runsDir, makeRecord({ runnerVersion: '0.20.1' }));
  writeRecord(runsDir, makeRecord({ runId: 'run-b', state: 'passed' }));
  const world = fakeWorld();
  const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', now: NOW, ...world });
  assert.equal(world.state.tableReads, 0);
  assert.deepEqual(result, { currentVersion: '0.20.1', dryRun: false, stopped: [], unverified: [], kept: 2 });
});

test('Given an invalid installed version, When the stopper runs, Then nothing is stopped and the table is not read', async () => {
  const runsDir = freshDir('badversion');
  writeRecord(runsDir, makeRecord());
  const world = fakeWorld();
  const result = await stopSupersededRuns({ runsDir, currentVersion: null, now: NOW, ...world });
  assert.equal(world.state.tableReads, 0);
  assert.deepEqual(world.state.terminated, []);
  assert.deepEqual(result.stopped, []);
});

test('Given a superseded run whose runner is gone, When the stopper runs, Then it is left alone as an orphan', async () => {
  const runsDir = freshDir('orphan');
  writeRecord(runsDir, makeRecord());
  const world = fakeWorld({ alive: false });
  const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', now: NOW, ...world });
  assert.equal(world.state.tableReads, 0);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.kept, 1);
  assert.equal(readRecord(runsDir, 'run-a').state, 'reviewing');
});

test('Given a superseded run, When the process table cannot be read, Then it is unverified and nothing is killed', async () => {
  const runsDir = freshDir('nulltable');
  writeRecord(runsDir, makeRecord());
  const world = fakeWorld();
  const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', now: NOW, ...world, processTable: () => null });
  assert.deepEqual(world.state.terminated, []);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.unverified.length, 1);
  assert.equal(result.unverified[0].runId, 'run-a');
  assert.equal(readRecord(runsDir, 'run-a').state, 'reviewing');
});

test('Given a record whose pid now belongs to another program, When the stopper runs, Then it is unverified and nothing is killed', async () => {
  const runsDir = freshDir('reuse');
  writeRecord(runsDir, makeRecord());
  const world = fakeWorld();
  const reused = [{ pid: 4242, ppid: 1, startedAt: NOW - 5_000, commandLine: 'node /x/run-review.mjs' }];
  const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', now: NOW, ...world, processTable: () => reused });
  assert.deepEqual(world.state.terminated, []);
  assert.deepEqual(result.unverified.map((entry) => entry.runId), ['run-a']);
});

test('Given a record naming this process, When the stopper runs, Then this process is never terminated', async () => {
  const runsDir = freshDir('self');
  writeRecord(runsDir, makeRecord({ runnerPid: process.pid, startedAt: new Date(NOW - 60_000).toISOString() }));
  const world = fakeWorld();
  const table = [{ pid: process.pid, ppid: 1, startedAt: NOW - 120_000, commandLine: 'node /x/run-review.mjs' }];
  const result = await stopSupersededRuns({
    runsDir,
    currentVersion: '0.20.1',
    now: NOW,
    ...world,
    processTable: () => table,
    liveness: () => 'alive',
  });
  assert.deepEqual(world.state.terminated, []);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.unverified.length, 1);
});

test('Given dryRun, When the stopper finds a superseded run, Then it lists it and kills and rewrites nothing', async () => {
  const runsDir = freshDir('dry');
  const original = makeRecord({ runnerVersion: '0.20.0' });
  writeRecord(runsDir, original);
  const world = fakeWorld();
  const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', dryRun: true, now: NOW, ...world });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.stopped, [{ runId: 'run-a', repoRoot: 'E:/repos/example', tag: 'session-1', runnerVersion: '0.20.0', runnerPid: 4242 }]);
  assert.deepEqual(world.state.terminated, []);
  assert.deepEqual(readRecord(runsDir, 'run-a'), original);
});

test('Given a superseded run, When the stopper stops it, Then the record becomes interrupted with the reason and keeps its other fields', async () => {
  const runsDir = freshDir('rewrite');
  const original = makeRecord({ extra: { keep: true } });
  writeRecord(runsDir, original);
  const world = fakeWorld();
  const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', now: NOW, ...world });
  assert.deepEqual(world.state.terminated, [4242]);
  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].runnerVersion, null);
  const after = readRecord(runsDir, 'run-a');
  assert.equal(after.state, 'interrupted');
  assert.equal(after.supersededBy, '0.20.1');
  assert.equal(after.finishedAt, new Date(NOW).toISOString());
  assert.equal(after.error, 'stopped by reviewer-kit 0.20.1: this run used runner from before 0.20.1');
  assert.equal(after.message, after.error);
  const { state, supersededBy, finishedAt, error, message, ...rest } = after;
  const { state: _state, ...originalRest } = original;
  assert.deepEqual(rest, originalRest);
});

test('Given a run that finishes while it is being stopped, When the stopper re-reads the record, Then the finished record is not overwritten', async () => {
  const runsDir = freshDir('race');
  writeRecord(runsDir, makeRecord({ runnerVersion: '0.20.0' }));
  const world = fakeWorld();
  const finished = makeRecord({ runnerVersion: '0.20.0', state: 'passed', verdict: 'PASS' });
  const terminate = async (pid) => {
    writeRecord(runsDir, finished);
    return world.terminate(pid);
  };
  await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', now: NOW, ...world, terminate });
  assert.deepEqual(readRecord(runsDir, 'run-a'), finished);
});

test('Given a runner that is still alive after the stop, When the stopper waits, Then the run is unverified and its record is untouched', async () => {
  // Given: the terminate call reports a signal, but the runner never goes away
  const runsDir = freshDir('stillalive');
  const original = makeRecord({ runnerVersion: '0.20.0' });
  writeRecord(runsDir, original);
  const world = fakeWorld();
  const terminate = async (pid) => {
    world.state.terminated.push(pid);
    return { signalled: [pid], refused: false };
  };
  // When: the stop wait is zero, so the first liveness answer decides
  const result = await stopSupersededRuns({
    runsDir,
    currentVersion: '0.20.1',
    now: NOW,
    ...world,
    terminate,
    liveness: () => 'alive',
    exitWaitMs: 0,
  });
  // Then: nothing counts as stopped and the record still reads reviewing
  assert.deepEqual(world.state.terminated, [4242]);
  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.unverified, [{ runId: 'run-a', runnerPid: 4242, reason: 'the runner was still alive after the stop' }]);
  assert.equal(readRecord(runsDir, 'run-a').state, 'reviewing');
  assert.deepEqual(readRecord(runsDir, 'run-a'), original);
});

// ---------------------------------------------------------------------------
// Process table failure

test('Given a listing program that cannot be started, When the process table is listed, Then the answer is null and not an empty list', () => {
  // Given: an empty PATH, so neither powershell.exe (win32) nor ps (posix) can be found
  const saved = process.env.PATH;
  let table;
  // When
  try {
    process.env.PATH = '';
    table = listProcesses();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
  // Then: callers must treat null as "cannot be read", never as "no processes"
  assert.equal(table, null);
});

test('Given a Windows listing that fails, exits non-zero or has no process line, When the process table is listed, Then every case is null', () => {
  // Given: three ways the PowerShell listing can go wrong, with the host simulated as win32
  const failed = listProcesses({ platform: 'win32', run: () => ({ error: new Error('spawn powershell.exe ENOENT'), status: null, stdout: '' }) });
  const exited = listProcesses({ platform: 'win32', run: () => ({ error: null, status: 1, stdout: '' }) });
  const unparsed = listProcesses({ platform: 'win32', run: () => ({ error: null, status: 0, stdout: 'no pipes in this line\n' }) });
  // Then
  assert.equal(failed, null);
  assert.equal(exited, null);
  assert.equal(unparsed, null);
});

test('Given a Windows listing with process lines, When the process table is listed, Then PowerShell runs once and every line becomes a process', () => {
  // Given: one CIM line whose command line itself contains a pipe
  const calls = [];
  const stdout = '4242|1|2026-10-10T01:02:03.1234567+02:00|node run-review.mjs --flag|x\n';
  // When
  const table = listProcesses({
    platform: 'win32',
    run: (program) => {
      calls.push(program);
      return { error: null, status: 0, stdout };
    },
  });
  // Then
  assert.deepEqual(calls, ['powershell.exe']);
  assert.deepEqual(table.map((entry) => [entry.pid, entry.ppid, entry.commandLine]), [[4242, 1, 'node run-review.mjs --flag|x']]);
});

test('Given a ps listing that fails, exits non-zero or prints nothing, When the process table is listed on a POSIX host, Then every case is null', () => {
  // Given: the same three failure shapes, with the host simulated as linux
  const failed = listProcesses({ platform: 'linux', run: () => ({ error: new Error('spawn ps ENOENT'), status: null, stdout: '' }) });
  const exited = listProcesses({ platform: 'linux', run: () => ({ error: null, status: 1, stdout: '' }) });
  const silent = listProcesses({ platform: 'linux', run: () => ({ error: null, status: 0, stdout: '' }) });
  // Then
  assert.equal(failed, null);
  assert.equal(exited, null);
  assert.equal(silent, null);
});

test('Given a ps listing, When the process table is listed on a POSIX host, Then ps runs with the table format under LC_ALL=C and every line becomes a process', () => {
  // Given
  const calls = [];
  const stdout = '   77     1 Sat Oct 10 01:02:03 2026 node run-review.mjs\n';
  // When
  const table = listProcesses({
    platform: 'darwin',
    run: (program, args, options) => {
      calls.push({ program, args, locale: options.env.LC_ALL });
      return { error: null, status: 0, stdout };
    },
  });
  // Then
  assert.deepEqual(calls, [{ program: 'ps', args: ['-A', '-o', 'pid=,ppid=,lstart=,args='], locale: 'C' }]);
  assert.deepEqual(table.map((entry) => [entry.pid, entry.ppid, entry.commandLine]), [[77, 1, 'node run-review.mjs']]);
});

// ---------------------------------------------------------------------------
// Installer without a readable plugin version

test('Given a plugin whose runner file has no version marker, When the installer stops superseded runs, Then nothing is stopped or counted', async () => {
  // Given: a private plugin root with a copy of the installer and a runner whose marker line is removed
  const pluginRoot = freshDir('plugin-nomarker');
  cpSync(path.join(path.dirname(RUNNER_PATH), '..', 'src'), path.join(pluginRoot, 'src'), { recursive: true });
  writeFileSync(path.join(pluginRoot, 'package.json'), '{ "type": "module" }\n', 'utf8');
  mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
  const runnerLines = readFileSync(RUNNER_PATH, 'utf8').split('\n');
  assert.match(runnerLines[0], /^\/\/ omp-reviewer-kit runner v\d+\.\d+\.\d+/);
  writeFileSync(path.join(pluginRoot, 'scripts', 'run-review.mjs'), runnerLines.slice(1).join('\n'), 'utf8');
  assert.equal(await readRunnerFileVersion(path.join(pluginRoot, 'scripts', 'run-review.mjs')), null);

  const runsDir = freshDir('plugin-nomarker-runs');
  const live = makeRecord({ runnerPid: 999999, runnerVersion: '0.0.1' });
  writeRecord(runsDir, live);
  const { PluginInstallerService } = await import(pathToFileURL(path.join(pluginRoot, 'src', 'application', 'installer-service.mjs')).href);
  const installer = new PluginInstallerService({ pluginRoot });

  // When
  const previous = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  let result;
  try {
    result = await installer.stopSupersededRuns({ automatic: true });
  } finally {
    process.env.OMP_REVIEW_KIT_RUNS_DIR = previous;
  }

  // Then: the early return reports nothing, not even a kept record, and the record is untouched
  assert.equal(result.currentVersion, null);
  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.unverified, []);
  assert.equal(result.kept, 0);
  assert.equal(result.disabled, undefined);
  assert.deepEqual(readRecord(runsDir, 'run-a'), live);
});

// ---------------------------------------------------------------------------
// Real processes: only children spawned here are ever signalled

test('Given a live sleeper on an older runner, When the stopper runs with the real process table, Then the sleeper exits and the record is interrupted', async () => {
  const runsDir = freshDir('e2e-stop');
  const child = startSleeper(freshDir('e2e-stop-runner'));
  try {
    const live = makeRecord({ runId: 'run-live', runnerPid: child.pid, startedAt: new Date().toISOString() });
    const done = makeRecord({ runId: 'run-done', runnerPid: child.pid, state: 'passed', startedAt: new Date().toISOString() });
    writeRecord(runsDir, live);
    writeRecord(runsDir, done);
    const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1' });
    assert.equal(await waitForExit(child), true, `the sleeper must have exited: ${JSON.stringify(result)}`);
    assert.deepEqual(result.stopped.map((entry) => entry.runId), ['run-live']);
    assert.deepEqual(result.unverified, []);
    assert.equal(result.kept, 1);
    const after = readRecord(runsDir, 'run-live');
    assert.equal(after.state, 'interrupted');
    assert.equal(after.supersededBy, '0.20.1');
    const { state, supersededBy, finishedAt, error, message, ...rest } = after;
    const { state: _state, ...liveRest } = live;
    assert.deepEqual(rest, liveRest);
    assert.deepEqual(readRecord(runsDir, 'run-done'), done);
  } finally {
    await disposeChild(child);
  }
});

test('Given a live sleeper on the current runner, When the stopper runs, Then the sleeper keeps running and the record is untouched', async () => {
  const runsDir = freshDir('e2e-equal');
  const child = startSleeper(freshDir('e2e-equal-runner'));
  try {
    const live = makeRecord({ runnerPid: child.pid, runnerVersion: '0.20.1', startedAt: new Date().toISOString() });
    writeRecord(runsDir, live);
    const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1' });
    assert.deepEqual(result.stopped, []);
    assert.equal(result.kept, 1);
    assert.equal(isRunning(child), true);
    assert.deepEqual(readRecord(runsDir, 'run-a'), live);
  } finally {
    await disposeChild(child);
  }
});

test('Given a live sleeper on an older runner, When the stopper runs as a dry run, Then the sleeper survives and the record is untouched', async () => {
  const runsDir = freshDir('e2e-dry');
  const child = startSleeper(freshDir('e2e-dry-runner'));
  try {
    const live = makeRecord({ runnerPid: child.pid, runnerVersion: '0.19.0', startedAt: new Date().toISOString() });
    writeRecord(runsDir, live);
    const result = await stopSupersededRuns({ runsDir, currentVersion: '0.20.1', dryRun: true });
    assert.deepEqual(result.stopped.map((entry) => entry.runnerPid), [child.pid]);
    assert.equal(isRunning(child), true);
    assert.deepEqual(readRecord(runsDir, 'run-a'), live);
  } finally {
    await disposeChild(child);
  }
});

// ---------------------------------------------------------------------------
// CLI

test('Given a live sleeper on an older runner, When the CLI runs with --dry-run --json, Then it reports the run and stops nothing', async () => {
  const runsDir = freshDir('cli');
  const child = startSleeper(freshDir('cli-runner'));
  try {
    const live = makeRecord({ runnerPid: child.pid, runnerVersion: '0.1.0', startedAt: new Date().toISOString() });
    writeRecord(runsDir, live);
    const run = spawnSync(process.execPath, [CLI_PATH, '--dry-run', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OMP_REVIEW_KIT_RUNS_DIR: runsDir },
      timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.currentVersion, runnerVersionString(readFileSync(RUNNER_PATH, 'utf8')));
    assert.deepEqual(parsed.stopped.map((entry) => entry.runnerPid), [child.pid]);
    assert.equal(isRunning(child), true);
    assert.deepEqual(readRecord(runsDir, 'run-a'), live);
  } finally {
    await disposeChild(child);
  }
});

test('Given an unknown flag, When the CLI runs, Then it exits 2 and prints the usage', () => {
  const run = spawnSync(process.execPath, [CLI_PATH, '--kill-everything'], {
    encoding: 'utf8',
    env: { ...process.env, OMP_REVIEW_KIT_RUNS_DIR: freshDir('cli-usage') },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown argument: --kill-everything/);
});

test('Given an unreadable runner file, When the CLI main runs, Then the version is unknown and nothing is stopped', async () => {
  const runsDir = freshDir('cli-noversion');
  writeRecord(runsDir, makeRecord());
  const previous = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  const lines = [];
  try {
    const code = await cliMain({ argv: ['--json'], out: (text) => lines.push(text), err: (text) => lines.push(text), runnerPath: path.join(runsDir, 'missing.mjs') });
    assert.equal(code, 0);
  } finally {
    process.env.OMP_REVIEW_KIT_RUNS_DIR = previous;
  }
  const parsed = JSON.parse(lines.join('\n'));
  assert.equal(parsed.currentVersion, null);
  assert.deepEqual(parsed.stopped, []);
  assert.equal(readRecord(runsDir, 'run-a').state, 'reviewing');
});

test('Given a stop result, When it is formatted, Then the table names the run, the runner and the dry-run state', () => {
  const text = formatStopResult({
    currentVersion: '0.20.1',
    dryRun: true,
    stopped: [{ runId: 'run-a', repoRoot: 'E:/r', tag: null, runnerVersion: null, runnerPid: 7 }],
    unverified: [{ runId: 'run-b', runnerPid: 8, reason: 'the process table could not be read' }],
    kept: 3,
  });
  assert.match(text, /dry run/);
  assert.match(text, /would stop {2}run-a .*from before 0\.20\.1.*pid 7/);
  assert.match(text, /left {4}run-b/);
  assert.match(text, /3 other record/);
});

test('Given the installed runner file, When its version is read, Then it matches the marker on its first line', async () => {
  const first = readFileSync(RUNNER_PATH, 'utf8').split('\n', 1)[0];
  assert.equal(await readRunnerFileVersion(RUNNER_PATH), /v(\d+\.\d+\.\d+)$/.exec(first)[1]);
  assert.equal(await readRunnerFileVersion(path.join(SCRATCH, 'nope.mjs')), null);
});

// ---------------------------------------------------------------------------
// Process termination. The fake-based tests inject the platform, the spawner, the signal sender and
// the liveness probe, so both branches run on any host. Real-process tests skip where their platform is missing.

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

test('Given a tree whose root ignores SIGTERM, When it is terminated, Then the children get SIGTERM first and every survivor gets SIGKILL after the grace period', async () => {
  const sent = [];
  const killed = new Set();
  const send = (pid, name) => {
    sent.push([pid, name]);
    if (name === 'SIGKILL') killed.add(pid);
    return true;
  };
  const table = [{ pid: 4000, ppid: 1 }, { pid: 4001, ppid: 4000 }, { pid: 4002, ppid: 4001 }];
  const outcome = await terminateTree(4001, { table, graceMs: 100, platform: 'linux', send, gone: (pid) => killed.has(pid) });
  assert.deepEqual(outcome, { signalled: [4002, 4001], refused: false });
  assert.deepEqual(sent, [[4002, 'SIGTERM'], [4001, 'SIGTERM'], [4002, 'SIGKILL'], [4001, 'SIGKILL']]);
});

test('Given a process that exits on SIGTERM, When it is terminated, Then nothing gets SIGKILL and the call returns before the grace period ends', async () => {
  const sent = [];
  const send = (pid, name) => {
    sent.push([pid, name]);
    return true;
  };
  const started = Date.now();
  const outcome = await terminateTree(4101, { table: null, graceMs: 5000, platform: 'linux', send, gone: () => true });
  assert.deepEqual(outcome, { signalled: [4101], refused: false });
  assert.deepEqual(sent, [[4101, 'SIGTERM']]);
  assert.ok(Date.now() - started < 2000, 'a process that is already gone must not wait out the grace period');
});

test('Given a POSIX child that ignores SIGTERM, When its tree is terminated for real, Then SIGKILL ends it', { skip: process.platform === 'win32' && 'POSIX signals do not exist on Windows' }, async () => {
  const child = spawn('sh', ['-c', "trap '' TERM; echo ready; exec sleep 60"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const outcome = await terminateTree(child.pid, { table: null, graceMs: 200, platform: 'linux' });
    assert.deepEqual(outcome, { signalled: [child.pid], refused: false });
    assert.equal(await waitForExit(child, 10_000), true);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    await disposeChild(child);
  }
});

test('Given a POSIX child that exits on SIGTERM, When its tree is terminated for real, Then the call returns well inside the grace period with the child gone', { skip: process.platform === 'win32' && 'POSIX signals do not exist on Windows' }, async () => {
  const child = spawn('sh', ['-c', "trap 'exit 0' TERM; echo ready; while :; do sleep 0.05; done"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const started = Date.now();
    const outcome = await terminateTree(child.pid, { table: null, graceMs: 5000, platform: 'linux' });
    assert.deepEqual(outcome, { signalled: [child.pid], refused: false });
    assert.ok(Date.now() - started < 2000, 'a child that exits on SIGTERM must not wait out the grace period');
    assert.equal(await waitForExit(child, 10_000), true);
  } finally {
    await disposeChild(child);
  }
});

test('Given a pid that has already exited, When it is terminated on the POSIX path, Then nothing is signalled and the call returns at once', async () => {
  const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
  const started = Date.now();
  const outcome = await terminateTree(dead, { table: null, graceMs: 5000, platform: 'linux' });
  assert.deepEqual(outcome, { signalled: [], refused: false });
  assert.ok(Date.now() - started < 2000, 'a dead pid is gone and must not wait out the grace period');
});

test('Given taskkill that succeeds or fails, When a tree is terminated on Windows, Then only a successful kill reports the pid as signalled', async () => {
  const calls = [];
  const succeeded = await terminateTree(4321, {
    table: null,
    platform: 'win32',
    run: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  const failed = await terminateTree(4321, { table: null, platform: 'win32', run: () => ({ status: 128 }) });
  assert.deepEqual(calls, [['taskkill', ['/PID', '4321', '/T', '/F']]]);
  assert.deepEqual(succeeded, { signalled: [4321], refused: false });
  assert.deepEqual(failed, { signalled: [], refused: false });
});

test('Given a live child on Windows, When its tree is terminated through taskkill, Then the child is gone and reported; an exited pid is reported as not signalled', { skip: process.platform !== 'win32' && 'taskkill exists only on Windows' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.deepEqual(await terminateTree(child.pid, { table: null }), { signalled: [child.pid], refused: false });
    assert.equal(await waitForExit(child, 15_000), true);
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
    assert.deepEqual(await terminateTree(dead, { table: null }), { signalled: [], refused: false });
  } finally {
    await disposeChild(child);
  }
});

test('Given a matched superseded run whose runner terminate refuses to stop, When the stop runs, Then the run is reported unverified and its record is left as it was', async () => {
  const runsDir = freshDir('refused');
  const record = makeRecord({ runnerPid: 5151, runnerVersion: '0.1.0' });
  writeRecord(runsDir, record);
  const before = readFileSync(path.join(runsDir, 'run-a.json'), 'utf8');
  const result = await stopSupersededRuns({
    runsDir,
    currentVersion: '0.20.1',
    now: NOW,
    processTable: async () => [{ pid: 5151, ppid: 1, startedAt: Date.parse(record.startedAt) - 1000, commandLine: 'node /x/run-review.mjs' }],
    terminate: async () => ({ signalled: [], refused: true }),
    liveness: () => 'alive',
    exitWaitMs: 50,
  });
  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.unverified, [{ runId: 'run-a', runnerPid: 5151, reason: 'refused to stop this process or one of its ancestors' }]);
  assert.equal(readFileSync(path.join(runsDir, 'run-a.json'), 'utf8'), before);
});

// ---------------------------------------------------------------------------
// CLI output and failure

test('Given no superseded runs, When the CLI runs without --json, Then it prints the plain-text report and not JSON', async () => {
  const runsDir = freshDir('cli-text');
  const previous = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  try {
    const out = [];
    const code = await cliMain({ argv: ['--dry-run'], out: (text) => out.push(text), err: () => {}, runnerPath: RUNNER_PATH });
    const text = out.join('\n');
    assert.equal(code, 0);
    assert.throws(() => JSON.parse(text), SyntaxError);
    assert.match(text, /^installed runner: \d+\.\d+\.\d+ \(dry run, nothing stopped\)$/m);
    assert.match(text, /^no superseded live runs$/m);
    assert.match(text, /^0 other record\(s\) untouched$/m);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
    else process.env.OMP_REVIEW_KIT_RUNS_DIR = previous;
  }
});

test('Given a live superseded runner whose record cannot be rewritten, When the CLI runs, Then it exits 2 and reports the failure on stderr', { skip: IS_ROOT && 'root ignores read-only files' }, async () => {
  const runsDir = freshDir('cli-fail');
  const child = startSleeper(freshDir('cli-fail-runner'));
  const recordFile = path.join(runsDir, 'run-a.json');
  const previous = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  try {
    writeRecord(runsDir, makeRecord({ runnerPid: child.pid, runnerVersion: '0.1.0', startedAt: new Date().toISOString() }));
    chmodSync(recordFile, 0o444);
    const out = [];
    const errs = [];
    const code = await cliMain({ argv: [], out: (text) => out.push(text), err: (text) => errs.push(text), runnerPath: RUNNER_PATH });
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(errs.join('\n'), /^stop-superseded-runs failed: /);
  } finally {
    chmodSync(recordFile, 0o644);
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
    else process.env.OMP_REVIEW_KIT_RUNS_DIR = previous;
    await disposeChild(child);
  }
});

// ---------------------------------------------------------------------------
// Session start: refreshAtSessionStart returns what the automatic stop stopped

test('Given a live review on an older runner, When a session starts, Then refreshAtSessionStart reports the run it stopped and marks its record interrupted', async () => {
  const ws = await workspace();
  mkdirSync(ws.runsDir, { recursive: true });
  const child = startSleeper(freshDir('session-runner'));
  try {
    writeRecord(ws.runsDir, makeRecord({ runId: 'run-s', runnerPid: child.pid, runnerVersion: '0.1.0', startedAt: new Date().toISOString() }));
    const { stopped } = await ws.installer.refreshAtSessionStart(ws.base);
    assert.deepEqual(stopped.map((entry) => entry.runId), ['run-s']);
    assert.equal(readRecord(ws.runsDir, 'run-s').state, 'interrupted');
    assert.equal(await waitForExit(child, 15_000), true);
  } finally {
    await disposeChild(child);
    await ws.cleanup();
  }
});

test('Given OMP_REVIEW_KIT_STOP_SUPERSEDED=0, When a session starts, Then nothing is reported stopped and the older runner keeps running', async () => {
  const ws = await workspace();
  mkdirSync(ws.runsDir, { recursive: true });
  const child = startSleeper(freshDir('session-off-runner'));
  const previous = process.env.OMP_REVIEW_KIT_STOP_SUPERSEDED;
  process.env.OMP_REVIEW_KIT_STOP_SUPERSEDED = '0';
  try {
    writeRecord(ws.runsDir, makeRecord({ runId: 'run-off', runnerPid: child.pid, runnerVersion: '0.1.0', startedAt: new Date().toISOString() }));
    const { stopped } = await ws.installer.refreshAtSessionStart(ws.base);
    assert.deepEqual(stopped, []);
    assert.equal(isRunning(child), true);
    assert.equal(readRecord(ws.runsDir, 'run-off').state, 'reviewing');
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_STOP_SUPERSEDED;
    else process.env.OMP_REVIEW_KIT_STOP_SUPERSEDED = previous;
    await disposeChild(child);
    await ws.cleanup();
  }
});
