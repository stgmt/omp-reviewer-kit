import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';
import { ReviewWorkflowService as SourceWorkflow } from '../src/application/review-workflow-service.mjs';
import { FileSystemTelemetryAdapter as SourceTelemetry } from '../src/infra/filesystem-telemetry-adapter.mjs';
import * as runnerCopy from '../scripts/run-review.mjs';

// The runner is a self-contained copy of the same classes; both must count and announce alike.
// Each copy gets its own DiffIdentity: the workflow checks it with instanceof, so a value from the other copy is rejected.
const IMPLEMENTATIONS = [
  { label: 'source', Workflow: SourceWorkflow, Telemetry: SourceTelemetry, Diff: DiffIdentity },
  { label: 'runner copy', Workflow: runnerCopy.ReviewWorkflowService, Telemetry: runnerCopy.FileSystemTelemetryAdapter, Diff: runnerCopy.DiffIdentity },
];

// A pid no process can hold: the liveness check reports it dead. An exited child's pid is not used, because
// Windows reuses pids under load and a reused pid reads as alive.
const DEAD_PID = 2147483647;
const DIFF_TEXT = 'diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n-1\n+2\n';
const RUN_PREFIX = 'reviewer-kit run ';
const OTHER_LINE = 'reviewer-kit: 1 other review(s) running in this repository; they do not block this commit\n';

/** Points OMP_REVIEW_KIT_RUNS_DIR at a fresh directory for `body`, then restores the environment. */
async function withRunsDir(body) {
  const home = await mkdtemp(path.join(tmpdir(), 'announce-'));
  const runsDir = path.join(home, 'runs');
  await mkdir(runsDir, { recursive: true });
  const previous = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  try {
    await body({ home, runsDir });
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
    else process.env.OMP_REVIEW_KIT_RUNS_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeRun(runsDir, runId, fields) {
  await writeFile(path.join(runsDir, `${runId}.json`), `${JSON.stringify({ schema: 'review-run-record@1', runId, ...fields })}\n`, 'utf8');
}

function passingReviewer() {
  return { executeReview: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }) };
}

async function reviewCommit({ Workflow, Telemetry, home, repoRoot, diff, telemetryPort = new Telemetry(), reviewerPort = passingReviewer() }) {
  const snapshotDir = await mkdtemp(path.join(home, 'snapshot-'));
  const lines = { log: [], error: [] };
  const gitPort = {
    getRepoRoot: async () => repoRoot,
    getStagedDiff: async () => diff,
    getSnapshot: async () => ({ files: [{ path: 'src/app.mjs', content: Buffer.from('2') }] }),
    getHeadFile: async () => Buffer.from('1'),
  };
  const service = new Workflow({
    gitPort,
    reviewerPort,
    reportStorePort: { saveReport: async () => path.join(repoRoot, 'report.md') },
    snapshotStorePort: { create: async () => snapshotDir, remove: async () => {} },
    telemetryPort,
    execution: { enabled: false },
    logger: { log: (msg) => lines.log.push(msg), error: (msg) => lines.error.push(msg) },
  });
  const result = await service.execute({ cwd: repoRoot });
  return { result, lines };
}

describe('Feature: review runs of one repository see each other', () => {
  for (const impl of IMPLEMENTATIONS) {
    describe(`(${impl.label})`, () => {
      it('Given live, finished, dead and foreign runs, When a run counts the others, Then only the live runs of its repository are counted', async () => {
        await withRunsDir(async ({ home, runsDir }) => {
          const repo = path.join(home, 'repo');
          const foreign = path.join(home, 'foreign');
          await writeRun(runsDir, 'live-review', { repoRoot: repo, state: 'reviewing', runnerPid: process.pid });
          await writeRun(runsDir, 'live-start', { repoRoot: repo, state: 'started', runnerPid: process.pid });
          await writeRun(runsDir, 'finished', { repoRoot: repo, state: 'passed', runnerPid: process.pid });
          await writeRun(runsDir, 'dead-runner', { repoRoot: repo, state: 'reviewing', runnerPid: DEAD_PID });
          await writeRun(runsDir, 'foreign-repo', { repoRoot: foreign, state: 'reviewing', runnerPid: process.pid });
          await writeRun(runsDir, 'self', { repoRoot: repo, state: 'reviewing', runnerPid: process.pid });
          await writeFile(path.join(runsDir, 'broken.json'), '{ not json', 'utf8');

          const count = await new impl.Telemetry().countOtherLiveRuns({ repoRoot: repo, runId: 'self' });

          assert.equal(count, 2);
        });
      });

      it('Given a custom telemetry sink that does not report recorded, When a commit is reviewed, Then the run is announced', async () => {
        await withRunsDir(async ({ home }) => {
          const sink = { record: async () => {}, updateLastRun: async () => {} };

          const { result, lines } = await reviewCommit({
            ...impl,
            home,
            repoRoot: path.join(home, 'repo'),
            diff: impl.Diff.fromString(DIFF_TEXT),
            telemetryPort: { forRun: () => sink, countOtherLiveRuns: async () => 0 },
          });

          assert.equal(result.exitCode, 0);
          assert.equal(lines.error.filter((line) => line.startsWith(RUN_PREFIX)).length, 1);
        });
      });

      it('Given a telemetry port that cannot open the run, When a commit is reviewed, Then the review runs once, the verdict is PASS, and no run is announced', async () => {
        await withRunsDir(async ({ home }) => {
          let reviews = 0;
          const reviewerPort = {
            executeReview: async () => {
              reviews += 1;
              return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
            },
          };
          const telemetryPort = {
            forRun: () => {
              throw new Error('runs folder unavailable');
            },
            countOtherLiveRuns: async () => 0,
          };

          const { result, lines } = await reviewCommit({
            ...impl,
            home,
            repoRoot: path.join(home, 'repo'),
            diff: impl.Diff.fromString(DIFF_TEXT),
            telemetryPort,
            reviewerPort,
          });

          assert.equal(result.exitCode, 0);
          assert.equal(reviews, 1);
          assert.equal(lines.error.some((line) => line.startsWith(RUN_PREFIX)), false);
        });
      });

      it('Given another live review of the repository, When a commit is reviewed, Then the committer gets the run to follow and the count, and the verdict is PASS', async () => {
        await withRunsDir(async ({ home, runsDir }) => {
          const repo = path.join(home, 'repo');
          await writeRun(runsDir, 'other-review', { repoRoot: repo, state: 'reviewing', runnerPid: process.pid });

          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT) });

          assert.equal(result.exitCode, 0);
          const runLines = lines.error.filter((line) => line.startsWith(RUN_PREFIX));
          assert.equal(runLines.length, 1);
          const runId = runLines[0].slice(RUN_PREFIX.length).split(':')[0];
          assert.equal(runLines[0], `${RUN_PREFIX}${runId}: follow it with review-progress --run ${runId} --follow\n`);
          assert.ok(lines.error.includes(OTHER_LINE));
          const record = JSON.parse(await readFile(path.join(runsDir, `${runId}.json`), 'utf8'));
          assert.equal(record.state, 'passed');
        });
      });

      it('Given no other live review, When a commit is reviewed, Then only the run line is printed', async () => {
        await withRunsDir(async ({ home, runsDir }) => {
          const repo = path.join(home, 'repo');
          await writeRun(runsDir, 'finished', { repoRoot: repo, state: 'passed', runnerPid: process.pid });

          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT) });

          assert.equal(result.exitCode, 0);
          assert.equal(lines.error.filter((line) => line.startsWith(RUN_PREFIX)).length, 1);
          assert.equal(lines.error.some((line) => line.includes('other review')), false);
        });
      });

      it('Given telemetry turned off, When a commit is reviewed, Then no run is announced, because no record exists to follow', async () => {
        await withRunsDir(async ({ home }) => {
          const repo = path.join(home, 'repo');
          const previous = process.env.OMP_REVIEW_KIT_TELEMETRY;
          process.env.OMP_REVIEW_KIT_TELEMETRY = '0';
          try {
            const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT) });

            assert.equal(result.exitCode, 0);
            assert.equal(lines.error.some((line) => line.startsWith(RUN_PREFIX)), false);
          } finally {
            if (previous === undefined) delete process.env.OMP_REVIEW_KIT_TELEMETRY;
            else process.env.OMP_REVIEW_KIT_TELEMETRY = previous;
          }
        });
      });

      it('Given a runs folder that cannot be written, When a commit is reviewed, Then no run is announced, because there is no record to follow', async () => {
        await withRunsDir(async ({ home, runsDir }) => {
          // A regular file where the runs folder should be: no record can be written there.
          await rm(runsDir, { recursive: true, force: true });
          await writeFile(runsDir, 'not a folder\n', 'utf8');
          const repo = path.join(home, 'repo');

          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT) });

          assert.equal(result.exitCode, 0);
          assert.equal(lines.error.some((line) => line.startsWith(RUN_PREFIX)), false);
        });
      });

      it('Given a commit with no staged change, When it is reviewed, Then no run is announced', async () => {
        await withRunsDir(async ({ home }) => {
          const repo = path.join(home, 'repo');

          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString('') });

          assert.equal(result.toJSON().skipped, true);
          assert.equal(lines.error.some((line) => line.startsWith(RUN_PREFIX)), false);
        });
      });

      it('Given telemetry turned off, When other live reviews are counted, Then none is counted', async () => {
        await withRunsDir(async ({ home, runsDir }) => {
          const repo = path.join(home, 'repo');
          await writeRun(runsDir, 'other-review', { repoRoot: repo, state: 'reviewing', runnerPid: process.pid });
          const previous = process.env.OMP_REVIEW_KIT_TELEMETRY;
          process.env.OMP_REVIEW_KIT_TELEMETRY = '0';
          try {
            assert.equal(await new impl.Telemetry().countOtherLiveRuns({ repoRoot: repo, runId: 'self' }), 0);
          } finally {
            if (previous === undefined) delete process.env.OMP_REVIEW_KIT_TELEMETRY;
            else process.env.OMP_REVIEW_KIT_TELEMETRY = previous;
          }
        });
      });

      it('Given a runs folder that does not exist yet, When other live reviews are counted, Then none is counted and nothing is thrown', async () => {
        await withRunsDir(async ({ home }) => {
          process.env.OMP_REVIEW_KIT_RUNS_DIR = path.join(home, 'not-yet');
          assert.equal(await new impl.Telemetry().countOtherLiveRuns({ repoRoot: path.join(home, 'repo'), runId: 'self' }), 0);
        });
      });

      it('Given a live review of this repository spelled in other letter case, When other live reviews are counted, Then it is counted on Windows only', async () => {
        await withRunsDir(async ({ home, runsDir }) => {
          await writeRun(runsDir, 'spelled-other', { repoRoot: path.join(home, 'repo'), state: 'reviewing', runnerPid: process.pid });
          const count = await new impl.Telemetry().countOtherLiveRuns({ repoRoot: path.join(home, 'Repo'), runId: 'self' });
          assert.equal(count, process.platform === 'win32' ? 1 : 0);
        });
      });

      it('Given a telemetry port that cannot count live reviews, When a commit is reviewed, Then the verdict is PASS and only the run line is printed', async () => {
        await withRunsDir(async ({ home }) => {
          const repo = path.join(home, 'repo');
          const telemetry = new impl.Telemetry();
          const telemetryPort = { forRun: (args) => telemetry.forRun(args) };
          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT), telemetryPort });
          assert.equal(result.exitCode, 0);
          assert.equal(lines.error.filter((line) => line.startsWith(RUN_PREFIX)).length, 1);
          assert.equal(lines.error.some((line) => line.includes('other review')), false);
        });
      });

      it('Given a live-review count that throws, When a commit is reviewed, Then the verdict is still PASS', async () => {
        await withRunsDir(async ({ home }) => {
          const repo = path.join(home, 'repo');
          const telemetry = new impl.Telemetry();
          const telemetryPort = {
            forRun: (args) => telemetry.forRun(args),
            countOtherLiveRuns: async () => {
              throw new Error('counter unavailable');
            },
          };
          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT), telemetryPort });
          assert.equal(result.exitCode, 0);
          assert.equal(lines.error.some((line) => line.includes('other review')), false);
        });
      });

      it('Given a live-review count that is not a whole number, When a commit is reviewed, Then no other review is announced', async () => {
        await withRunsDir(async ({ home }) => {
          const repo = path.join(home, 'repo');
          const telemetry = new impl.Telemetry();
          const telemetryPort = { forRun: (args) => telemetry.forRun(args), countOtherLiveRuns: async () => 1.5 };
          const { result, lines } = await reviewCommit({ ...impl, home, repoRoot: repo, diff: impl.Diff.fromString(DIFF_TEXT), telemetryPort });
          assert.equal(result.exitCode, 0);
          assert.equal(lines.error.some((line) => line.includes('other review')), false);
        });
      });
    });
  }
});
