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
      { agent: 'review-context-scout', lane: null, exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm', ...timing, counts: {} },
      { agent: 'review-risk-hunter', lane: null, exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm', ...timing, counts: {} },
      { agent: 'review-finding-verifier', lane: null, exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'm', ...timing, counts: { confirmed_coverage_gaps: 0, confirmed_findings: 0 } },
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

test('Given a synthesis BLOCK whose finding no stage confirmed and a re-verification that rejects it, When the review runs, Then one more verifier stage runs and the review passes with the note', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const calls = [];
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a conflict no stage found\n\nREVIEW_RESULT=BLOCK';
  const stageRunner = {
    async run(agent, name, task) {
      calls.push({ name, task });
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') return { evidence: completed('review-finding-verifier', { lane: 'correctness', decisions: [{ candidate_id: 'report-1', disposition: 'rejected', triage: 'stale_record', reason: 'the snapshot shows no conflict', evidence: 'feature.mjs:1' }], confirmed_findings: [], confirmed_coverage_gaps: [], rejected_coverage_gaps: [] }) };
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    const recheck = calls.find(call => call.name === 'FindingRecheck');
    assert.ok(recheck, 'the report finding must be settled by a verifier pass');
    assert.match(recheck.task, /1\. R1 \(blocking\): a conflict no stage found/);
    assert.equal(result.verdict.pass, true);
    assert.equal(result.verdict.verdict, 'PASS');
    assert.deepEqual(result.verdict.reasons, []);
    assert.deepEqual(result.verdict.notes, ['re-verification rejected 1 finding(s) the report raised; the stages confirmed none']);
    assert.equal(result.text, blockReport, 'the report text is preserved verbatim');
    const verifierRows = result.stages.filter(stage => stage.agent === 'review-finding-verifier');
    assert.equal(verifierRows.length, 2);
    assert.deepEqual(await snapshotsLeft(parent), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a re-verification that rejects the reported finding and confirms only an advisory gap, When the review runs, Then the evidence passes', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a conflict no stage found\n\nREVIEW_RESULT=BLOCK';
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') {
        return {
          evidence: completed('review-finding-verifier', {
            lane: 'correctness',
            decisions: [{ candidate_id: 'report-1', disposition: 'rejected', triage: 'stale_record', reason: 'the snapshot shows no conflict', evidence: 'feature.mjs:1' }],
            confirmed_findings: [],
            confirmed_coverage_gaps: [{ coverage_id: 'c1', file_path: 'feature.mjs', severity: 'advisory', impact: 'a cost, not a defect' }],
          }),
        };
      }
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, true, 'an advisory gap must not turn a rejected finding into a block');
    assert.deepEqual(result.verdict.reasons, []);
    assert.deepEqual(result.verdict.notes, ['re-verification rejected 1 finding(s) the report raised; the stages confirmed none']);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a re-verification that records the confirmed claim only as a disposition, When the review runs, Then the block stands', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a real conflict\n\nREVIEW_RESULT=BLOCK';
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') {
        return {
          evidence: completed('review-finding-verifier', {
            lane: 'correctness',
            decisions: [{ candidate_id: 'report-1', disposition: 'confirmed', triage: 'lie', reason: 'the snapshot shows it', evidence: 'feature.mjs:1' }],
            confirmed_findings: [],
            confirmed_coverage_gaps: [],
          }),
        };
      }
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, false, 'a confirmed disposition must keep the block');
    assert.match(result.verdict.reasons.join(' '), /re-verification confirmed 1 finding\(s\)/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a re-verification that answers none of the claims, When the review runs, Then silence does not become a rejection', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a conflict\n\nREVIEW_RESULT=BLOCK';
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') return { evidence: completed('review-finding-verifier', { lane: 'correctness', decisions: [], confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /re-verification left the finding\(s\) the report raised unproven/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a re-verification that could not prove the claim, When the review runs, Then the block stands', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a conflict\n\nREVIEW_RESULT=BLOCK';
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') {
        return {
          evidence: completed('review-finding-verifier', {
            lane: 'correctness',
            decisions: [{ candidate_id: 'report-1', disposition: 'not_proven', triage: 'not_applicable', reason: 'the budget did not reach the deciding caller', evidence: '' }],
            confirmed_findings: [],
            confirmed_coverage_gaps: [],
          }),
        };
      }
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /unproven/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given the whole-run seam and a BLOCK report whose finding no stage confirmed, When the review runs, Then the seam cannot fake a recheck and the block stands', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a conflict no stage found\n\nREVIEW_RESULT=BLOCK';
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async () => ({ reviewer: reviewerWithYield(blockReport), stages: completeStages }),
    });
    assert.equal(result.verdict.pass, false, 'a single-call seam must not replay the original verifier as the recheck');
    assert.match(result.verdict.reasons.join(' '), /re-verification did not settle the finding\(s\) the report raised/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given two claims and a recheck that answers only the first twice, When the review runs, Then the second claim keeps the block', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1**: first claim\n- **R2**: second claim\n\nREVIEW_RESULT=BLOCK';
  const recheckDecisions = [
    { candidate_id: 'report-1', disposition: 'rejected', triage: 'stale_record', reason: 'snapshot shows no conflict', evidence: 'feature.mjs:1' },
    { candidate_id: 'report-1', disposition: 'rejected', triage: 'stale_record', reason: 'snapshot shows no conflict', evidence: 'feature.mjs:1' },
  ];
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') return { evidence: completed('review-finding-verifier', { lane: 'correctness', decisions: recheckDecisions, confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, false, 'a duplicate decision cannot stand in for an unexamined claim');
    assert.match(result.verdict.reasons.join(' '), /unproven/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given two claims and a recheck that rejects both by number, When the review runs, Then the evidence passes with both recorded', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1**: first claim\n- **R2**: second claim\n\nREVIEW_RESULT=BLOCK';
  const decisions = [1, 2].map(index => ({ candidate_id: `report-${index}`, disposition: 'rejected', triage: 'stale_record', reason: 'snapshot shows no conflict', evidence: 'feature.mjs:1' }));
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') return { evidence: completed('review-finding-verifier', { lane: 'correctness', decisions, confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, true);
    assert.deepEqual(result.verdict.notes, ['re-verification rejected 2 finding(s) the report raised; the stages confirmed none']);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a recheck that answers with still_present, When the review runs, Then the block is stage-confirmed', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const blockReport = '### Confirmed findings\n- **R1 (blocking)**: a real conflict\n\nREVIEW_RESULT=BLOCK';
  const stageRunner = {
    async run(agent, name) {
      if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
      if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
      if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'FindingRecheck') return { evidence: completed('review-finding-verifier', { lane: 'correctness', decisions: [{ candidate_id: 'report-1', disposition: 'still_present', triage: 'lie', reason: 'the snapshot shows it', evidence: 'feature.mjs:1' }], confirmed_findings: [], confirmed_coverage_gaps: [] }) };
      if (name === 'Synthesis') return { result: reviewerWithYield(blockReport), evidence: completed('reviewer-kit', {}) };
      return { evidence: completed(agent, {}) };
    },
  };
  try {
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /re-verification confirmed 1 finding\(s\)/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a changed function that repeats an existing one, When the review runs, Then the verifier receives the pair with both ranges', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'native-review-reuse-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const body = (names) => `export function ${names.fn}(items) {
  const ${names.out} = [];
  for (const ${names.item} of items) {
    if (!${names.item}) continue;
    if (${names.item}.hidden) continue;
    if (!${names.item}.name) continue;
    if (${names.item}.name.length === 0) continue;
    ${names.out}.push({ name: ${names.item}.name, size: ${names.item}.size, kind: ${names.item}.kind });
  }
  ${names.out}.sort((left, right) => left.name.localeCompare(right.name));
  const ${names.seen} = new Set();
  const ${names.unique} = [];
  for (const ${names.entry} of ${names.out}) {
    if (${names.seen}.has(${names.entry}.name)) continue;
    ${names.seen}.add(${names.entry}.name);
    ${names.unique}.push(${names.entry});
  }
  return ${names.unique};
}
`;
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'native review test']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
    await writeFile(path.join(repo, 'base.mjs'), body({ fn: 'collectVisible', out: 'out', item: 'item', seen: 'seen', unique: 'unique', entry: 'entry' }));
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(path.join(repo, 'feature.mjs'), body({ fn: 'gatherShown', out: 'result', item: 'row', seen: 'met', unique: 'kept', entry: 'candidate' }));
    git(repo, ['add', 'feature.mjs']);
    const calls = [];
    const stageRunner = {
      async run(agent, name, task) {
        calls.push({ name, task });
        if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
        if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
        if (name === 'FindingVerifier') return { evidence: completed('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }) };
        if (name === 'Synthesis') return { result: reviewerWithYield(PASS_REPORT), evidence: completed('reviewer-kit', {}) };
        return { evidence: completed(agent, {}) };
      },
    };
    const result = await runNativeReview({ repo, kitRoot: repo, parentDir: parent, env: {}, stageRunner });
    const verifier = calls.find(call => call.name === 'FindingVerifier');
    assert.ok(verifier, 'the verifier stage ran');
    assert.match(verifier.task, /"candidate_id": "reuse-1"/, 'the deterministic pair reaches the verifier');
    assert.match(verifier.task, /"changed": "feature\.mjs:1"/);
    assert.match(verifier.task, /"existing": "base\.mjs:1"/);
    assert.equal(result.verdict.pass, true, 'a pair the verifier did not confirm changes nothing');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a diff that reads a version no changed module produces, When the review runs, Then the assignment carries the dead version', async () => {
  const repo = await stagedRepo('manifest.mjs');
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  try {
    await writeFile(path.join(repo, 'manifest.mjs'), "export function build() { return { schema: 'product-manifest/v5' }; }\n");
    await writeFile(path.join(repo, 'repair.mjs'), "export function repair(manifest) { return manifest.schema === 'product-manifest/v8'; }\n");
    git(repo, ['add', 'manifest.mjs', 'repair.mjs']);
    let assignment = '';
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: {},
      runTask: async ({ assignment: task }) => {
        assignment = task;
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: completeStages };
      },
    });
    assert.equal(result.staged, true);
    assert.match(assignment, /^Version census \(deterministic scan of 2 file\(s\), 1 family\(ies\), coverage full; evidence, never a finding\):$/m);
    assert.match(assignment, /^- DEAD product-manifest v8: consumed at repair\.mjs:1; no producer of this version exists in the snapshot\.$/m);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given journaling off and a verifier that confirms a reuse lead, When the review runs, Then the PASS is refused', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'native-review-reuse-off-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'native-review-parent-'));
  const body = names => `export function ${names.fn}(items) {
  const ${names.out} = [];
  for (const ${names.item} of items) {
    if (!${names.item}) continue;
    if (${names.item}.hidden) continue;
    if (!${names.item}.name) continue;
    if (${names.item}.name.length === 0) continue;
    ${names.out}.push({ name: ${names.item}.name, size: ${names.item}.size, kind: ${names.item}.kind });
  }
  ${names.out}.sort((left, right) => left.name.localeCompare(right.name));
  const ${names.seen} = new Set();
  const ${names.unique} = [];
  for (const ${names.entry} of ${names.out}) {
    if (${names.seen}.has(${names.entry}.name)) continue;
    ${names.seen}.add(${names.entry}.name);
    ${names.unique}.push(${names.entry});
  }
  return ${names.unique};
}
`;
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'native review test']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
    await writeFile(path.join(repo, 'base.mjs'), body({ fn: 'collectVisible', out: 'out', item: 'item', seen: 'seen', unique: 'unique', entry: 'entry' }));
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(path.join(repo, 'feature.mjs'), body({ fn: 'gatherShown', out: 'result', item: 'row', seen: 'met', unique: 'kept', entry: 'candidate' }));
    git(repo, ['add', 'feature.mjs']);
    const stageRunner = {
      async run(agent, name) {
        if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
        if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
        if (name === 'FindingVerifier') {
          return {
            evidence: completed('review-finding-verifier', {
              lane: 'correctness',
              decisions: [{ candidate_id: 'reuse-1', disposition: 'confirmed', triage: 'lie', reason: 'the same responsibility twice', evidence: 'feature.mjs:1' }],
              confirmed_findings: [],
              confirmed_coverage_gaps: [],
            }),
          };
        }
        if (name === 'Synthesis') return { result: reviewerWithYield(PASS_REPORT), evidence: completed('reviewer-kit', {}) };
        return { evidence: completed(agent, {}) };
      },
    };
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_JOURNAL: 'off' },
      stageRunner,
    });
    assert.equal(result.verdict.pass, false, 'a confirmed duplicate is refused even without the journal');
    assert.match(result.verdict.reasons.join(' '), /verifier confirmed 1 finding\(s\) but the reviewer passed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
