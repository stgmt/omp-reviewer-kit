// Given/When/Then over one staged review from snapshot to verdict. A real Git repository and a real
// staged snapshot; the native task is the injected seam, so no model runs and no OMP library loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runNativeReview } from '../src/native/native-review.mjs';

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
const completed = (agent, data) => ({ agent, exitCode: 0, aborted: false, structuredStatus: 'valid', data, role: 'task', model: 'm' });
const completeStages = [
  completed('review-context-scout', { test_harness: 'present' }),
  completed('review-risk-hunter', { lane: 'correctness' }),
  completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
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
    assert.deepEqual(result.stages, [
      { agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm' },
      { agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm' },
      { agent: 'review-finding-verifier', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm' },
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
      completed('review-context-scout', { test_harness: 'present' }),
      completed('review-risk-hunter', { lane: 'correctness' }),
      completed('review-finding-verifier', {
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
