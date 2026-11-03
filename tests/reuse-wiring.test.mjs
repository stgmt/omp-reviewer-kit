// The reuse hints as the host wires them: a real Git repository, a real staged snapshot, the scan
// running before the task, and the injected native task as the seam. The hints reach the
// assignment the reviewer reads; the verdict never depends on them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNativeReview } from '../src/native/native-review.mjs';
import { completed } from './support/stage-fixtures.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8' });
}

const PASS_REPORT = '## Review\n\nREVIEW_RESULT=PASS';

const EXISTING = `export function computeChargeTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}
`;

const COPY = `export function sumOrderAmount(rows, vat) {
  let accrued = 0;
  for (const row of rows) {
    accrued += row.cost * row.count;
  }
  const fee = accrued * vat;
  return Math.round((accrued + fee) * 100) / 100;
}
`;

async function stagedRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), 'reuse-stage-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'reuse stage test']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'billing.mjs'), EXISTING);
  git(repo, ['add', 'billing.mjs']);
  git(repo, ['commit', '-q', '-m', 'base']);
  await writeFile(path.join(repo, 'orders.mjs'), COPY);
  git(repo, ['add', 'orders.mjs']);
  return repo;
}

const reviewerWithYield = text => ({
  exitCode: 0,
  aborted: false,
  modelRole: 'task',
  resolvedModel: 'm',
  extractedToolData: { yield: [{ status: 'success', data: text }] },
});
const baseStages = () => [
  completed('review-context-scout', { test_harness: 'present' }),
  completed('review-risk-hunter', { lane: 'correctness' }),
  completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
];

test('Given a staged copy of existing code, When the review runs, Then the assignment names the existing implementation and the verdict is unaffected', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'reuse-stage-parent-'));
  let assignment = null;
  let artifact = null;
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async ({ assignment: text }) => {
        assignment = text;
        const snapshotDir = text.match(/The staged snapshot directory is (.+)/)?.[1]?.trim() ?? null;
        artifact = snapshotDir ? JSON.parse(await readFile(path.join(snapshotDir, '.review', 'reuse.json'), 'utf8')) : null;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: baseStages() };
      },
    });
    assert.equal(result.verdict.pass, true, 'hints never block a commit');
    assert.match(assignment, /Possible existing implementations/);
    assert.match(assignment, /orders\.mjs:1 sumOrderAmount ~ billing\.mjs:1 computeChargeTotal/);
    assert.equal(artifact?.schema, 'reuse@1');
    assert.equal(artifact?.candidates.length, 1);
    assert.equal(artifact?.scan.filesScanned >= 2, true);
  } finally {
    await rm(repo, REMOVE);
    await rm(parent, REMOVE);
  }
});

test('Given the reuse policy is off, When the review runs, Then the assignment says the stage did not run', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'reuse-stage-parent-'));
  let assignment = null;
  try {
    await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_REUSE: 'off' },
      runTask: async ({ assignment: text }) => {
        assignment = text;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: baseStages() };
      },
    });
    assert.match(assignment, /Reuse hints: not run \(policy-off\)\./);
  } finally {
    await rm(repo, REMOVE);
    await rm(parent, REMOVE);
  }
});
