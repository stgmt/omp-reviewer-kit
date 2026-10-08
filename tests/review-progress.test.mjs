import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import initExtension from '../src/extension.mjs';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';
import {
  classifyRun,
  DEFAULT_QUIET_MS,
  followExitCode,
  formatRunDetail,
  formatRunTable,
  lastActivityMs,
  quietThresholdMs,
  readRunRecords,
  runsForCommit,
  runsNeedingAttention,
  sameRepo,
  selectRuns,
  summarizeRun,
  summaryLine,
} from '../src/infra/review-run-records.mjs';
import { main, parseArgs } from '../scripts/review-progress.mjs';
import {
  EXIT as BRIDGE_EXIT,
  main as bridgeMain,
  progress,
  readHookInput,
  run,
  session,
} from '../claude-plugin/scripts/bridge.mjs';

const BRIDGE_PATH = fileURLToPath(new URL('../claude-plugin/scripts/bridge.mjs', import.meta.url));

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const ALIVE = () => 'alive';
const DEAD = () => 'dead';
// A pid no process can hold: the liveness check reports it dead. An exited child's pid is not used, because
// Windows reuses pids under load and a reused pid reads as alive.
const DEAD_PID = 2147483647;

function record(overrides = {}) {
  return {
    schema: 'review-run-record@1',
    runId: '2026-10-08T11-59-00-000Z-0123456789ab',
    repoRoot: null,
    tag: null,
    runnerPid: process.pid,
    state: 'reviewing',
    stage: 'risk',
    stagesCompleted: 1,
    startedAt: iso(-60_000),
    progressAt: iso(-30_000),
    childLogAt: iso(-5_000),
    updatedAt: iso(0),
    diffHash: null,
    parentSha: null,
    excludedPaths: [],
    ...overrides,
  };
}

async function writeRecord(runsDir, overrides = {}) {
  const value = record(overrides);
  await mkdir(runsDir, { recursive: true });
  await writeFile(path.join(runsDir, `${value.runId}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

// Git reports a repository by its resolved path. On Windows CI the temp folder is an 8.3 alias (C:\Users\RUNNER~1\...),
// so the fixtures use the resolved folder too, as the records the runner writes do.
async function tempDir(prefix = 'review-progress-') {
  return mkdtemp(path.join(realpathSync.native(tmpdir()), prefix));
}

function git(cwd, args, input) {
  const result = spawnSync('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=test',
    '-c', 'user.email=test@example.invalid',
    '-C', cwd,
    ...args,
  ], { input, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

async function gitRepo() {
  const dir = await tempDir('review-progress-repo-');
  git(dir, ['init', '-q']);
  return dir;
}

async function commitFiles(dir, files, message) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

function emptyTree(dir) {
  return git(dir, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim();
}

// The diff hash the runner records for a commit: the same git command and pins, with the vendored paths excluded.
function commitDiffHash(dir, sha, parent, excludedPaths = []) {
  const base = parent ?? emptyTree(dir);
  const pathspec = excludedPaths.map((file) => `:(exclude,literal)${file}`);
  const buffer = git(dir, ['diff', base, sha, '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', ...pathspec]);
  return DiffIdentity.fromBuffer(buffer, { excludedPaths }).hash;
}

function parentOf(dir, sha) {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${sha}^`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Records a passed run for `commit` with the hash the runner would record, then asks the reader for that commit.
async function assertCommitFound({ repo, commit, parent, runId }) {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId, repoRoot: repo, state: 'passed', parentSha: parent, diffHash: commitDiffHash(repo, commit, parent) });
  const sink = sinks();
  const code = await main(['--commit', commit], { cwd: repo, env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0, sink.err.join('\n'));
  assert.match(sink.out.join('\n'), new RegExp(runId));
}

// Runs /reviewer-kit:progress against `runsDir` and returns every notice it raised.
async function progressNotices(repo, runsDir) {
  const commands = new Map();
  initExtension({
    registerCommand(name, options) { commands.set(name, options); },
    on() {},
    async sendUserMessage() {},
    logger: { warn() {}, error() {} },
  });
  const notices = [];
  const previous = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  try {
    await commands.get('reviewer-kit:progress').handler('', {
      cwd: repo,
      ui: { notify: (msg, type) => notices.push({ msg, type }), setStatus() {} },
    });
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
    else process.env.OMP_REVIEW_KIT_RUNS_DIR = previous;
  }
  return notices;
}

function sinks() {
  return { out: [], err: [] };
}

// A throwaway home: the bridge looks for the installed OMP plugin under the home, which must never be the real one.
async function sandbox(extra = {}) {
  const home = await tempDir('review-progress-home-');
  return { HOME: home, USERPROFILE: home, ...extra };
}

async function fakePlugin(dir, { version = '0.20.0', reader = null } = {}) {
  const pluginDir = path.join(dir, 'plugin');
  await mkdir(path.join(pluginDir, 'src', 'application'), { recursive: true });
  await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version }));
  // A stub installer: the session hook only asks it for the status of the cwd.
  await writeFile(
    path.join(pluginDir, 'src', 'application', 'installer-service.mjs'),
    'export class PluginInstallerService { async status() { return { isGitRepo: false }; } }\n',
  );
  if (reader !== null) {
    await mkdir(path.join(pluginDir, 'scripts'), { recursive: true });
    await writeFile(path.join(pluginDir, 'scripts', 'review-progress.mjs'), reader);
  }
  return pluginDir;
}

// Fake `omp` probes; node runs for real so the reader stub executes.
const fakeOmp = (command, args, options) => (command === process.execPath
  ? run(command, args, options)
  : { status: 0, stdout: '1.0.0', stderr: '', error: undefined });

test('Given two runs written by two repositories, When the runs folder is read, Then both come back newest start first', async () => {
  const dir = await tempDir();
  await writeRecord(dir, { runId: 'run-a', repoRoot: 'C:/a', startedAt: iso(-120_000) });
  await writeRecord(dir, { runId: 'run-b', repoRoot: 'C:/b', startedAt: iso(-60_000) });
  const records = await readRunRecords(dir);
  assert.deepEqual(records.map((entry) => entry.runId), ['run-b', 'run-a']);
});

test('Given a partly written file and a foreign JSON file beside a run record, When the folder is read, Then only the run record is returned', async () => {
  const dir = await tempDir();
  await writeRecord(dir, { runId: 'run-ok' });
  await writeFile(path.join(dir, 'half.json'), '{"schema":"review-run-record@1","runId":');
  await writeFile(path.join(dir, 'other.json'), '{"schema":"something-else@1","runId":"other"}');
  const records = await readRunRecords(dir);
  assert.deepEqual(records.map((entry) => entry.runId), ['run-ok']);
});

test('Given a missing runs folder, When it is read, Then the result is empty instead of an error', async () => {
  assert.deepEqual(await readRunRecords(path.join(await tempDir(), 'missing')), []);
});

test('Given a finished record, When classified, Then it is done whatever the runner pid says', () => {
  assert.equal(classifyRun(record({ state: 'passed' }), { now: NOW, liveness: DEAD }), 'done');
});

test('Given a live state whose runner process is gone, When classified, Then it is orphaned', () => {
  assert.equal(classifyRun(record(), { now: NOW, liveness: DEAD }), 'orphaned');
});

test('Given a live runner whose OMP child logged recently, When classified, Then it is active', () => {
  assert.equal(classifyRun(record(), { now: NOW, liveness: ALIVE }), 'active');
});

test('Given a live runner whose OMP child has logged nothing past the threshold, When classified, Then it is quiet even though the heartbeat keeps updating', () => {
  const silent = record({
    startedAt: iso(-(DEFAULT_QUIET_MS + 3_000)),
    progressAt: iso(-(DEFAULT_QUIET_MS + 2_000)),
    childLogAt: iso(-(DEFAULT_QUIET_MS + 1_000)),
    updatedAt: iso(0),
  });
  assert.equal(classifyRun(silent, { now: NOW, liveness: ALIVE }), 'quiet');
});

test('Given a live run with no activity timestamp at all, When classified, Then it is active because silence cannot be measured', () => {
  const bare = record({ startedAt: undefined, progressAt: undefined, childLogAt: undefined });
  assert.equal(classifyRun(bare, { now: NOW, liveness: ALIVE }), 'active');
});

test('Given a stage change and a later OMP log line, When the last activity is read, Then the latest of the two is used', () => {
  const at = lastActivityMs(record({ progressAt: iso(-9_000), childLogAt: iso(-1_000), startedAt: iso(-20_000) }));
  assert.equal(at, NOW - 1_000);
});

test('Given the quiet threshold variable, When it is valid, Then it is used; when it is not, Then the default applies', () => {
  assert.equal(quietThresholdMs({}), DEFAULT_QUIET_MS);
  assert.equal(quietThresholdMs({ OMP_REVIEW_KIT_QUIET_MS: '60000' }), 60_000);
  for (const bad of ['soon', '0', '-5', '']) {
    assert.equal(quietThresholdMs({ OMP_REVIEW_KIT_QUIET_MS: bad }), DEFAULT_QUIET_MS, `value ${JSON.stringify(bad)}`);
  }
});

test('Given runs of two repositories and two sessions, When selected by run, tag, all or repository, Then exactly those runs are chosen', () => {
  const a = record({ runId: 'run-a', repoRoot: 'C:/repo-a', tag: 'sess-1' });
  const b = record({ runId: 'run-b', repoRoot: 'C:/repo-b', tag: 'sess-1' });
  const c = record({ runId: 'run-c', repoRoot: 'C:/repo-a', tag: 'sess-2' });
  const all = [a, b, c];
  const ids = (list) => list.map((entry) => entry.runId);
  assert.deepEqual(ids(selectRuns(all, { runId: 'run-b' })), ['run-b']);
  assert.deepEqual(ids(selectRuns(all, { tag: 'sess-1' })), ['run-a', 'run-b']);
  assert.deepEqual(ids(selectRuns(all, { all: true })), ['run-a', 'run-b', 'run-c']);
  assert.deepEqual(ids(selectRuns(all, { repoRoot: 'C:/repo-a' })), ['run-a', 'run-c']);
  assert.deepEqual(ids(selectRuns(all, {})), [], 'no scope given selects nothing');
});

test('Given two spellings of one Windows folder, When compared, Then they match only on Windows', () => {
  assert.equal(sameRepo('C:\\Repos\\Kit', 'c:\\repos\\kit'), process.platform === 'win32');
  assert.equal(sameRepo(null, 'C:\\Repos\\Kit'), false);
  assert.equal(sameRepo('', ''), false);
});

test('Given unfinished runs of this session in another repository and of this repository, When the session-start scope is read, Then old repository runs and finished runs are left out', () => {
  const now = NOW;
  const otherRepoSameSession = record({ runId: 'mine-elsewhere', repoRoot: 'C:/other', tag: 'sess-1', updatedAt: iso(-10 * 24 * 3600_000) });
  const recentHere = record({ runId: 'here-recent', repoRoot: 'C:/here', updatedAt: iso(-30 * 60_000) });
  const oldHere = record({ runId: 'here-old', repoRoot: 'C:/here', updatedAt: iso(-3 * 3600_000) });
  const finishedHere = record({ runId: 'here-done', repoRoot: 'C:/here', state: 'passed', updatedAt: iso(-60_000) });
  const strangerRecent = record({ runId: 'stranger', repoRoot: 'C:/elsewhere', updatedAt: iso(-60_000) });
  const picked = runsNeedingAttention(
    [otherRepoSameSession, recentHere, oldHere, finishedHere, strangerRecent],
    { repoRoot: 'C:/here', tag: 'sess-1', now, liveness: ALIVE },
  );
  assert.deepEqual(picked.map((summary) => summary.runId).sort(), ['here-recent', 'mine-elsewhere']);
});

test('Given no unfinished runs, When the summary line is built, Then it is empty', () => {
  assert.equal(summaryLine([]), '');
});

test('Given five unfinished runs, When the summary line is built, Then three are named and the rest are counted', () => {
  const summaries = [1, 2, 3, 4, 5].map((index) => summarizeRun(record({ runId: `run-${index}` }), { now: NOW, liveness: ALIVE }));
  const line = summaryLine(summaries);
  assert.match(line, /^5 commit review\(s\) not finished: run-1 \(active, stage risk\); run-2 \(active, stage risk\); run-3 \(active, stage risk\) and 2 more\./);
  assert.match(line, /review-progress skill/);
});

test('Given a quiet run with a review pid, When its detail is printed, Then the kill hint names that pid and the kit says it stops nothing', () => {
  const summary = summarizeRun(record({ pid: 4321, childLogAt: iso(-(DEFAULT_QUIET_MS + 60_000)), progressAt: undefined, startedAt: iso(-(DEFAULT_QUIET_MS + 90_000)) }), { now: NOW, liveness: ALIVE });
  const detail = formatRunDetail(summary);
  assert.equal(summary.classification, 'quiet');
  assert.match(detail, /(taskkill \/PID|kill) 4321/);
  assert.match(detail, /Nothing here stops it/);
});

test('Given an orphaned run, When its detail is printed, Then it says no process is left and gives no kill command', () => {
  const summary = summarizeRun(record({ pid: 4321 }), { now: NOW, liveness: DEAD });
  const detail = formatRunDetail(summary);
  assert.equal(summary.classification, 'orphaned');
  assert.match(detail, /runner process is gone/);
  assert.doesNotMatch(detail, /taskkill|kill 4321/);
});

test('Given an active run and a follow command, When its detail is printed, Then the follow command is shown', () => {
  const summary = summarizeRun(record(), { now: NOW, liveness: ALIVE });
  assert.match(formatRunDetail(summary, { followCommand: 'node follow.mjs --run x --follow' }), /follow: +node follow\.mjs/);
});

test('Given runs in a table, When it is printed, Then there is a header, one row per run, and no trailing padding', () => {
  const table = formatRunTable([
    summarizeRun(record({ runId: 'short' }), { now: NOW, liveness: ALIVE }),
    summarizeRun(record({ runId: 'a-much-longer-run-identifier', state: 'passed' }), { now: NOW, liveness: ALIVE }),
  ]);
  const lines = table.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^RUN\s+STATE\s+STAGE\s+SILENT\s+VERDICT\s+TAG$/);
  assert.ok(lines.every((line) => line === line.trimEnd()), 'no trailing spaces');
  assert.equal(formatRunTable([]), 'No review runs.');
});

test('Given run states, When their exit codes are read for a followed run, Then only a finished run has one', () => {
  assert.equal(followExitCode({ classification: 'active', state: 'reviewing' }), null);
  assert.equal(followExitCode({ classification: 'done', state: 'passed' }), 0);
  assert.equal(followExitCode({ classification: 'done', state: 'skipped' }), 0);
  assert.equal(followExitCode({ classification: 'done', state: 'blocked' }), 1);
  assert.equal(followExitCode({ classification: 'done', state: 'failed' }), 1);
  assert.equal(followExitCode({ classification: 'done', state: 'interrupted' }), 1);
  assert.equal(followExitCode({ classification: 'quiet', state: 'reviewing' }), 3);
  assert.equal(followExitCode({ classification: 'orphaned', state: 'reviewing' }), 3);
});

test('Given runs and a commit diff hash that depends on each run\'s excluded paths, When matched to a commit, Then only the run with that diff matches and the hash is computed once per exclusion set', async () => {
  const runs = [
    record({ runId: 'with-mirror-out', parentSha: 'p1', diffHash: 'h-1', excludedPaths: ['mirror.mjs'] }),
    record({ runId: 'no-exclusions', parentSha: 'p1', diffHash: 'h-2', excludedPaths: [] }),
    record({ runId: 'other-parent', parentSha: 'p2', diffHash: 'h-1', excludedPaths: ['mirror.mjs'] }),
  ];
  const calls = [];
  const matched = await runsForCommit(runs, {
    parentSha: 'p1',
    diffHashOf: async (excluded) => {
      calls.push(excluded);
      return excluded.length ? 'h-1' : 'h-2';
    },
  });
  assert.deepEqual(matched.map((entry) => entry.runId), ['with-mirror-out', 'no-exclusions']);
  assert.equal(calls.length, 2, 'one hash per distinct exclusion set');
});

test('Given the arguments, When they are parsed, Then unknown flags, malformed ids and a follow without a run are refused', () => {
  assert.throws(() => parseArgs(['--follow']), /--follow needs --run/);
  assert.throws(() => parseArgs(['--run', '../escape']), /not a run id/);
  assert.throws(() => parseArgs(['--commit', 'not-a-sha']), /not a commit id/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--run']), /needs a value/);
  assert.deepEqual(parseArgs(['--run', 'run-1', '--follow']).follow, true);
});

test('Given runs of two repositories, When the reader runs inside one of them, Then only that repository\'s runs are listed', async () => {
  const repoA = await gitRepo();
  const repoB = await gitRepo();
  await commitFiles(repoA, { 'a.txt': 'a\n' }, 'a');
  await commitFiles(repoB, { 'b.txt': 'b\n' }, 'b');
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'run-in-a', repoRoot: repoA });
  await writeRecord(runsDir, { runId: 'run-in-b', repoRoot: repoB });
  const sink = sinks();
  const code = await main([], { cwd: repoA, env: {}, runsDir, now: () => NOW, out: (line) => sink.out.push(line), err: (line) => sink.err.push(line) });
  assert.equal(code, 0);
  const text = sink.out.join('\n');
  assert.match(text, /run-in-a/);
  assert.doesNotMatch(text, /run-in-b/);
});

test('Given no Git repository and no --all, When the reader runs, Then it exits 2 and says what to use instead', async () => {
  const sink = sinks();
  const code = await main([], { cwd: await tempDir(), env: {}, runsDir: await tempDir(), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 2);
  assert.match(sink.err.join('\n'), /Not inside a git repository/);
});

test('Given --mine without a session tag, When the reader runs, Then it exits 2 with the reason', async () => {
  const sink = sinks();
  const code = await main(['--mine'], { cwd: await tempDir(), env: {}, runsDir: await tempDir(), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 2);
  assert.match(sink.err.join('\n'), /no Claude session tag/);
});

test('Given runs of two sessions in two repositories, When --mine runs with one session tag, Then that session\'s runs appear in every repository', async () => {
  const repoA = await gitRepo();
  const repoB = await gitRepo();
  await commitFiles(repoA, { 'a.txt': 'a\n' }, 'a');
  await commitFiles(repoB, { 'b.txt': 'b\n' }, 'b');
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'mine-in-a', repoRoot: repoA, tag: 'sess-1' });
  await writeRecord(runsDir, { runId: 'mine-in-b', repoRoot: repoB, tag: 'sess-1' });
  await writeRecord(runsDir, { runId: 'theirs', repoRoot: repoA, tag: 'sess-2' });
  const sink = sinks();
  const code = await main(['--mine'], { cwd: repoA, env: { OMP_REVIEW_KIT_RUN_TAG: 'sess-1' }, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0);
  const text = sink.out.join('\n');
  assert.match(text, /mine-in-a/);
  assert.match(text, /mine-in-b/);
  assert.doesNotMatch(text, /theirs/);
});

test('Given a quiet run, When its detail is requested by run id, Then the reader explains it and gives the review pid and exit 0', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, {
    runId: 'quiet-run',
    pid: 4321,
    startedAt: iso(-(DEFAULT_QUIET_MS + 90_000)),
    progressAt: iso(-(DEFAULT_QUIET_MS + 80_000)),
    childLogAt: iso(-(DEFAULT_QUIET_MS + 60_000)),
  });
  const sink = sinks();
  const code = await main(['--run', 'quiet-run'], { cwd: await tempDir(), env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0);
  const text = sink.out.join('\n');
  assert.match(text, /quiet \(reviewing\)/);
  assert.match(text, /(taskkill \/PID|kill) 4321/);
});

test('Given a run id that has no record, When its detail is requested, Then the reader exits 1 and says so', async () => {
  const sink = sinks();
  const code = await main(['--run', 'nothing-here'], { cwd: await tempDir(), env: {}, runsDir: await tempDir(), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 1);
  assert.match(sink.err.join('\n'), /no review run nothing-here/);
});

test('Given a run that already passed, When it is followed, Then its final state prints at once with exit 0 and nothing waits', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'done-pass', state: 'passed', verdict: undefined, finishedAt: iso(-1_000) });
  const sink = sinks();
  const code = await main(['--run', 'done-pass', '--follow'], {
    cwd: await tempDir(), env: {}, runsDir, now: () => NOW,
    sleep: async () => assert.fail('a finished run must not be waited for'),
    out: (l) => sink.out.push(l), err: (l) => sink.err.push(l),
  });
  assert.equal(code, 0);
  assert.match(sink.out.join('\n'), /done passed/);
});

test('Given a run that blocked, When it is followed, Then the reader exits 1', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'done-block', state: 'blocked' });
  const code = await main(['--run', 'done-block', '--follow'], { cwd: await tempDir(), env: {}, runsDir, now: () => NOW, sleep: async () => {}, out: () => {}, err: () => {} });
  assert.equal(code, 1);
});

test('Given a run whose runner is gone, When it is followed, Then the reader exits 3 and reports it as orphaned', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'gone-run', runnerPid: DEAD_PID });
  const sink = sinks();
  const code = await main(['--run', 'gone-run', '--follow'], { cwd: await tempDir(), env: {}, runsDir, now: () => NOW, sleep: async () => {}, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 3);
  assert.match(sink.out.join('\n'), /orphaned/);
});

test('Given an active run that finishes while it is followed, When the reader polls, Then it reports each change and exits with the verdict code', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'live-run', stage: 'scout', stagesCompleted: 0 });
  let polls = 0;
  const sink = sinks();
  const code = await main(['--run', 'live-run', '--follow'], {
    cwd: await tempDir(), env: {}, runsDir, now: () => NOW,
    sleep: async () => {
      polls += 1;
      if (polls === 1) await writeRecord(runsDir, { runId: 'live-run', stage: 'risk', stagesCompleted: 1 });
      else await writeRecord(runsDir, { runId: 'live-run', state: 'passed', stage: 'verifier', stagesCompleted: 2 });
    },
    out: (l) => sink.out.push(l), err: (l) => sink.err.push(l),
  });
  assert.equal(code, 0);
  const text = sink.out.join('\n');
  assert.match(text, /active reviewing stage=scout/);
  assert.match(text, /active reviewing stage=risk/);
  assert.match(text, /done passed stage=verifier/);
});

test('Given a run whose record disappears while it is followed, When the reader polls, Then it exits 1', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  const sink = sinks();
  const code = await main(['--run', 'vanished', '--follow'], { cwd: await tempDir(), env: {}, runsDir, now: () => NOW, sleep: async () => {}, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 1);
  assert.match(sink.out.join('\n'), /no record/);
});

test('Given a record that is half-written while it is followed, When the reader polls, Then it waits for the rewrite instead of exiting 1', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeFile(path.join(runsDir, 'torn-run.json'), '');
  const sink = sinks();
  const code = await main(['--run', 'torn-run', '--follow'], {
    cwd: await tempDir(), env: {}, runsDir, now: () => NOW,
    sleep: async () => {
      await writeRecord(runsDir, { runId: 'torn-run', state: 'passed', stage: 'verifier', stagesCompleted: 2 });
    },
    out: (l) => sink.out.push(l), err: (l) => sink.err.push(l),
  });
  assert.equal(code, 0);
  assert.doesNotMatch(sink.out.join('\n'), /no record/);
  assert.match(sink.out.join('\n'), /done passed stage=verifier/);
});

test('Given a record that stays unreadable for a whole quiet period, When it is followed, Then the reader stops waiting and exits 3', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeFile(path.join(runsDir, 'broken-run.json'), '{"schema":');
  let clock = NOW;
  let polls = 0;
  const sink = sinks();
  const code = await main(['--run', 'broken-run', '--follow'], {
    cwd: await tempDir(), env: { OMP_REVIEW_KIT_QUIET_MS: '60000' }, runsDir, now: () => clock,
    sleep: async () => {
      polls += 1;
      if (polls > 100) throw new Error('followed past the quiet period');
      clock += 10_000;
    },
    out: (l) => sink.out.push(l), err: (l) => sink.err.push(l),
  });
  assert.equal(code, 3);
  assert.match(sink.out.join('\n'), /record unreadable for 60 s/);
});

test('Given a commit reviewed by a kit run, When the reader is asked for that commit, Then the run is found even though the mirror was left out of the review', async () => {
  const repo = await gitRepo();
  const first = await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n', '.omp/review-kit/run-review.mjs': 'mirror\n' }, 'second');
  const mirror = '.omp/review-kit/run-review.mjs';
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, {
    runId: 'reviewed-second',
    repoRoot: repo,
    state: 'passed',
    parentSha: first,
    diffHash: commitDiffHash(repo, second, first, [mirror]),
    excludedPaths: [mirror],
  });
  const sink = sinks();
  const code = await main(['--commit', second], { cwd: repo, env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0);
  assert.match(sink.out.join('\n'), /reviewed-second/);
});

test('Given a repository whose git colours diff output, When the reader is asked for a commit the kit reviewed, Then the run is found', async () => {
  const repo = await gitRepo();
  git(repo, ['config', 'color.diff', 'always']);
  const first = await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, {
    runId: 'reviewed-coloured',
    repoRoot: repo,
    state: 'passed',
    parentSha: first,
    diffHash: commitDiffHash(repo, second, first),
  });
  const sink = sinks();
  const code = await main(['--commit', second], { cwd: repo, env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0);
  assert.match(sink.out.join('\n'), /reviewed-coloured/);
});

test('Given the root commit of a repository was reviewed, When the reader is asked for it, Then the run is found against the empty tree', async () => {
  const repo = await gitRepo();
  const root = await commitFiles(repo, { 'app.txt': 'root\n' }, 'root');
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'reviewed-root', repoRoot: repo, state: 'passed', parentSha: null, diffHash: commitDiffHash(repo, root, null) });
  const sink = sinks();
  const code = await main(['--commit', root], { cwd: repo, env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0);
  assert.match(sink.out.join('\n'), /reviewed-root/);
});

test('Given a commit that no run reviewed, When the reader is asked for it, Then it exits 1 and says the run may be missing', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  const sink = sinks();
  const code = await main(['--commit', second], { cwd: repo, env: {}, runsDir: await tempDir(), now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 1);
  assert.match(sink.out.join('\n'), /No review run reviewed commit/);
});

test('Given a commit that no run reviewed, When the reader is asked for it as JSON, Then stdout is an empty JSON array and the exit code is 1', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  const sink = sinks();
  const code = await main(['--commit', second, '--json'], { cwd: repo, env: {}, runsDir: await tempDir(), now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(sink.out.join('\n')), []);
});

test('Given a run record that exists but cannot be read, When the reader is asked for that run, Then it exits 3 and does not report the run as absent', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeFile(path.join(runsDir, 'torn.json'), '{ "schema": "review-run-rec');
  const sink = sinks();
  const code = await main(['--run', 'torn'], { cwd: await tempDir(), env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 3);
  assert.match(sink.err.join('\n'), /record exists but cannot be read/);
  assert.doesNotMatch(sink.err.join('\n'), /no review run/);
});

test('Given a record that cannot be read yet and was written just now, When the reader is asked for a commit no run matches, Then it exits 3 and asks for another try', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  const runsDir = await tempDir('review-progress-runs-');
  await writeFile(path.join(runsDir, 'writing.json'), '{ "schema"');
  const sink = sinks();
  const code = await main(['--commit', second, '--json'], { cwd: repo, env: {}, runsDir, now: () => Date.now(), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(sink.out.join('\n')), []);
  assert.match(sink.err.join('\n'), /cannot be read yet .*try again/);
});

test('Given a record that cannot be read and is older than the quiet period, When the reader is asked for a commit no run matches, Then it exits 1 as for an unreviewed commit', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  const runsDir = await tempDir('review-progress-runs-');
  await writeFile(path.join(runsDir, 'torn-old.json'), '{ "schema"');
  const sink = sinks();
  const code = await main(['--commit', second], { cwd: repo, env: {}, runsDir, now: () => Date.now() + 60 * 60 * 1000, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 1);
  assert.match(sink.out.join('\n'), /No review run reviewed commit/);
});

test('Given a run of the same parent commit whose diff differs, When the reader is asked for a commit, Then that run is not matched', async () => {
  const repo = await gitRepo();
  const first = await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'other-diff', repoRoot: repo, state: 'passed', parentSha: first, diffHash: 'not-this-diff' });
  const sink = sinks();
  const code = await main(['--commit', second], { cwd: repo, env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 1);
  assert.doesNotMatch(sink.out.join('\n'), /other-diff/);
});

test('Given a value that is not a commit of the repository, When --commit is given it, Then the reader exits 2', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const sink = sinks();
  const code = await main(['--commit', 'abcdef1'], { cwd: repo, env: {}, runsDir: await tempDir(), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 2);
  assert.match(sink.err.join('\n'), /not a commit in this repository/);
});

test('Given an active run of one session, When the summary is asked for, Then its session and the same repository see it, and a repository without runs prints nothing', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const elsewhere = await gitRepo();
  await commitFiles(elsewhere, { 'b.txt': 'b\n' }, 'b');
  const runsDir = await tempDir('review-progress-runs-');
  const now = new Date().toISOString();
  await writeRecord(runsDir, { runId: 'summary-run', repoRoot: repo, tag: 'sess-9', childLogAt: now, updatedAt: now });
  const summaryOf = async (cwd, tag) => {
    const sink = sinks();
    const code = await main(['--summary'], { cwd, env: { OMP_REVIEW_KIT_RUN_TAG: tag }, runsDir, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
    assert.equal(code, 0);
    return sink.out.join('\n');
  };
  assert.match(await summaryOf(repo, 'sess-9'), /summary-run \(active/);
  assert.match(await summaryOf(repo, 'sess-other'), /summary-run \(active/, 'the same repository shows the run to every session');
  assert.equal(await summaryOf(elsewhere, 'sess-other'), '');
});

test('Given the SessionStart input with a session id and an environment file, When the session starts, Then the id is exported as the run tag', async () => {
  const dir = await tempDir();
  const envFile = path.join(dir, 'claude-env.sh');
  await writeFile(envFile, '');
  const sink = sinks();
  await session({ cwd: dir, env: await sandbox(), exec: fakeOmp, out: (l) => sink.out.push(l), sessionId: 'sess-42', envFile });
  assert.equal(await readFile(envFile, 'utf8'), 'export OMP_REVIEW_KIT_RUN_TAG="sess-42"\n');
});

test('Given a session id that is not a plain token, When the session starts, Then nothing is written to the environment file', async () => {
  const dir = await tempDir();
  const envFile = path.join(dir, 'claude-env.sh');
  await writeFile(envFile, '');
  await session({ cwd: dir, env: await sandbox(), exec: fakeOmp, out: () => {}, sessionId: 'x"; rm -rf ~; "', envFile });
  assert.equal(await readFile(envFile, 'utf8'), '');
});

test('Given an installed reader, When the session starts, Then its summary is added to the context with the session tag in the environment', async () => {
  const dir = await tempDir();
  const pluginDir = await fakePlugin(dir, {
    reader: "process.stdout.write('TAG=' + (process.env.OMP_REVIEW_KIT_RUN_TAG ?? '') + ' ARGS=' + process.argv.slice(2).join(' ') + '\\n');\n",
  });
  const sink = sinks();
  await session({ cwd: dir, env: await sandbox({ OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir }), exec: fakeOmp, out: (l) => sink.out.push(l), sessionId: 'sess-42' });
  const payload = JSON.parse(sink.out[0]);
  assert.match(payload.hookSpecificOutput.additionalContext, /TAG=sess-42 ARGS=--summary/);
});

test('Given an installed plugin without the reader, When the session starts, Then the session stays silent about progress', async () => {
  const dir = await tempDir();
  const pluginDir = await fakePlugin(dir, { reader: null });
  const sink = sinks();
  assert.equal(await session({ cwd: dir, env: await sandbox({ OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir }), exec: fakeOmp, out: (l) => sink.out.push(l), sessionId: 'sess-42' }), BRIDGE_EXIT.ok);
  assert.deepEqual(sink.out, []);
});

test('Given the reader in the installed plugin, When progress is asked, Then the bridge runs it with the same arguments and returns its exit code', async () => {
  const dir = await tempDir();
  const argsFile = path.join(dir, 'args.json');
  const pluginDir = await fakePlugin(dir, {
    reader: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 3;\n`,
  });
  const code = progress({ argv: ['--run', 'run-1', '--follow'], cwd: dir, env: await sandbox({ OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir }), exec: fakeOmp });
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), ['--run', 'run-1', '--follow']);
});

test('Given an OMP plugin that predates the reader, When progress is asked, Then the bridge exits 2 and asks for 0.20.0', async () => {
  const dir = await tempDir();
  const pluginDir = await fakePlugin(dir, { version: '0.19.1', reader: null });
  const errors = [];
  const code = progress({ argv: ['--mine'], cwd: dir, env: await sandbox({ OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir }), exec: fakeOmp, err: (line) => errors.push(line) });
  assert.equal(code, BRIDGE_EXIT.infra);
  assert.match(errors.join('\n'), /0\.20\.0 or newer is needed/);
});

test('Given the SessionStart input on stdin, When it is read, Then the session id comes back', async () => {
  const stdin = new PassThrough();
  stdin.end('{"session_id":"sess-7"}');
  assert.deepEqual(await readHookInput(stdin, 500), { session_id: 'sess-7' });
});

test('Given stdin that never closes, When it is read, Then the read gives up at the timeout with no input', async () => {
  const stdin = new PassThrough();
  const started = Date.now();
  assert.deepEqual(await readHookInput(stdin, 50), {});
  assert.ok(Date.now() - started < 1000, 'the wait is bounded');
});

test('Given the review-progress skill, Then it is discoverable, allows node, and names the progress commands', async () => {
  const text = (await readFile('claude-plugin/skills/review-progress/SKILL.md', 'utf8')).replace(/\r\n/g, '\n');
  assert.match(text, /^---\nname: review-progress\n/);
  assert.match(text, /allowed-tools: Bash\(node \*\)/);
  assert.match(text, /bridge\.mjs" progress --mine/);
  assert.match(text, /progress --run <runId> --follow/);
  assert.match(text, /never stop a process/i);
});

test('Given a Git project with recorded runs, When /reviewer-kit:progress runs, Then the project\'s runs are notified with the table', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'extension-run', repoRoot: repo, childLogAt: new Date().toISOString(), startedAt: new Date().toISOString(), progressAt: new Date().toISOString() });
  const notes = await progressNotices(repo, runsDir);
  assert.equal(notes.length, 1);
  assert.match(notes[0].msg, /RUN\s+STATE/);
  assert.match(notes[0].msg, /extension-run/);
  assert.equal(notes[0].type, 'info');
});

test('Given a directory that is not a Git repository, When /reviewer-kit:progress runs, Then one warning says so and no run table follows', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'finished-run', state: 'passed', stage: 'verifier', stagesCompleted: 2 });
  const notices = await progressNotices(await tempDir(), runsDir);
  assert.deepEqual(notices.map((notice) => notice.type), ['warning']);
  assert.match(notices[0].msg, /active directory is not a Git repository/);
});

test('Given a Git project without review runs, When /reviewer-kit:progress runs, Then one info notice says so', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const notes = await progressNotices(repo, await tempDir('review-progress-runs-'));
  assert.equal(notes.length, 1);
  assert.match(notes[0].msg, /no review runs recorded for this project/);
  assert.equal(notes[0].type, 'info');
});

test('Given a Git project with a quiet run, When /reviewer-kit:progress runs, Then the notice is a warning', async () => {
  const repo = await gitRepo();
  await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const runsDir = await tempDir('review-progress-runs-');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeRecord(runsDir, { runId: 'quiet-notice', repoRoot: repo, startedAt: hourAgo, progressAt: hourAgo, childLogAt: hourAgo });
  const notes = await progressNotices(repo, runsDir);
  assert.equal(notes[0].type, 'warning');
  assert.match(notes[0].msg, /quiet-notice/);
});

test('Given an installer that fails, When /reviewer-kit:progress runs, Then the failure is an error notice', async () => {
  const repo = await gitRepo();
  const original = PluginInstallerService.prototype.status;
  PluginInstallerService.prototype.status = async () => {
    throw new Error('boom');
  };
  try {
    const notes = await progressNotices(repo, await tempDir('review-progress-runs-'));
    assert.equal(notes[0].type, 'error');
    assert.match(notes[0].msg, /progress check failed: boom/);
  } finally {
    PluginInstallerService.prototype.status = original;
  }
});

test('Given a quiet run, When its detail is requested as JSON, Then the output parses with its run id and classification and the reader exits 0', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, {
    runId: 'quiet-json',
    pid: 4321,
    startedAt: iso(-(DEFAULT_QUIET_MS + 90_000)),
    progressAt: iso(-(DEFAULT_QUIET_MS + 80_000)),
    childLogAt: iso(-(DEFAULT_QUIET_MS + 60_000)),
  });
  const sink = sinks();
  const code = await main(['--run', 'quiet-json', '--json'], { cwd: await tempDir(), env: {}, runsDir, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 0);
  const summary = JSON.parse(sink.out.join('\n'));
  assert.equal(summary.runId, 'quiet-json');
  assert.equal(summary.classification, 'quiet');
});

test('Given a folder outside any repository, When --commit is asked, Then the reader exits 2 and says a repository is needed', async () => {
  const sink = sinks();
  const code = await main(['--commit', 'abc1234'], { cwd: await tempDir(), env: {}, runsDir: await tempDir(), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  assert.equal(code, 2);
  assert.match(sink.err.join('\n'), /--commit needs a git repository/);
});

test('Given a run whose state does not change between polls, When it is followed, Then its active line is printed once', async () => {
  const runsDir = await tempDir('review-progress-runs-');
  await writeRecord(runsDir, { runId: 'steady-run', stage: 'scout', stagesCompleted: 0 });
  let polls = 0;
  const sink = sinks();
  const code = await main(['--run', 'steady-run', '--follow'], {
    cwd: await tempDir(), env: {}, runsDir, now: () => NOW,
    sleep: async () => {
      polls += 1;
      if (polls === 2) await writeRecord(runsDir, { runId: 'steady-run', state: 'passed', stage: 'verifier', stagesCompleted: 2 });
    },
    out: (l) => sink.out.push(l), err: (l) => sink.err.push(l),
  });
  assert.equal(code, 0);
  assert.equal(sink.out.filter((line) => line.includes('active reviewing stage=scout')).length, 1);
  assert.match(sink.out.join('\n'), /done passed stage=verifier/);
});

test('Given a repository that drops diff prefixes by setting, When the reader is asked for a commit the kit reviewed, Then the run is found', async () => {
  const repo = await gitRepo();
  git(repo, ['config', 'diff.noprefix', 'true']);
  const first = await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  await assertCommitFound({ repo, commit: second, parent: first, runId: 'reviewed-noprefix' });
});

test('Given a commit that adds a binary file, When the reader is asked for it, Then the run is found with the binary bytes hashed', async () => {
  const repo = await gitRepo();
  const first = await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'logo.bin': Buffer.from([0, 1, 2, 255, 0, 7]) }, 'binary');
  await assertCommitFound({ repo, commit: second, parent: first, runId: 'reviewed-binary' });
});

test('Given a repository whose git runs an external diff tool, When the reader is asked for a commit the kit reviewed, Then the run is found', async () => {
  const repo = await gitRepo();
  const first = await commitFiles(repo, { 'app.txt': 'one\n' }, 'first');
  const second = await commitFiles(repo, { 'app.txt': 'two\n' }, 'second');
  git(repo, ['config', 'diff.external', 'echo external-diff']);
  await assertCommitFound({ repo, commit: second, parent: first, runId: 'reviewed-external' });
});

test('Given no installed OMP plugin, When progress is asked, Then the bridge exits 2 with the setup hint and runs no reader', async () => {
  const calls = [];
  const errors = [];
  const code = progress({
    argv: ['--mine'],
    cwd: await tempDir(),
    env: await sandbox(),
    exec: (command, args) => {
      calls.push([command, args]);
      return { status: 1, stdout: '', stderr: '' };
    },
    err: (line) => errors.push(line),
  });
  assert.equal(code, BRIDGE_EXIT.infra);
  assert.match(errors.join('\n'), /is not installed\. Run \/omp-reviewer-kit:install-omp\./);
  assert.equal(calls.some(([command]) => command === process.execPath), false);
});

test('Given the installed reader, When the bridge runs progress with a flag it does not know, Then the reader receives exactly those arguments', async () => {
  const dir = await tempDir();
  const argsFile = path.join(dir, 'args.json');
  const pluginDir = await fakePlugin(dir, {
    reader: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`,
  });
  const code = await bridgeMain(['progress', '--abc'], await sandbox({ OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir }), dir);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), ['--abc']);
});

test('Given a SessionStart input with a session id, When the bridge session command runs as the hook, Then the id is exported as the run tag', async () => {
  const dir = await tempDir();
  const envFile = path.join(dir, 'claude-env.sh');
  await writeFile(envFile, '');
  const env = { ...process.env, ...(await sandbox()), CLAUDE_ENV_FILE: envFile, OMP_REVIEW_KIT_OMP: path.join(dir, 'no-such-omp') };
  delete env.OMP_REVIEW_KIT_PLUGIN_DIR;
  const hook = spawnSync(process.execPath, [BRIDGE_PATH, 'session'], { input: '{"session_id":"sess-5"}', env, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(await readFile(envFile, 'utf8'), 'export OMP_REVIEW_KIT_RUN_TAG="sess-5"\n');
});

test('Given an environment file in a folder that does not exist, When the session starts, Then the session still answers the hook', async () => {
  const dir = await tempDir();
  const sink = sinks();
  const code = await session({ cwd: dir, env: await sandbox(), exec: fakeOmp, out: (l) => sink.out.push(l), sessionId: 'sess-43', envFile: path.join(dir, 'missing', 'claude-env.sh') });
  assert.equal(code, BRIDGE_EXIT.ok);
  assert.equal(sink.out.length, 1);
  assert.match(sink.out[0], /hookSpecificOutput/);
});

test('Given a reader that prints and then fails, When the session starts, Then its output is not added to the context', async () => {
  const dir = await tempDir();
  const pluginDir = await fakePlugin(dir, { reader: "process.stdout.write('LEAKED-SUMMARY\\n');\nprocess.exitCode = 1;\n" });
  const sink = sinks();
  await session({ cwd: dir, env: await sandbox({ OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir }), exec: fakeOmp, out: (l) => sink.out.push(l), sessionId: 'sess-42' });
  assert.doesNotMatch(sink.out.join('\n'), /LEAKED-SUMMARY/);
});

test('Given a terminal instead of piped input, When the session input is read, Then nothing is read from it', async () => {
  const terminal = new PassThrough();
  terminal.isTTY = true;
  terminal.end('{"session_id":"sess-8"}');
  const started = Date.now();
  assert.deepEqual(await readHookInput(terminal, 500), {});
  assert.ok(Date.now() - started < 500, 'a terminal is not waited for');
});

test('Given input that is not JSON or is JSON null, When it is read, Then the session input is empty', async () => {
  for (const text of ['not json', 'null']) {
    const stdin = new PassThrough();
    stdin.end(text);
    assert.deepEqual(await readHookInput(stdin, 500), {}, text);
  }
});

