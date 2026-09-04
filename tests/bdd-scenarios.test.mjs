import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';

import {
  DiffIdentity,
  ReviewVerdict,
  ReviewPrompt,
  ReviewReport,
  ReviewExecutionResult,
  SubprocessGitAdapter,
  OmpCliReviewerAdapter,
  FileSystemReportStoreAdapter,
  ReviewWorkflowService,
  createReviewWorkflowService,
  runReview,
} from '../src/index.mjs';

/**
 * Test harness helpers
 */
async function createTempRepo(prefix = 'omp-bdd-') {
  const base = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(base, 'repo');
}

function createFakeGit(repoRoot, stagedDiff = '', calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
    if (args[0] === 'diff') return Buffer.from(stagedDiff);
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };
}

describe('Feature: Staged Change Review Gate (BDD Scenarios)', () => {
  it('Scenario 1: Given clean staged changes, When reviewer-kit returns PASS, Then commit is permitted and report is saved', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const stagedDiff = 'diff --git a/file.js b/file.js\n+console.log("hello");\n';
    const calls = [];
    const git = createFakeGit(repoRoot, stagedDiff, calls);

    let receivedPrompt = '';
    const omp = (prompt) => {
      receivedPrompt = prompt;
      return {
        status: 0,
        stdout: 'Reality-first check completed.\nREVIEW_RESULT=PASS\n',
        stderr: '',
      };
    };

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp,
      now: new Date('2026-09-04T10:00:00.000Z'),
    });

    // Then
    assert.equal(result.exitCode, 0, 'Exit code must be 0 for PASS');
    assert.equal(result.skipped, false, 'Review must not be skipped');
    assert.equal(result.verdict, 'PASS');
    assert.ok(result.reportPath, 'Report path must be returned');

    const expectedHash = createHash('sha256').update(stagedDiff).digest('hex');
    assert.match(receivedPrompt, new RegExp(expectedHash));
    assert.match(receivedPrompt, /agent "reviewer-kit"/);
    assert.match(receivedPrompt, /reality-first-review/);

    const savedReport = await readFile(result.reportPath, 'utf8');
    assert.match(savedReport, new RegExp(`staged diff hash: ${expectedHash}`));
    assert.match(savedReport, /result: PASS/);
    assert.match(savedReport, /Reality-first check completed/);
  });

  it('Scenario 2: Given violating staged changes, When reviewer-kit returns BLOCK, Then commit is blocked with exit code 1', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const stagedDiff = 'diff --git a/bad.js b/bad.js\n+evil();\n';
    const git = createFakeGit(repoRoot, stagedDiff);

    const omp = () => ({
      status: 0,
      stdout: 'Violation found: Rule 1 reality-first violated.\nREVIEW_RESULT=BLOCK\n',
      stderr: '',
    });

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp,
      now: new Date('2026-09-04T10:05:00.000Z'),
    });

    // Then
    assert.equal(result.exitCode, 1, 'Exit code must be 1 for BLOCK');
    assert.equal(result.verdict, 'BLOCK');
    assert.ok(result.reportPath);

    const savedReport = await readFile(result.reportPath, 'utf8');
    assert.match(savedReport, /result: BLOCK/);
    assert.match(savedReport, /Violation found: Rule 1 reality-first violated/);
  });

  it('Scenario 3: Given no staged changes, When review executes, Then review is skipped without invoking OMP', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, '');
    let ompInvoked = false;
    const omp = () => {
      ompInvoked = true;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    };

    // When
    const result = await runReview({ cwd: repoRoot, git, omp });

    // Then
    assert.equal(result.exitCode, 0);
    assert.equal(result.skipped, true);
    assert.equal(ompInvoked, false, 'OMP must never be invoked when staged diff is empty');
  });

  it('Scenario 4: Given reviewer execution failure, When review executes, Then review fails closed with exit code 1', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'some diff');
    const omp = () => ({
      status: 1,
      stdout: '',
      stderr: 'OMP crash: connection to provider timed out',
    });

    // When
    const result = await runReview({ cwd: repoRoot, git, omp });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.ok(result.reportPath);

    const savedReport = await readFile(result.reportPath, 'utf8');
    assert.match(savedReport, /result: BLOCK/);
    assert.match(savedReport, /OMP crash: connection to provider timed out/);
  });

  it('Scenario 5: Given malformed verdict marker, When review executes, Then review fails closed', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'some diff');
    const omp = () => ({
      status: 0,
      stdout: 'REVIEW_RESULT=PASSED\n',
      stderr: '',
    });

    // When
    const result = await runReview({ cwd: repoRoot, git, omp });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
  });

  it('Scenario 6: Given multiple conflicting verdict markers, When review executes, Then review fails closed', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'some diff');
    const omp = () => ({
      status: 0,
      stdout: 'REVIEW_RESULT=PASS\nWait, actually:\nREVIEW_RESULT=BLOCK\n',
      stderr: '',
    });

    // When
    const result = await runReview({ cwd: repoRoot, git, omp });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
  });

  it('Scenario 7: Given unstaged changes in working tree, When review executes, Then only staged diff is hashed', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const stagedDiff = 'staged content';
    const calls = [];
    const git = createFakeGit(repoRoot, stagedDiff, calls);

    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    });

    // Then
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls[1], ['diff', '--cached', '--binary', '--no-ext-diff', '--']);
  });

  it('Scenario 8: Given consecutive reviews, When reviews finish, Then each report is uniquely preserved', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'same diff content');

    const first = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
      now: new Date('2026-09-04T12:00:00.000Z'),
    });

    const second = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({ status: 0, stdout: 'REVIEW_RESULT=BLOCK\n', stderr: '' }),
      now: new Date('2026-09-04T12:00:01.000Z'),
    });

    // Then
    assert.notEqual(first.reportPath, second.reportPath);
    assert.match(await readFile(first.reportPath, 'utf8'), /result: PASS/);
    assert.match(await readFile(second.reportPath, 'utf8'), /result: BLOCK/);
  });
});

describe('Feature: OOP/DDD Domain Invariant Units', () => {
  it('DiffIdentity invariant: enforces Buffer and calculates deterministic SHA-256', () => {
    assert.throws(() => new DiffIdentity('not a buffer'), TypeError);
    const diff = DiffIdentity.fromString('sample');
    assert.equal(diff.isEmpty(), false);
    assert.equal(diff.hash, createHash('sha256').update('sample').digest('hex'));
  });

  it('ReviewVerdict invariant: rejects invalid values and parses strictly', () => {
    assert.throws(() => new ReviewVerdict('MAYBE'), Error);
    assert.equal(ReviewVerdict.fromOutput('no markers here').isBlock(), true);
    assert.equal(ReviewVerdict.fromOutput('REVIEW_RESULT=PASS').isPass(), true);
    assert.equal(ReviewVerdict.fromOutput('REVIEW_RESULT=BLOCK').isBlock(), true);
  });

  it('ReviewPrompt invariant: requires non-empty diff hash and embeds required agent name', () => {
    assert.throws(() => new ReviewPrompt(''), TypeError);
    const prompt = new ReviewPrompt('abc123hash');
    assert.match(prompt.toString(), /abc123hash/);
    assert.match(prompt.toString(), /reviewer-kit/);
  });

  it('ReviewReport invariant: renders correct markdown structure', () => {
    const report = new ReviewReport({
      diffIdentity: 'def456',
      verdict: 'PASS',
      rawOutput: 'All tests passed.',
      timestamp: new Date('2026-09-04T15:00:00.000Z'),
    });
    assert.equal(report.filename, '2026-09-04T15-00-00-000Z-def456.md');
    assert.match(report.toMarkdown(), /staged diff hash: def456/);
    assert.match(report.toMarkdown(), /result: PASS/);
    assert.match(report.toMarkdown(), /All tests passed\./);
  });
});
