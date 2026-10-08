import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import { GitPort } from '../src/application/ports.mjs';
import { ReviewWorkflowService } from '../src/application/review-workflow-service.mjs';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';
import { FileSystemTelemetryAdapter, runTagFromEnv } from '../src/infra/filesystem-telemetry-adapter.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-08T12:00:00.000Z');
const SILENT_LOGGER = { log: () => {}, error: () => {} };
const MIRROR = '.omp/review-kit/run-review.mjs';
const INSTALLED_COPY = 'runner from the installed plugin\n';
const runIdOf = (suffix) => `2026-10-08T10-00-00-000Z-${suffix}`;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
// The pid of a process that has already exited: the liveness check reports it dead.
const DEAD_PID = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' }).pid;

// The modular sources and the self-contained runner copy that the hook executes.
// Every behaviour is checked against both, so a mutant in either copy is caught.
const MODULE_SETS = [
  {
    label: 'modular',
    load: async () => {
      const [diff, telemetry, reviewer, git, index] = await Promise.all([
        import('../src/domain/diff-identity.mjs'),
        import('../src/infra/filesystem-telemetry-adapter.mjs'),
        import('../src/infra/omp-cli-reviewer-adapter.mjs'),
        import('../src/infra/subprocess-git-adapter.mjs'),
        import('../src/index.mjs'),
      ]);
      return {
        DiffIdentity: diff.DiffIdentity,
        FileSystemTelemetryAdapter: telemetry.FileSystemTelemetryAdapter,
        OmpCliReviewerAdapter: reviewer.OmpCliReviewerAdapter,
        childLogReadStage: reviewer.childLogReadStage,
        SubprocessGitAdapter: git.SubprocessGitAdapter,
        runReview: index.runReview,
      };
    },
  },
  { label: 'bundled', load: () => import('../scripts/run-review.mjs') },
];

async function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Each test gets a temp root, so run records never reach the real home directory.
async function isolated(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-run-records-'));
  const runsDir = path.join(root, 'runs');
  try {
    return await withEnv({
      OMP_REVIEW_KIT_RUNS_DIR: runsDir,
      OMP_REVIEW_KIT_TELEMETRY_DIR: path.join(root, 'reports'),
      OMP_REVIEW_KIT_TELEMETRY: undefined,
      OMP_REVIEW_KIT_RUN_TAG: undefined,
    }, () => fn({ root, runsDir }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const readRecord = async (runsDir, runId) => JSON.parse(await readFile(path.join(runsDir, `${runId}.json`), 'utf8'));

async function onlyRecord(runsDir) {
  const names = (await readdir(runsDir)).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1, 'exactly one run record exists');
  return JSON.parse(await readFile(path.join(runsDir, names[0]), 'utf8'));
}

function recordingTelemetry() {
  const updates = [];
  return {
    updates,
    record: async () => {},
    updateLastRun: async (state, opts) => {
      updates.push({ state, opts });
    },
  };
}

// Pins Date.now while fn runs, so a retention cutoff can sit on an exact instant.
async function withClock(atMs, fn) {
  const realNow = Date.now;
  Date.now = () => atMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// A full pipeline run over a staged diff that passes, with every external capability stubbed.
function passedReview(m, repoRoot) {
  return m.runReview({
    cwd: repoRoot,
    git: (args) => {
      if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
      if (args[0] === 'diff') return Buffer.from('staged run record diff');
      return Buffer.alloc(0);
    },
    omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    logger: SILENT_LOGGER,
    now: NOW,
  });
}

// Events the pipeline wrote for the run that isolated() set up.
async function readRunEvents(root) {
  const text = await readFile(path.join(root, 'reports', 'runs.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

// Test git never reads the developer's configuration: a global diff.mnemonicPrefix or
// color.diff changes diff bytes, a hooks path would run hooks, and GIT_* variables exported
// by a running git hook (GIT_INDEX_FILE, GIT_DIR) would point git at another repository.
const GIT_HOME = mkdtempSync(path.join(tmpdir(), 'omp-run-records-git-home-'));
after(() => rmSync(GIT_HOME, { recursive: true, force: true }));

// Read on each call, so variables a test sets for itself reach its git calls.
function gitEnv() {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
  return {
    ...Object.fromEntries(inherited),
    HOME: GIT_HOME,
    USERPROFILE: GIT_HOME,
    XDG_CONFIG_HOME: GIT_HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function gitBuffer(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: gitEnv(),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const gitIn = (cwd, args) => gitBuffer(cwd, args).toString('utf8').trim();

async function writeRepoFile(repo, relativePath, text) {
  const file = path.join(repo, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

// A repository shaped like the kit itself: a source runner and its self-hosted mirror.
async function kitShapedRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-run-records-git-'));
  gitIn(repo, ['init', '-q']);
  await writeRepoFile(repo, 'src/app.mjs', 'export const a = 1;\n');
  await writeRepoFile(repo, 'scripts/run-review.mjs', 'runner v1\n');
  await writeRepoFile(repo, MIRROR, 'runner v1\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'base']);
  return repo;
}

const configured = (display) => ({ message: 'Configured subagent runtime model fallback chain', role: `subagent:ReviewerKit.${display}` });
const launched = (agent) => ({ message: 'subagent launch timing', agent });

async function writeChildLog(logDir, pid, entries) {
  const file = path.join(logDir, `omp.2026-10-08.${pid}.log`);
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

for (const { label, load } of MODULE_SETS) {
  describe(`Feature: review run records (${label})`, () => {
    let m;
    before(async () => {
      m = await load();
    });

    it('Given two runs of one repository, When each records its state, Then each run owns a record and neither overwrites the other', () => isolated(async ({ root, runsDir }) => {
      const adapter = new m.FileSystemTelemetryAdapter();
      const first = adapter.forRun({ repoRoot: root, runId: runIdOf('aaaaaaaa') });
      const second = adapter.forRun({ repoRoot: root, runId: runIdOf('bbbbbbbb') });

      await first.updateLastRun({ state: 'reviewing', stage: 'scout' }, { force: true });
      await second.updateLastRun({ state: 'reviewing', stage: 'risk' }, { force: true });

      assert.equal((await readRecord(runsDir, runIdOf('aaaaaaaa'))).stage, 'scout');
      assert.equal((await readRecord(runsDir, runIdOf('bbbbbbbb'))).stage, 'risk');
      assert.equal((await readdir(runsDir)).length, 2);
    }));

    it('Given a recorded stage, When a later update carries no stage, Then the record keeps the stage, the progress time, and the new pid', () => isolated(async ({ root, runsDir }) => {
      const telemetry = new m.FileSystemTelemetryAdapter().forRun({ repoRoot: root, runId: runIdOf('cccccccc') });

      await telemetry.updateLastRun({
        state: 'reviewing', stage: 'risk', stagesCompleted: 1, progressAt: '2026-10-08T10:01:00.000Z',
      }, { force: true });
      await telemetry.updateLastRun({ state: 'reviewing', pid: 4321, elapsedMs: 5000 }, { force: true });

      const record = await readRecord(runsDir, runIdOf('cccccccc'));
      assert.equal(record.stage, 'risk', 'a later update must not erase the stage');
      assert.equal(record.stagesCompleted, 1);
      assert.equal(record.progressAt, '2026-10-08T10:01:00.000Z');
      assert.equal(record.pid, 4321);
    }));

    it('Given a plain update inside the throttle window, When a forced update follows, Then the forced write carries the merged state', () => isolated(async ({ root, runsDir }) => {
      const telemetry = new m.FileSystemTelemetryAdapter().forRun({ repoRoot: root, runId: runIdOf('dddddddd') });

      await telemetry.updateLastRun({ state: 'reviewing' });
      await telemetry.updateLastRun({ stage: 'scout' });
      assert.equal((await readRecord(runsDir, runIdOf('dddddddd'))).stage, undefined, 'a plain update inside the window is not written yet');

      await telemetry.updateLastRun({ stagesCompleted: 0 }, { force: true });
      const record = await readRecord(runsDir, runIdOf('dddddddd'));
      assert.equal(record.stage, 'scout', 'the merged state reaches the disk with the forced write');
      assert.equal(record.state, 'reviewing');
    }));

    it('Given a session tag in the environment, When a run records state, Then the record carries the tag; an unsafe tag is dropped', () => isolated(async ({ root, runsDir }) => {
      await withEnv({ OMP_REVIEW_KIT_RUN_TAG: '3f1c2a9e-session' }, () => new m.FileSystemTelemetryAdapter()
        .forRun({ repoRoot: root, runId: runIdOf('eeeeeeee') })
        .updateLastRun({ state: 'started' }, { force: true }));
      await withEnv({ OMP_REVIEW_KIT_RUN_TAG: 'x; rm -rf /' }, () => new m.FileSystemTelemetryAdapter()
        .forRun({ repoRoot: root, runId: runIdOf('ffffffff') })
        .updateLastRun({ state: 'started' }, { force: true }));

      assert.equal((await readRecord(runsDir, runIdOf('eeeeeeee'))).tag, '3f1c2a9e-session');
      assert.equal((await readRecord(runsDir, runIdOf('ffffffff'))).tag, null);
    }));

    it('Given finished, abandoned, and live records, When the old ones are swept at a new run start, Then only finished and abandoned old records are pruned', () => isolated(async ({ root, runsDir }) => {
      await mkdir(runsDir, { recursive: true });
      const old = new Date(Date.now() - 8 * DAY_MS);
      const write = async (name, doc, when) => {
        const file = path.join(runsDir, `${name}.json`);
        await writeFile(file, JSON.stringify(doc), 'utf8');
        await utimes(file, when, when);
      };
      await write('old-done', { runId: 'old-done', state: 'passed', runnerPid: process.pid }, old);
      await write('old-dead', { runId: 'old-dead', state: 'reviewing', runnerPid: DEAD_PID }, old);
      await write('old-live', { runId: 'old-live', state: 'reviewing', runnerPid: process.pid }, old);
      await write('fresh-dead', { runId: 'fresh-dead', state: 'reviewing', runnerPid: DEAD_PID }, new Date());

      await new m.FileSystemTelemetryAdapter().forRun({ repoRoot: root, runId: runIdOf('11111111') })
        .updateLastRun({ state: 'started' }, { force: true });

      assert.deepEqual(
        (await readdir(runsDir)).sort(),
        ['fresh-dead.json', 'old-live.json', `${runIdOf('11111111')}.json`].sort(),
      );
    }));

    it('Given a PASS through the review, When the run ends, Then its record reaches passed with the diff identity and the report', () => isolated(async ({ root, runsDir }) => {
      const diff = 'staged run record diff';
      const git = (args) => {
        if (args[0] === 'rev-parse') return Buffer.from(`${root}\n`);
        if (args[0] === 'diff') return Buffer.from(diff);
        return Buffer.alloc(0);
      };

      const result = await m.runReview({
        cwd: root,
        git,
        omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
        logger: SILENT_LOGGER,
        now: NOW,
      });

      assert.equal(result.exitCode, 0);
      const record = await onlyRecord(runsDir);
      assert.equal(record.state, 'passed');
      assert.equal(record.verdict, 'PASS');
      assert.equal(record.diffHash, m.DiffIdentity.fromString(diff).hash);
      assert.deepEqual(record.excludedPaths, []);
      assert.equal(record.runnerPid, process.pid);
      assert.match(record.reportPath, /\.md$/);
    }));

    it('Given a staged kit mirror and a PASS, When the review runs in the repository, Then the record names the excluded mirror and its hash equals the commit diff hash', () => isolated(async ({ runsDir }) => {
      const repo = await kitShapedRepo();
      try {
        await writeRepoFile(repo, 'src/app.mjs', 'export const a = 2;\n');
        await writeRepoFile(repo, 'scripts/run-review.mjs', 'runner v2\n');
        await writeRepoFile(repo, MIRROR, 'runner v2\n');
        gitIn(repo, ['add', '-A']);

        const result = await m.runReview({
          cwd: repo,
          vendoredFiles: async () => new Map([[MIRROR, INSTALLED_COPY]]),
          omp: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
          logger: SILENT_LOGGER,
          now: NOW,
        });

        assert.equal(result.exitCode, 0);
        const record = await onlyRecord(runsDir);
        assert.deepEqual(record.excludedPaths, [MIRROR]);

        gitIn(repo, ['commit', '-q', '-m', 'kit change']);
        const parent = gitIn(repo, ['rev-parse', 'HEAD~1']);
        const sha = gitIn(repo, ['rev-parse', 'HEAD']);
        const commitDiff = gitBuffer(repo, ['diff', parent, sha, '--binary', '--no-ext-diff', '--', '.', `:(exclude,literal)${MIRROR}`]);
        assert.equal(record.diffHash, sha256(commitDiff), 'the run can be matched to the commit by its diff hash');
        assert.equal(record.parentSha, parent, 'the run records the commit it reviewed on top of');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }));

    it('Given a staged runner mirror equal to the staged source and different from the installed copy, When the staged diff is read, Then the mirror is left out', async () => {
      const repo = await kitShapedRepo();
      try {
        await writeRepoFile(repo, 'src/app.mjs', 'export const a = 2;\n');
        await writeRepoFile(repo, 'scripts/run-review.mjs', 'runner v2\n');
        await writeRepoFile(repo, MIRROR, 'runner v2\n');
        gitIn(repo, ['add', '-A']);
        const adapter = new m.SubprocessGitAdapter(undefined, {
          vendoredFiles: async () => new Map([[MIRROR, INSTALLED_COPY]]),
        });

        const identity = await adapter.getStagedDiff(repo);

        assert.deepEqual([...identity.excludedPaths], [MIRROR]);
        assert.equal(identity.bytes.toString('utf8').includes(`a/${MIRROR}`), false, 'the mirror is not reviewed');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('Given a staged runner mirror that matches neither the installed copy nor the staged source, When the staged diff is read, Then the mirror stays in review', async () => {
      const repo = await kitShapedRepo();
      try {
        await writeRepoFile(repo, 'src/app.mjs', 'export const a = 2;\n');
        await writeRepoFile(repo, 'scripts/run-review.mjs', 'runner v2\n');
        await writeRepoFile(repo, MIRROR, 'runner v3\n');
        gitIn(repo, ['add', '-A']);
        const adapter = new m.SubprocessGitAdapter(undefined, {
          vendoredFiles: async () => new Map([[MIRROR, INSTALLED_COPY]]),
        });

        const identity = await adapter.getStagedDiff(repo);

        assert.deepEqual([...identity.excludedPaths], []);
        assert.equal(identity.bytes.toString('utf8').includes(MIRROR), true);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('Given git cannot run, When HEAD is read, Then no parent is reported and nothing is thrown', async () => {
      const git = new m.SubprocessGitAdapter(async () => {
        throw new Error('spawn git ENOENT');
      });
      assert.equal(await git.getHeadSha('unused'), null);
    });

    it('Given mnemonic prefixes and coloured diffs configured in the repository, When the staged diff is read, Then it keeps the standard prefixes and no colour codes', async () => {
      const repo = await kitShapedRepo();
      try {
        gitIn(repo, ['config', 'diff.mnemonicPrefix', 'true']);
        gitIn(repo, ['config', 'color.diff', 'always']);
        await writeRepoFile(repo, 'src/app.mjs', 'export const a = 2;\n');
        gitIn(repo, ['add', '-A']);

        const diff = (await new m.SubprocessGitAdapter().getStagedDiff(repo)).bytes.toString('utf8');

        assert.match(diff, /^diff --git a\/src\/app\.mjs b\/src\/app\.mjs$/m);
        assert.equal(diff.includes('\u001b['), false, 'the hashed diff carries no escape codes');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('Given a repository without commits, When HEAD is read, Then no parent is reported', async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'omp-run-records-unborn-'));
      try {
        gitIn(repo, ['init', '-q']);
        assert.equal(await new m.SubprocessGitAdapter().getHeadSha(repo), null);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('Given a commit, When HEAD is read, Then the full commit id is returned', async () => {
      const repo = await kitShapedRepo();
      try {
        assert.equal(await new m.SubprocessGitAdapter().getHeadSha(repo), gitIn(repo, ['rev-parse', 'HEAD']));
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('Given two risk hunters, When one has finished, Then risk stays open; When both have, Then risk is complete', async () => {
      const pid = 6161;
      const logDir = await mkdtemp(path.join(tmpdir(), 'omp-run-records-logs-'));
      try {
        await writeChildLog(logDir, pid, [
          configured('ContextScout'),
          launched('review-context-scout'),
          configured('HunterS1'),
          configured('HunterS2'),
          launched('review-risk-hunter'),
        ]);
        const midway = await m.childLogReadStage({ logDir, pid });
        assert.equal(midway.stage, 'risk');
        assert.equal(midway.completed, 1, 'scout is complete; the second hunter is still running');
        assert.match(midway.logAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        await writeChildLog(logDir, pid, [
          configured('ContextScout'),
          launched('review-context-scout'),
          configured('HunterS1'),
          configured('HunterS2'),
          launched('review-risk-hunter'),
          launched('review-risk-hunter'),
        ]);
        const done = await m.childLogReadStage({ logDir, pid });
        assert.equal(done.stage, 'risk');
        assert.equal(done.completed, 2, 'scout and risk are complete; the verifier is not dispatched yet');
      } finally {
        await rm(logDir, { recursive: true, force: true });
      }
    });

    it('Given the review reports a stage change, When the adapter records it, Then the update is forced and carries progressAt', async () => {
      const telemetry = recordingTelemetry();
      const adapter = new m.OmpCliReviewerAdapter({
        runner: async (prompt, cwd, timeout, options) => {
          options.onSpawn?.(4242);
          options.onStage?.({ stage: 'risk', completed: 1 });
          return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
        },
      });

      await adapter.executeReview({ prompt: 'review prompt', cwd: tmpdir(), telemetry });

      const stageUpdate = telemetry.updates.find((entry) => entry.state.stage === 'risk');
      assert.ok(stageUpdate, 'the stage change is recorded');
      assert.equal(stageUpdate.opts?.force, true, 'stage updates bypass the throttle');
      assert.match(stageUpdate.state.progressAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('Given the OMP child log shows activity, When the heartbeat fires, Then the running update carries childLogAt', async () => {
      // The review heartbeat is the adapter's 5 s interval. Its tick is captured and
      // fired by the test instead of waiting five seconds; the interval is restored
      // right after the review.
      const realSetInterval = globalThis.setInterval;
      let heartbeatTick = null;
      globalThis.setInterval = (fn, ms, ...rest) => {
        if (ms !== 5_000 || heartbeatTick) return realSetInterval(fn, ms, ...rest);
        heartbeatTick = fn;
        return realSetInterval(() => {}, 60_000);
      };
      const telemetry = recordingTelemetry();
      const logAt = '2026-10-08T10:02:03.000Z';
      const adapter = new m.OmpCliReviewerAdapter({
        runner: async (prompt, cwd, timeout, options) => {
          options.onSpawn?.(4242);
          options.onActivity?.(logAt);
          heartbeatTick();
          return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
        },
      });

      try {
        await adapter.executeReview({ prompt: 'review prompt', cwd: tmpdir(), telemetry });
      } finally {
        globalThis.setInterval = realSetInterval;
      }

      const running = telemetry.updates.find((entry) => entry.state.childLogAt === logAt);
      assert.ok(running, 'the heartbeat carries the child log activity');
      assert.equal(running.state.state, 'reviewing');
    });

    it('Given a relative runs override, When a run records, Then the records land under the home directory and never in the working directory', () => isolated(async ({ root }) => {
      const home = path.join(root, 'home');
      const repo = path.join(root, 'repo');
      await mkdir(repo, { recursive: true });

      await withEnv({ HOME: home, USERPROFILE: home, OMP_REVIEW_KIT_RUNS_DIR: 'relative-runs' }, () => passedReview(m, repo));

      assert.equal((await onlyRecord(path.join(home, 'relative-runs'))).state, 'passed');
      assert.equal((await readdir(repo)).includes('relative-runs'), false, 'no run record is written inside the repository');
    }));

    it('Given a whitespace-only runs override, When a run records, Then the default location under the home directory is used', () => isolated(async ({ root }) => {
      const home = path.join(root, 'home');

      await withEnv({ HOME: home, USERPROFILE: home, OMP_REVIEW_KIT_RUNS_DIR: '   ' }, () => passedReview(m, root));

      assert.equal((await onlyRecord(path.join(home, '.omp', 'review-kit-runs'))).state, 'passed');
    }));

    it('Given a drive-relative runs override, When a run records, Then the records land in the default folder under the home directory', () => isolated(async ({ root }) => {
      const home = path.join(root, 'home');

      await withEnv({ HOME: home, USERPROFILE: home, OMP_REVIEW_KIT_RUNS_DIR: 'Q:runs' }, () => passedReview(m, root));

      assert.equal((await onlyRecord(path.join(home, '.omp', 'review-kit-runs'))).state, 'passed');
    }));

    it('Given a plain staged diff, When the run passes, Then the collected-diff event lists no excluded paths', () => isolated(async ({ root }) => {
      assert.equal((await passedReview(m, root)).exitCode, 0);

      const collected = (await readRunEvents(root)).find((event) => event.type === 'diff_collected');
      assert.ok(collected, 'the diff collection is recorded in runs.jsonl');
      assert.deepEqual(collected.excludedPaths, []);
    }));

    it('Given a run that starts, When it passes, Then its progress time still equals its start time', () => isolated(async ({ root, runsDir }) => {
      await passedReview(m, root);

      const record = await onlyRecord(runsDir);
      assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(record.progressAt, record.startedAt, 'no stage change has moved the progress time');
    }));

    it('Given a 64-character object id from git, When HEAD is read, Then the id is returned as it is', async () => {
      const id = 'ab'.repeat(32);
      assert.equal(await new m.SubprocessGitAdapter(async () => Buffer.from(`${id}\n`)).getHeadSha('unused'), id);
    });

    it('Given empty or malformed git output, When HEAD is read, Then no commit id is reported', async () => {
      for (const output of ['', 'HEAD\n', 'abc123\n', `${'z'.repeat(40)}\n`]) {
        const git = new m.SubprocessGitAdapter(async () => Buffer.from(output));
        assert.equal(await git.getHeadSha('unused'), null, `output ${JSON.stringify(output)}`);
      }
    });

    it('Given only the orchestrator row in the child log, When the log is read, Then no stage is pinned', async () => {
      const pid = 7171;
      const logDir = await mkdtemp(path.join(tmpdir(), 'omp-run-records-logs-'));
      try {
        await writeChildLog(logDir, pid, [configured('Main')]);
        const info = await m.childLogReadStage({ logDir, pid });
        assert.equal(info.stage, 'scouting', 'the orchestrator row names no stage');
        assert.equal(info.completed, 0);
      } finally {
        await rm(logDir, { recursive: true, force: true });
      }
    });

    it('Given a finding verifier dispatched but not launched, When the child log is read, Then the verifier stage is current', async () => {
      const pid = 7272;
      const logDir = await mkdtemp(path.join(tmpdir(), 'omp-run-records-logs-'));
      try {
        await writeChildLog(logDir, pid, [
          configured('ContextScout'),
          launched('review-context-scout'),
          configured('FindingVerifier'),
        ]);
        const info = await m.childLogReadStage({ logDir, pid });
        assert.equal(info.stage, 'verifier');
        assert.equal(info.completed, 1, 'scout is complete; the verifier is still running');
      } finally {
        await rm(logDir, { recursive: true, force: true });
      }
    });

    it('Given a finished record exactly at the retention cutoff, When a run starts, Then it is pruned and a record one second newer is kept', () => isolated(async ({ root, runsDir }) => {
      await mkdir(runsDir, { recursive: true });
      const cutoff = NOW.getTime() - 7 * DAY_MS;
      const write = async (name, when) => {
        const file = path.join(runsDir, `${name}.json`);
        await writeFile(file, JSON.stringify({ runId: name, state: 'passed', runnerPid: process.pid }), 'utf8');
        await utimes(file, new Date(when), new Date(when));
      };
      await write('at-cutoff', cutoff);
      await write('one-second-newer', cutoff + 1_000);

      await withClock(NOW.getTime(), () => new m.FileSystemTelemetryAdapter().forRun({ repoRoot: root, runId: runIdOf('22222222') })
        .updateLastRun({ state: 'started' }, { force: true }));

      assert.deepEqual((await readdir(runsDir)).sort(), ['one-second-newer.json', `${runIdOf('22222222')}.json`].sort());
    }));

    it('Given an old corrupt record beside an old finished one, When a run starts, Then the corrupt record is kept and the finished one is pruned', () => isolated(async ({ root, runsDir }) => {
      await mkdir(runsDir, { recursive: true });
      const old = new Date(Date.now() - 8 * DAY_MS);
      // The corrupt name sorts first: an unguarded read would end the sweep before the finished record.
      await writeFile(path.join(runsDir, 'a-corrupt.json'), '{not json', 'utf8');
      await writeFile(path.join(runsDir, 'z-finished.json'), JSON.stringify({ runId: 'z-finished', state: 'passed', runnerPid: process.pid }), 'utf8');
      await utimes(path.join(runsDir, 'a-corrupt.json'), old, old);
      await utimes(path.join(runsDir, 'z-finished.json'), old, old);

      await new m.FileSystemTelemetryAdapter().forRun({ repoRoot: root, runId: runIdOf('33333333') })
        .updateLastRun({ state: 'started' }, { force: true });

      assert.deepEqual((await readdir(runsDir)).sort(), ['a-corrupt.json', `${runIdOf('33333333')}.json`].sort());
    }));
  });
}

test('Given tag values, When read, Then only plain tokens of 1 to 200 characters pass', () => {
  assert.equal(runTagFromEnv({ OMP_REVIEW_KIT_RUN_TAG: '  abc.def:1-2_3  ' }), 'abc.def:1-2_3');
  assert.equal(runTagFromEnv({ OMP_REVIEW_KIT_RUN_TAG: 'a' }), 'a');
  assert.equal(runTagFromEnv({ OMP_REVIEW_KIT_RUN_TAG: 'x'.repeat(200) }), 'x'.repeat(200));
  assert.equal(runTagFromEnv({ OMP_REVIEW_KIT_RUN_TAG: 'a b' }), null);
  assert.equal(runTagFromEnv({ OMP_REVIEW_KIT_RUN_TAG: 'x'.repeat(201) }), null);
  assert.equal(runTagFromEnv({}), null);
});

test('Given more finished records than one sweep examines, When a run starts, Then the sweep examines at most 2000 of them', () => isolated(async ({ root, runsDir }) => {
  await mkdir(runsDir, { recursive: true });
  const body = JSON.stringify({ runId: 'finished', state: 'passed', runnerPid: process.pid });
  await Promise.all(Array.from({ length: 2_001 }, (_, index) => writeFile(path.join(runsDir, `old-${String(index).padStart(4, '0')}.json`), body, 'utf8')));

  // The files were written just now, so a clock eight days ahead makes every one of them old.
  await withClock(Date.now() + 8 * DAY_MS, () => new FileSystemTelemetryAdapter().forRun({ repoRoot: root, runId: runIdOf('44444444') })
    .updateLastRun({ state: 'started' }, { force: true }));

  const names = (await readdir(runsDir)).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 2, 'one finished record survives the sweep, next to the new run record');
}));

test('Given the mutation gate, When a mutant runs its suite, Then the suite keeps its run records inside the temp copy', async () => {
  // Matched across a real line break: the gate's mutant table quotes this line with an
  // escaped \n, so a plain substring match would pass on the table entry itself.
  const gate = await readFile(new URL('../scripts/run-mutation-tests.mjs', import.meta.url), 'utf8');
  assert.match(
    gate,
    /timeout: 15_000,\s+env: \{ \.\.\.process\.env, OMP_REVIEW_KIT_RUNS_DIR: path\.join\(tempDir, 'runs'\) \},/,
    'the mutant spawn env points the runs directory into the temp copy',
  );
});

test('Given an ambient git configuration that changes diff output, When a test repository is diffed, Then the ambient configuration is ignored', async () => {
  const ambientHome = await mkdtemp(path.join(tmpdir(), 'omp-run-records-ambient-'));
  try {
    await writeFile(path.join(ambientHome, '.gitconfig'), '[diff]\n\tmnemonicPrefix = true\n[color]\n\tdiff = always\n', 'utf8');
    await withEnv({ HOME: ambientHome, USERPROFILE: ambientHome, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.noprefix', GIT_CONFIG_VALUE_0: 'true' }, async () => {
      const repo = await kitShapedRepo();
      try {
        await writeRepoFile(repo, 'src/app.mjs', 'export const a = 2;\n');
        gitIn(repo, ['add', '-A']);

        const diff = gitBuffer(repo, ['diff', '--cached']).toString('utf8');

        assert.match(diff, /^diff --git a\/src\/app\.mjs b\/src\/app\.mjs$/m);
        assert.equal(diff.includes('\u001b['), false);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  } finally {
    await rm(ambientHome, { recursive: true, force: true });
  }
});

const PARENT_DIFF_TEXT = 'diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n-1\n+2\n';

// The parent commit is optional telemetry: a git port without the capability, or one whose
// lookup fails, must not stop the review, and the run records no parent.
function reviewWithGitPort(gitPort) {
  const updates = [];
  const service = new ReviewWorkflowService({
    gitPort: {
      getRepoRoot: async () => '/mock/root',
      getStagedDiff: async () => DiffIdentity.fromString(PARENT_DIFF_TEXT),
      getSnapshot: async () => ({ files: [{ path: 'src/app.mjs', content: Buffer.from('2') }] }),
      getHeadFile: async () => Buffer.from('1'),
      ...gitPort,
    },
    reviewerPort: { executeReview: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }) },
    reportStorePort: { saveReport: async () => '/mock/report.md' },
    snapshotStorePort: { create: async () => '/mock/snapshot', remove: async () => {} },
    telemetryPort: {
      forRun: () => ({
        record: async () => {},
        updateLastRun: async (state, opts) => {
          updates.push({ state, opts });
        },
      }),
    },
    execution: { enabled: false },
    logger: SILENT_LOGGER,
  });
  return { service, updates };
}

const startedParent = (updates) => updates.find(({ state }) => state.state === 'started').state.parentSha;

test('Given a git port without a parent capability, When a review runs, Then it passes and records no parent', async () => {
  const { service, updates } = reviewWithGitPort({});

  const result = await service.execute({ cwd: '/mock/root' });

  assert.equal(result.exitCode, 0);
  assert.equal(startedParent(updates), null);
});

test('Given a git port whose parent lookup throws, When a review runs, Then it passes and records no parent', async () => {
  const { service, updates } = reviewWithGitPort({
    getHeadSha: async () => {
      throw new Error('rev-parse failed');
    },
  });

  const result = await service.execute({ cwd: '/mock/root' });

  assert.equal(result.exitCode, 0);
  assert.equal(startedParent(updates), null);
});

test('Given the base git port, When its parent is requested, Then it refuses until an adapter implements the capability', () => {
  assert.throws(() => new GitPort().getHeadSha('/mock/root'), /GitPort\.getHeadSha must be implemented/);
});
