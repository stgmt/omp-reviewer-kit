// Given/When/Then over one staged review from snapshot to verdict. A real Git repository and a real
// staged snapshot; the native task is the injected seam, so no model runs and no OMP library loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runNativeReview } from '../src/native/native-review.mjs';
import { completed } from './support/stage-fixtures.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8' });
}

async function stagedRepo(featurePath = 'feature.mjs') {
  const repo = await mkdtemp(path.join(tmpdir(), 'native-review-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'native review test']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
  git(repo, ['add', 'base.mjs']);
  git(repo, ['commit', '-q', '-m', 'base']);
  await writeFile(path.join(repo, featurePath), 'export const feature = 2;\n');
  git(repo, ['add', featurePath]);
  return repo;
}

async function snapshotsLeft(parent) {
  return (await readdir(parent)).filter(name => name.startsWith('staged-'));
}

test('Given the native task returns no reviewer, When the review runs, Then it blocks with the missing-result reason and removes the snapshot', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({ reviewer: undefined, stages: [] }),
    });
    assert.equal(result.staged, true);
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /reviewer task result missing/);
    assert.equal(result.text, '');
    assert.deepEqual(result.provenance, { role: null, model: null });
    assert.deepEqual(await snapshotsLeft(parent), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the reviewer completed without a yield, When the review runs, Then it blocks with the missing-yield reason', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({ reviewer: { exitCode: 0, aborted: false, extractedToolData: {} }, stages: [] }),
    });
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /reviewer yield missing/);
    assert.equal(result.text, '');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the native task throws, When the review runs, Then the error reaches the caller and the snapshot is removed', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    await assert.rejects(
      runNativeReview({
        repo,
        kitRoot: repo,
        parentDir: parent,
        env: {},
        runTask: async () => {
          throw new Error('native task failed');
        },
      }),
      /native task failed/,
    );
    assert.deepEqual(await snapshotsLeft(parent), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

const PASS_REPORT = '## Review\n\nREVIEW_RESULT=PASS';
// The native task reports its role and resolved model on every stage; the shared fixture stays minimal.
const stage = (agent, data) => completed(agent, data, { role: 'task', model: 'm' });
const completeStages = [
  stage('review-context-scout', { test_harness: 'present' }),
  stage('review-risk-hunter', { lane: 'correctness' }),
  stage('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
];
const reviewerWithYield = data => ({
  exitCode: 0,
  aborted: false,
  modelRole: 'task',
  resolvedModel: 'm',
  extractedToolData: { yield: [{ status: 'success', data }] },
});

test('Given the reviewer passes with every stage completed, When the review runs, Then the verdict passes with the reviewer provenance, the mapped stages, the yielded text, and the snapshot is removed', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({ reviewer: reviewerWithYield(PASS_REPORT), stages: completeStages }),
    });
    assert.equal(result.staged, true);
    assert.equal(result.verdict.pass, true);
    assert.deepEqual(result.verdict.reasons, []);
    assert.deepEqual(result.provenance, { role: 'task', model: 'm' });
    assert.deepEqual(result.fallback, { applied: false, requested: null, chainLength: null, error: null });
    const timing = { durationMs: null, tokens: null, requests: null, contextTokens: null };
    assert.deepEqual(result.stages, [
      { agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm', ...timing, counts: {} },
      { agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm', ...timing, counts: {} },
      { agent: 'review-finding-verifier', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm', ...timing, counts: { confirmed_coverage_gaps: 0, confirmed_findings: 0 } },
    ]);
    assert.equal(result.text, PASS_REPORT);
    assert.deepEqual(result.fileClasses, [{ path: 'feature.mjs', fileClass: 'executable' }]);
    assert.deepEqual(await snapshotsLeft(parent), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a test-class file with a confirmed blocking gap, When the review runs, Then the file-class manifest keeps the verdict PASS', async () => {
  const repo = await stagedRepo('feature.test.mjs');
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    const stages = [
      stage('review-context-scout', { test_harness: 'present' }),
      stage('review-risk-hunter', { lane: 'correctness' }),
      stage('review-finding-verifier', {
        confirmed_findings: [],
        confirmed_coverage_gaps: [{ coverage_id: 'coverage-1', file_path: 'feature.test.mjs', severity: 'blocking', impact: 'a helper returns the wrong fixture' }],
      }),
    ];
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({ reviewer: reviewerWithYield(PASS_REPORT), stages }),
    });
    assert.deepEqual(result.fileClasses, [{ path: 'feature.test.mjs', fileClass: 'test' }]);
    assert.equal(result.verdict.pass, true);
    assert.deepEqual(result.verdict.reasons, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the yield carries more than the report field, When the review runs, Then the text is empty and the review blocks for having no Markdown report', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({ reviewer: reviewerWithYield({ report: 'x', extra: 1 }), stages: completeStages }),
    });
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /reviewer yield carries no Markdown report/);
    assert.equal(result.text, '');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the native task takes measurable time, When the review runs, Then the phase timings and the wall clock are reported', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    let clock = 0;
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      now: () => clock,
      runTask: async () => {
        clock = 5_000;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: completeStages };
      },
    });
    assert.equal(result.runSummary.timings.snapshotMs, 0);
    assert.equal(result.runSummary.timings.nativeTaskMs, 5_000);
    assert.equal(result.runSummary.timings.verdictMs, 0);
    assert.equal(result.runSummary.durationMs, 5_000);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given nothing is staged, When the review runs, Then only the snapshot timing is reported', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'native-review-empty-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'native review test']);
    await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, now: () => 7 });
    assert.equal(result.staged, false);
    assert.deepEqual(Object.keys(result.runSummary.timings), ['snapshotMs']);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

async function stagedRepoWith(files) {
  const repo = await mkdtemp(path.join(tmpdir(), 'native-review-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'native review test']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
  git(repo, ['add', 'base.mjs']);
  git(repo, ['commit', '-q', '-m', 'base']);
  for (const file of files) {
    await writeFile(path.join(repo, file), `export const value = '${file}';\n`);
    git(repo, ['add', file]);
  }
  return repo;
}

test('Given more staged paths than the budget allows, When the review runs, Then it refuses before the reviewer and removes the snapshot', async () => {
  const repo = await stagedRepoWith(['a.mjs', 'b.mjs']);
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  let ran = 0;
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_MAX_DIFF: '1' },
      runTask: async () => {
        ran += 1;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: completeStages };
      },
    });
    assert.equal(ran, 0);
    assert.equal(result.staged, true);
    assert.equal(result.refused.reason, 'too-many-paths');
    assert.equal(result.refused.paths, 2);
    assert.equal(result.refused.maxPaths, 1);
    assert.ok(result.refused.bytes > 0);
    assert.deepEqual(await snapshotsLeft(parent), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a malformed budget, When the review runs, Then it refuses with the offending value instead of defaulting', async () => {
  const repo = await stagedRepoWith(['a.mjs']);
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  let ran = 0;
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_MAX_DIFF: '40/x' },
      runTask: async () => {
        ran += 1;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: completeStages };
      },
    });
    assert.equal(ran, 0);
    assert.equal(result.refused.reason, 'invalid-budget');
    assert.equal(result.refused.error, 'diff budget invalid: 40/x');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a diff within the budget, When the review runs, Then the budget is reported and the reviewer runs', async () => {
  const repo = await stagedRepoWith(['a.mjs']);
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_MAX_DIFF: '5/2' },
      runTask: async () => ({ reviewer: reviewerWithYield(PASS_REPORT), stages: completeStages }),
    });
    assert.equal(result.refused, undefined);
    assert.deepEqual(result.budget, { refused: false, reason: null, paths: 1, bytes: result.budget.bytes, maxPaths: 5, maxBytes: 2_000_000 });
    assert.equal(result.verdict.pass, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
