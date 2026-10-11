import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReviewWorkflowService } from '../src/application/review-workflow-service.mjs';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';

const DIFF_TEXT = 'diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n-1\n+2\n';

function makeService({ snapshotStore, reviewer, gitExtra = {} }) {
  const diff = DiffIdentity.fromString(DIFF_TEXT);
  return new ReviewWorkflowService({
    gitPort: {
      getRepoRoot: async () => '/mock/root',
      getStagedDiff: async () => diff,
      getSnapshot: async () => ({ files: [{ path: 'src/app.mjs', content: Buffer.from('2') }] }),
      getHeadFile: async () => Buffer.from('1'),
      ...gitExtra,
    },
    reviewerPort: reviewer ?? {
      executeReview: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    },
    reportStorePort: { saveReport: async () => '/mock/report.md' },
    snapshotStorePort: snapshotStore,
    execution: { enabled: false },
  });
}

// Captures intervals instead of scheduling them so heartbeat ticks are
// fired manually — deterministic ordering, no 15-minute waits.
function captureIntervals() {
  const cbs = [];
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = (cb) => { cbs.push(cb); return { unref() {} }; };
  globalThis.clearInterval = () => {};
  return {
    cbs,
    restore() {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    },
  };
}

const tick = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

test('lease heartbeat: armed for transient AND retained dirs; every tick refreshes the served dir', async () => {
  const { cbs, restore } = captureIntervals();
  try {
    for (const mode of ['transient', 'retained']) {
      const tickedDirs = [];
      let servedDir = null;
      const store = {
        create: async (_snap, { reuseDir }) => {
          servedDir = mode === 'retained' ? reuseDir : '/mock/snap-transient';
          return servedDir;
        },
        remove: async () => {},
        release: async () => {},
        refreshLease: async (dir) => { tickedDirs.push(dir); },
      };
      const before = cbs.length;
      const service = makeService({ snapshotStore: store });
      await service.execute({ cwd: '/mock/root' });

      assert.equal(cbs.length, before + 1, `${mode}: exactly one heartbeat interval must be armed`);
      cbs[cbs.length - 1]();
      await tick();
      cbs[cbs.length - 1]();
      await tick();
      assert.deepEqual(tickedDirs, [servedDir, servedDir], `${mode}: every tick must refresh the served snapshot dir`);
    }
  } finally {
    restore();
  }
});

test('lease heartbeat: clearLeaseTimer drains an in-flight tick before release() runs', async () => {
  const { cbs, restore } = captureIntervals();
  const order = [];
  let deferredResolve;
  // execute() counts the other runs of the repository in the runs folder before the reviewer call. The wait below
  // counts event-loop turns, so this test gives that count an empty folder of its own.
  const runsDir = await mkdtemp(path.join(tmpdir(), 'lifecycle-runs-'));
  const previousRunsDir = process.env.OMP_REVIEW_KIT_RUNS_DIR;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = runsDir;
  try {
    const store = {
      create: async (_snap, { reuseDir }) => reuseDir, // retained -> release path
      remove: async () => {},
      release: async () => { order.push('release'); },
      refreshLease: async () => {
        order.push('tick-start');
        // Stay pending until the test resolves it — the drain must wait.
        await new Promise((resolve) => { deferredResolve = resolve; });
        order.push('tick-end');
      },
    };
    const service = makeService({
      snapshotStore: store,
      reviewer: {
        executeReview: async () => {
          // Fire a tick while the review is still running so clearLeaseTimer
          // in the finally must drain this pending refresh before release().
          cbs[cbs.length - 1]();
          return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
        },
      },
    });
    const resultPromise = service.execute({ cwd: '/mock/root' });
    // Wait until the tick fires inside executeReview — execute() runs many
    // awaits before the reviewer call, so a fixed turn count races. The wait is bounded by time, not by turns.
    const deadline = Date.now() + 10_000;
    while (!order.includes('tick-start') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.deepEqual(order, ['tick-start'], 'tick must be in-flight');
    assert.equal(order.includes('release'), false, 'release must not run while the tick is pending');
    deferredResolve();
    const result = await resultPromise;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(order, ['tick-start', 'tick-end', 'release'], 'release must run only after the drained tick');
  } finally {
    restore();
    if (previousRunsDir === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
    else process.env.OMP_REVIEW_KIT_RUNS_DIR = previousRunsDir;
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('badge-write failure never gates the verdict (audit-reports unwritable)', async () => {
  // Arrange: repoRoot whose audit-reports path is a REGULAR FILE -> mkdir fails.
  // r29 correctness-2: badgeEligible must be TRUE for this to exercise
  // #writeBadge's swallow — set OMP_REVIEW_KIT_BADGE=1 explicitly.
  const root = await mkdtemp(path.join(tmpdir(), 'omp-badge-root-'));
  const prevBadge = process.env.OMP_REVIEW_KIT_BADGE;
  process.env.OMP_REVIEW_KIT_BADGE = '1';
  try {
    await writeFile(path.join(root, 'audit-reports'), 'not a dir');
    const service = makeService({
      snapshotStore: { create: async () => '/mock/snap', remove: async () => {} },
      gitExtra: { getRepoRoot: async () => root },
    });
    const result = await service.execute({ cwd: '/mock/root' });
    assert.equal(result.exitCode, 0, 'unwritable audit-reports must not fail the review');
    assert.equal(result.verdict, 'PASS');
  } finally {
    if (prevBadge === undefined) delete process.env.OMP_REVIEW_KIT_BADGE;
    else process.env.OMP_REVIEW_KIT_BADGE = prevBadge;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
