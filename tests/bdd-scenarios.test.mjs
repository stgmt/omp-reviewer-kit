import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  createReviewWorkflowService,
} from '../src/index.mjs';
import { runReview } from '../scripts/run-review.mjs';

/**
 * Creates an isolated mock repository directory.
 */
async function createTempRepo(prefix = 'omp-bdd-') {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

function createFakeGit(repoRoot, diffText = '', calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      return Buffer.from(`${repoRoot}\n`);
    }
    if (args[0] === 'diff') {
      return Buffer.from(diffText);
    }
    return Buffer.alloc(0);
  };
}

describe('Feature: Staged Change Review Gate (BDD Scenarios)', () => {
  it('Scenario 1: Given clean staged changes, When reviewer-kit returns PASS, Then commit is permitted and report is saved', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'clean diff content');
    const logs = [];
    const logger = {
      log: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    };

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: (prompt, cwd, timeout) => {
        return {
          status: 0,
          stdout: 'No blocking issues found.\nREVIEW_RESULT=PASS\n',
          stderr: '',
        };
      },
      now: new Date('2026-09-04T10:00:00.000Z'),
      logger,
    });

    // Then
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, 'PASS');
    assert.match(result.reportPath, /2026-09-04T10-00-00-000Z/);

    const reportContent = await readFile(result.reportPath, 'utf8');
    assert.match(reportContent, /result: PASS/);
    assert.match(reportContent, /No blocking issues found/);
    assert.match(logs.join(''), /reviewer-kit PASS/);
  });

  it('Scenario 2: Given violating staged changes, When reviewer-kit returns BLOCK, Then commit is blocked with exit code 1', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'bad diff content');
    const logs = [];
    const logger = {
      log: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    };

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({
        status: 0,
        stdout: 'Violation found: Rule 1 reality-first violated.\nREVIEW_RESULT=BLOCK\n',
        stderr: '',
      }),
      now: new Date('2026-09-04T10:05:00.000Z'),
      logger,
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.match(logs.join(''), /reviewer-kit BLOCK/);
    assert.match(logs.join(''), /Rule 1 reality-first violated/);
  });

  it('Scenario 3: Given no staged changes, When review executes, Then review is skipped without invoking OMP', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, '');
    let ompCalled = false;

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => {
        ompCalled = true;
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
    });

    // Then
    assert.equal(result.exitCode, 0);
    assert.equal(result.skipped, true);
    assert.equal(ompCalled, false);
    assert.equal(result.reportPath, undefined);
  });

  it('Scenario 4: Given reviewer execution failure, When review executes, Then review fails closed with exit code 1', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'diff requiring review');

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({
        status: 1,
        stdout: '',
        stderr: 'OMP crash: connection to provider timed out\n',
      }),
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    const reportContent = await readFile(result.reportPath, 'utf8');
    assert.match(reportContent, /OMP crash: connection to provider timed out/);
  });

  it('Scenario 5: Given malformed verdict marker, When review executes, Then review fails closed', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'sample diff');

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({
        status: 0,
        stdout: 'Looks good! REVIEW_RESULT=PASSED\n',
        stderr: '',
      }),
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
  });

  it('Scenario 6: Given multiple conflicting verdict markers, When review executes, Then review fails closed', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'sample diff');

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({
        status: 0,
        stdout: 'REVIEW_RESULT=PASS\nWait, actually:\nREVIEW_RESULT=BLOCK\n',
        stderr: '',
      }),
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
  });

  it('Scenario 7: Given unstaged changes in working tree, When review executes, Then only staged diff is hashed', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const calls = [];
    const git = createFakeGit(repoRoot, 'staged only diff content', calls);

    // When
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

  it('Scenario 9: Given mandatory stage execution failure, When reviewer-kit fails closed, Then commit is blocked with exit code 1', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'diff for stage failure test');

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: () => ({
        status: 0,
        stdout: 'Stage review-finding-verifier failed: StructuredSubagentError: execution failed\nREVIEW_RESULT=BLOCK\n',
        stderr: '',
      }),
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    const reportContent = await readFile(result.reportPath, 'utf8');
    assert.match(reportContent, /Stage review-finding-verifier failed/);
  });

  it('Scenario 10: Given dispatcher prompt generation, When ReviewPrompt is rendered, Then it mandates multi-stage-review and names only reviewer-kit at the top level', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const git = createFakeGit(repoRoot, 'prompt verification diff');
    let capturedPrompt = '';

    // When
    await runReview({
      cwd: repoRoot,
      git,
      omp: (prompt) => {
        capturedPrompt = prompt;
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
    });

    // Then
    assert.match(capturedPrompt, /Run exactly one native task with agent "reviewer-kit"\./);
    assert.match(capturedPrompt, /skill:\/\/multi-stage-review/);
    assert.match(capturedPrompt, /skill:\/\/reality-first-review/);
    assert.doesNotMatch(capturedPrompt, /do not run any other agent/);
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
    assert.equal(ReviewVerdict.fromOutput('REVIEW_RESULT=PASS\nREVIEW_RESULT=PASS').isBlock(), true);
    assert.equal(ReviewVerdict.fromOutput('REVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK').isBlock(), true);
  });

  it('ReviewPrompt invariant: requires non-empty diff hash, mandates multi-stage-review, and embeds required agent name', () => {
    assert.throws(() => new ReviewPrompt(''), TypeError);
    const prompt = new ReviewPrompt('abc123hash');
    assert.match(prompt.toString(), /abc123hash/);
    assert.match(prompt.toString(), /reviewer-kit/);
    assert.match(prompt.toString(), /multi-stage-review/);
    assert.match(prompt.toString(), /reality-first-review/);
    assert.doesNotMatch(prompt.toString(), /do not run any other agent/);
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

  it('ReviewWorkflowService invariant: requires both status 0 and PASS verdict for approval', async () => {
    const service = createReviewWorkflowService({
      git: (args) => (args[0] === 'rev-parse' ? Buffer.from('/repo\n') : Buffer.from('staged diff')),
      omp: () => ({ status: 0, stdout: 'REVIEW_RESULT=BLOCK\n', stderr: '' }),
      clock: () => new Date('2026-09-04T12:00:00.000Z'),
      logger: { log: () => {}, error: () => {} },
    });
    const result = await service.execute({ cwd: '/repo' });
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
  });

  it('SubprocessGitAdapter invariant: enforces --cached in staged diff invocation', () => {
    let passedArgs = [];
    const adapter = new SubprocessGitAdapter((args) => {
      passedArgs = args;
      return Buffer.from('diff-content');
    });
    const diff = adapter.getStagedDiff('/repo');
    assert.equal(passedArgs.includes('--cached'), true);
    assert.deepEqual(passedArgs, ['diff', '--cached', '--binary', '--no-ext-diff', '--']);
    assert.equal(diff.isEmpty(), false);
  });
});
