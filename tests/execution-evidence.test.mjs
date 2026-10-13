import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEvidence } from '../src/domain/execution-evidence.mjs';

describe('Feature: Execution Evidence Formatting and Interpretation', () => {
  const baseOptions = {
    command: 'npm test',
    timeoutMs: 60000,
  };

  it('formats staged pass + reverted fail (red proof achieved)', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 0, durationMs: 42100, stdout: '10 passed\n', stderr: '' },
      reverted: { ok: true, exitCode: 1, durationMs: 40300, stdout: 'FAIL tests/calc.test.mjs\n', stderr: '' },
    });

    const text = evidence.toPromptText();
    assert.match(text, /Execution evidence \(opt-in, produced by the dispatcher before this review\):/);
    assert.match(text, /- Command: `npm test` \(timeout 60s\)/);
    assert.match(text, /- Staged snapshot: exit 0 in 42\.1s/);
    assert.match(text, /- Reverted snapshot \(non-test staged changes reverted to HEAD\): exit 1 in 40\.3s/);
    assert.match(text, /staged pass \+ reverted fail => the staged tests prove the staged change \(red proof achieved\)/);
  });

  it('formats staged pass + reverted pass (tests do not discriminate)', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 0, durationMs: 12000, stdout: 'all passed\n', stderr: '' },
      reverted: { ok: true, exitCode: 0, durationMs: 11500, stdout: 'all passed\n', stderr: '' },
    });

    const text = evidence.toPromptText();
    assert.match(text, /- Staged snapshot: exit 0 in 12\.0s/);
    assert.match(text, /- Reverted snapshot .* exit 0 in 11\.5s/);
    assert.match(text, /staged pass \+ reverted pass => the staged tests do not discriminate the staged change/);
  });

  it('formats staged fail + reverted pass (staged change breaks gates)', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 1, durationMs: 5000, stdout: '', stderr: 'SyntaxError: bad token\n' },
      reverted: { ok: true, exitCode: 0, durationMs: 4800, stdout: 'ok\n', stderr: '' },
    });

    const text = evidence.toPromptText();
    assert.match(text, /- Staged snapshot: exit 1 in 5\.0s/);
    assert.match(text, /- Reverted snapshot .* exit 0 in 4\.8s/);
    assert.match(text, /staged fail \+ reverted pass => the staged change breaks the project's own gates; P1 correctness candidate/);
  });

  it('formats staged fail + reverted fail (pre-existing failure)', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 1, durationMs: 3000, stdout: '', stderr: 'Database unreachable\n' },
      reverted: { ok: true, exitCode: 1, durationMs: 3100, stdout: '', stderr: 'Database unreachable\n' },
    });

    const text = evidence.toPromptText();
    assert.match(text, /staged fail \+ reverted fail => pre-existing failure; compare tails/);
  });

  it('formats unavailable staged execution error', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: false, error: 'Command failed: ENOENT' },
      reverted: null,
    });

    const text = evidence.toPromptText();
    assert.match(text, /- Staged snapshot: unavailable \(Command failed: ENOENT\)/);
    assert.match(text, /- Reverted snapshot: skipped \(staged execution unavailable\)/);
    assert.match(text, /unavailable => execution evidence is absent; absence proves nothing/);
  });

  it('formats skipped reverted execution with specific reason', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 0, durationMs: 1000, stdout: 'ok', stderr: '' },
      reverted: null,
      revertedSkipReason: 'no non-test changes staged',
    });

    const text = evidence.toPromptText();
    assert.match(text, /- Reverted snapshot: skipped \(no non-test changes staged\)/);
  });

  it('formats warnings when dependency symlinks fail', () => {
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 0, durationMs: 1000, stdout: 'ok', stderr: '' },
      reverted: null,
      warnings: ['Failed to link node_modules: EPERM operation not permitted'],
    });

    const text = evidence.toPromptText();
    assert.match(text, /- Warning: Failed to link node_modules: EPERM operation not permitted/);
  });

  it('limits tail output to the last 20 lines', () => {
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
    const evidence = new ExecutionEvidence({
      ...baseOptions,
      staged: { ok: true, exitCode: 0, durationMs: 2000, stdout: lines, stderr: '' },
      reverted: null,
    });

    const text = evidence.toPromptText();
    assert.doesNotMatch(text, /line 1\b/);
    assert.match(text, /line 26/);
    assert.match(text, /line 45/);
  });
});

import { ReviewWorkflowService } from '../src/application/review-workflow-service.mjs';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';
import { ReviewWorkflowService as BundledWorkflow, DiffIdentity as BundledDiff } from '../scripts/run-review.mjs';

for (const [label, Workflow, Diff] of [['source', ReviewWorkflowService, DiffIdentity], ['bundle', BundledWorkflow, BundledDiff]]) {
  it(`${label}: Given source and test changes, When red proof is enabled, Then execute staged and reverted snapshots`, async () => {
    const paths = ['src/a.mjs', 'tests/a.test.mjs'];
    const diff = Diff.fromString(paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`).join(''));
    const snapshots = [];
    const executions = [];
    let evidence;
    const service = new Workflow({
      gitPort: {
        getRepoRoot: async () => '/mock/root', getStagedDiff: async () => diff,
        getSnapshot: async () => ({ files: paths.map((p) => ({ path: p, content: Buffer.from('b') })) }),
        getHeadFile: async () => Buffer.from('a'),
      },
      snapshotStorePort: { create: async (snapshot) => { snapshots.push(snapshot); return '/mock/snapshot'; }, remove: async () => {} },
      reportStorePort: { saveReport: async () => '/mock/report.md' },
      reviewerPort: { executeReview: async ({ prompt }) => { evidence = prompt.toString(); return { status: 0, stdout: 'REVIEW_RESULT=PASS', stderr: '' }; } },
      executionPort: { run: async (input) => { executions.push(input); return { ok: true, exitCode: executions.length === 1 ? 0 : 1, durationMs: 1, stdout: '', stderr: '' }; } },
      execution: { enabled: true, command: 'fixture', redProof: true, linkDirs: [] },
      logger: { log() {}, error() {} },
    });
    await service.execute({ cwd: '/mock/root' });
    assert.equal(executions.length, 2);
    assert.equal(snapshots[1].files.find((f) => f.path === 'src/a.mjs').content.toString(), 'a');
    assert.equal(snapshots[1].files.find((f) => f.path === 'tests/a.test.mjs').content.toString(), 'b');
    assert.match(evidence, /Staged snapshot: exit 0/);
    assert.match(evidence, /Reverted snapshot .*exit 1/);
    assert.doesNotMatch(evidence, /- (?:Staged|Reverted) snapshot: unavailable/);
  });
}

describe('Feature: ReviewWorkflowService Execution Fail-Open and Ordering', () => {
  it('fails open when executionPort throws an unexpected error', async () => {
    const diffText = 'diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n-1\n+2\n';
    const diff = DiffIdentity.fromString(diffText);

    let capturedPrompt = null;
    const fakeGit = {
      getRepoRoot: async () => '/mock/root',
      getStagedDiff: async () => diff,
      getSnapshot: async () => ({ files: [{ path: 'src/app.mjs', content: Buffer.from('2') }] }),
      getHeadFile: async () => Buffer.from('1'),
    };

    const fakeSnapshotStore = {
      create: async () => '/mock/snapshot',
      remove: async () => {},
    };

    const fakeReviewer = {
      executeReview: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
    };

    const throwingExecutionPort = {
      run: async () => {
        throw new Error('EACCES: permission denied');
      },
    };

    const fakeReportStore = {
      saveReport: async () => '/mock/report.md',
    };

    const service = new ReviewWorkflowService({
      gitPort: fakeGit,
      reviewerPort: fakeReviewer,
      reportStorePort: fakeReportStore,
      snapshotStorePort: fakeSnapshotStore,
      executionPort: throwingExecutionPort,
      execution: {
        enabled: true,
        command: 'npm test',
      },
    });

    let result;
    await assert.doesNotReject(async () => { result = await service.execute({ cwd: '/mock/root' }); }, 'execution evidence failure must not abort the review');
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, 'PASS');
    assert.ok(capturedPrompt);
    assert.match(capturedPrompt.toString(), /Staged snapshot: unavailable \(EACCES: permission denied\)/);
  });

  it('invokes executionPort before reviewerPort', async () => {
    const diff = DiffIdentity.fromString('diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@ -1 +1 @@\n-1\n+2\n');
    const order = [];

    const service = new ReviewWorkflowService({
      gitPort: {
        getRepoRoot: async () => '/mock/root',
        getStagedDiff: async () => diff,
        getSnapshot: async () => ({ files: [{ path: 'test.mjs', content: Buffer.from('2') }] }),
        getHeadFile: async () => null,
      },
      reviewerPort: {
        executeReview: async () => {
          order.push('reviewer');
          return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
        },
      },
      reportStorePort: { saveReport: async () => '/mock/report.md' },
      snapshotStorePort: { create: async () => '/mock/snapshot', remove: async () => {} },
      executionPort: {
        run: async () => {
          order.push('execution');
          return { ok: true, exitCode: 0, durationMs: 100, stdout: 'ok', stderr: '' };
        },
      },
      execution: {
        enabled: true,
        command: 'npm test',
      },
    });

    await service.execute({ cwd: '/mock/root' });
    assert.deepEqual(order, ['execution', 'reviewer']);
  });
});
