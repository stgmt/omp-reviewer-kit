// Given/When/Then over the maintainability stage as the host wires it: a real Git repository, a real
// staged snapshot, the analysis running before the task, and the injected native task as the seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runNativeReview } from '../src/native/native-review.mjs';
import { completed } from './support/stage-fixtures.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8' });
}

const PASS_REPORT = '## Review\n\nREVIEW_RESULT=PASS';
const repeated = name => `export function ${name}(sessionId, runRoot, attemptId) {\n  return sessionId + runRoot + attemptId;\n}\n`;

async function stagedRepoWithGroup() {
  const repo = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'maintainability stage test']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
  git(repo, ['add', 'base.mjs']);
  git(repo, ['commit', '-q', '-m', 'base']);
  await writeFile(path.join(repo, 'feature.mjs'), [repeated('one'), repeated('two'), repeated('three'), repeated('four')].join('\n'));
  git(repo, ['add', 'feature.mjs']);
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

test('Given a staged group of repeated parameters, When the review runs, Then the candidate file exists for the stage and a missing stage blocks the commit', async () => {
  const repo = await stagedRepoWithGroup();
  const parent = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-parent-'));
  let seen = null;
  let written = null;
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async ({ assignment }) => {
        seen = assignment;
        const candidatePath = assignment.match(/Maintainability candidates .*: (.+?) — /)?.[1] ?? null;
        written = candidatePath ? JSON.parse(await readFile(candidatePath, 'utf8')) : null;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: baseStages() };
      },
    });
    assert.equal(written?.schema, 'maintainability@1');
    assert.equal(written.groups.length, 1);
    assert.deepEqual(written.groups[0].params, ['attemptId', 'runRoot', 'sessionId']);
    assert.equal(written.groups[0].stagedTouchCount, 4);
    assert.equal(result.maintainability.status, 'analyzed');
    assert.equal(result.maintainability.groups, 1);
    assert.equal(result.maintainability.policy, 'block');
    assert.match(seen, /^Maintainability candidates \(deterministic, written before this task\): .*maintainability\.json — status analyzed, 1 group\(s\), coverage full, policy block\.$/m);
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /no completed stage evidence for review-maintainability/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a staged change whose repeated values arrive as object patterns and object-literal arguments, When the review runs, Then the group is counted from them', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-repo-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-parent-'));
  const shape = name => `export function ${name}({ userId, tenantId, requestId, traceId }, value) {\n  return append('${name}', { userId, tenantId, requestId, traceId }, value);\n}\n`;
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'maintainability stage test']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
    await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(path.join(repo, 'ledger.mjs'), ['charge', 'refund', 'settle', 'notify', 'audit'].map(shape).join('\n'));
    git(repo, ['add', 'ledger.mjs']);
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async ({ assignment }) => {
        const candidatePath = assignment.match(/Maintainability candidates .*: (.+?) — /)?.[1] ?? null;
        const written = candidatePath ? JSON.parse(await readFile(candidatePath, 'utf8')) : null;
        assert.ok(written, 'the candidate file path is in the assignment');
        assert.equal(written.status, 'analyzed');
        const group = written.groups.find(entry => entry.params.join(',') === 'requestId,tenantId,traceId,userId');
        assert.ok(group, JSON.stringify(written.groups.map(entry => entry.params)));
        assert.equal(group.support, 10, 'five definitions and five object-literal call sites');
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: baseStages() };
      },
    });
    assert.equal(result.maintainability.status, 'analyzed');
    assert.equal(result.maintainability.planned, true);
    assert.match(result.verdict.reasons.join(' '), /no completed stage evidence for review-maintainability/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the stage answers with a candidate that has no stated cost, When the review runs, Then the verdict passes', async () => {
  const repo = await stagedRepoWithGroup();
  const parent = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({
        reviewer: reviewerWithYield(PASS_REPORT),
        stages: [...baseStages(), completed('review-maintainability', {
          candidates: [{
            candidate_id: 'maintainability-1',
            decision: 'confirmed',
            stated_cost: '',
            priority: 'P2',
            forwarding_only: false,
          }],
        })],
      }),
    });
    assert.deepEqual(result.verdict.reasons, []);
    assert.equal(result.verdict.pass, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a change with no repeated group, When the review runs, Then the assignment says the review was not run and no stage is required', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-repo-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-parent-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'maintainability stage test']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
    await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(path.join(repo, 'one.mjs'), repeated('only'));
    git(repo, ['add', 'one.mjs']);
    let seen = null;
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async ({ assignment }) => {
        seen = assignment;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: baseStages() };
      },
    });
    assert.match(seen, /^Maintainability candidates .*: .*maintainability\.json — status no-candidates, 0 group\(s\), coverage full, policy block\.$/m);
    assert.equal(result.maintainability.status, 'no-candidates');
    assert.equal(result.maintainability.planned, false);
    assert.deepEqual(result.verdict.reasons, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the off policy, When the review runs, Then the analysis is not run at all and the verdict is untouched', async () => {
  const repo = await stagedRepoWithGroup();
  const parent = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-parent-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_MAINTAINABILITY: 'off' },
      runTask: async () => ({ reviewer: reviewerWithYield(PASS_REPORT), stages: baseStages() }),
    });
    assert.equal(result.maintainability.policy, 'off');
    assert.equal(result.maintainability.status, 'not-run');
    assert.equal(result.maintainability.reason, 'policy-off');
    assert.deepEqual(result.verdict.reasons, []);
    assert.equal(result.verdict.pass, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a change with no executable file, When the review runs, Then the assignment records the skip reason and no stage is required', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-repo-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'maintainability-stage-parent-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'maintainability stage test']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
    await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(path.join(repo, 'notes.md'), '# notes\n');
    git(repo, ['add', 'notes.md']);
    let seen = null;
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async ({ assignment }) => {
        seen = assignment;
        return {
          reviewer: reviewerWithYield(PASS_REPORT),
          stages: [
            completed('review-context-scout', { test_harness: 'present' }),
            completed('review-risk-hunter', { lane: 'content-risk' }),
          ],
        };
      },
    });
    assert.match(seen, /^Maintainability review: not run \(no-executable-change\); the maintainability stage is not planned for this diff\.$/m);
    assert.equal(result.maintainability.status, 'not-run');
    assert.equal(result.maintainability.reason, 'no-executable-change');
    assert.deepEqual(result.verdict.reasons, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
