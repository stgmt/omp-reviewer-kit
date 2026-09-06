import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import {
  DiffIdentity,
  ReviewVerdict,
  ReviewRejectionEnvelope,
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

function rejectionOutput(diffText, { kind = 'confirmed_findings', envelope = {}, finding = {}, failure } = {}) {
  const diffHash = createHash('sha256').update(diffText).digest('hex');
  const defaultFinding = {
    finding_id: 'correctness-1',
    priority: 'P2',
    defect_class: 'correctness',
    file_path: 'src/example.mjs',
    line_start: 1,
    line_end: 1,
    verifier_argument: 'The repository already provides the same responsibility.',
    counterexample: 'The staged wrapper only calls the existing mechanism.',
  };
  const value = kind === 'review_failure'
    ? {
        schema: 'review-rejection-envelope@1',
        kind,
        diff_hash: diffHash,
        findings: [],
        failure: failure ?? {
          code: 'execution_failure',
          message: 'The reviewer process did not complete successfully.',
        },
        ...envelope,
      }
    : {
        schema: 'review-rejection-envelope@1',
        kind,
        diff_hash: diffHash,
        findings: [{ ...defaultFinding, ...finding }],
        ...envelope,
      };
  return [
    'REVIEW_REJECTION_ENVELOPE_BEGIN',
    JSON.stringify(value),
    'REVIEW_REJECTION_ENVELOPE_END',
    'REVIEW_RESULT=BLOCK',
    '',
  ].join('\n');
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
        stdout: rejectionOutput('bad diff content'),
        stderr: '',
      }),
      now: new Date('2026-09-04T10:05:00.000Z'),
      logger,
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^reviewer-kit BLOCK: .+\n$/);
    assert.match(logs[1], /^REVIEW_REJECTION_REPORT=.+\n$/);
    assert.equal(result.envelope.kind, 'confirmed_findings');
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
      omp: () => ({ status: 0, stdout: rejectionOutput('same diff content'), stderr: '' }),
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
        stdout: rejectionOutput('diff for stage failure test', { kind: 'review_failure' }),
        stderr: '',
      }),
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    const reportContent = await readFile(result.reportPath, 'utf8');
    assert.match(reportContent, /## Normalized rejection envelope/);
    assert.match(reportContent, /\"code\": \"execution_failure\"/);
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
    assert.match(capturedPrompt, /Your next tool call must be the native task tool directly/);
    assert.match(capturedPrompt, /skill:\/\/multi-stage-review/);
    assert.match(capturedPrompt, /skill:\/\/reality-first-review/);
    assert.match(capturedPrompt, /relevant project or user review skills discovered by OMP/);
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


  it('ReviewRejectionEnvelope invariant: accepts only the strict caller-owned schema', () => {
    const diff = DiffIdentity.fromString('envelope diff');
    const validOutput = rejectionOutput('envelope diff');
    const valid = ReviewRejectionEnvelope.evaluate({ output: validOutput, diffIdentity: diff, processStatus: 0 });
    assert.equal(valid.verdict.reason, 'explicit_block');
    assert.equal(valid.envelope.kind, 'confirmed_findings');
    assert.equal(valid.envelope.findings[0].defect_class, 'correctness');

    const processFailure = ReviewRejectionEnvelope.evaluate({
      output: 'provider leaked raw details',
      diffIdentity: diff,
      processStatus: 1,
      processError: 'secret provider response',
    });
    assert.equal(processFailure.envelope.failure.code, 'execution_failure');
    assert.doesNotMatch(processFailure.envelope.failure.message, /secret|provider leaked/);

    const customFailure = ReviewRejectionEnvelope.evaluate({
      output: rejectionOutput('envelope diff', {
        kind: 'review_failure',
        failure: {
          code: 'execution_failure',
          message: 'stage 3 verifier returned an unavailable diagnostic',
        },
      }),
      diffIdentity: diff,
      processStatus: 0,
    });
    assert.equal(customFailure.envelope.failure.message, 'stage 3 verifier returned an unavailable diagnostic');

    const malformedCases = [
      ['missing_rejection_envelope', 'REVIEW_RESULT=BLOCK'],
      ['multiple_verdict_markers', 'REVIEW_RESULT=BLOCK\nREVIEW_RESULT=BLOCK'],
      ['malformed_rejection_envelope', 'REVIEW_REJECTION_ENVELOPE_BEGIN\n{bad json}\nREVIEW_REJECTION_ENVELOPE_END\nREVIEW_RESULT=BLOCK'],
      ['contradictory_rejection_envelope', validOutput.replace('REVIEW_RESULT=BLOCK', 'REVIEW_RESULT=PASS')],
      ['malformed_rejection_envelope', rejectionOutput('envelope diff', { envelope: { diff_hash: 'b'.repeat(64) } })],
      ['malformed_rejection_envelope', rejectionOutput('envelope diff', { envelope: { unexpected: true } })],
      ['malformed_rejection_envelope', rejectionOutput('envelope diff', { finding: { defect_class: 'maintainability' } })],
      ['malformed_rejection_envelope', rejectionOutput('envelope diff', { finding: { file_path: '../escape.mjs' } })],
      ['malformed_rejection_envelope', rejectionOutput('envelope diff', { finding: { line_start: 2, line_end: 1 } })],
      ['malformed_rejection_envelope', 'REVIEW_REJECTION_ENVELOPE_BEGIN\n{"schema":"review-rejection-envelope@1","schema":"review-rejection-envelope@1"}\nREVIEW_REJECTION_ENVELOPE_END\nREVIEW_RESULT=BLOCK'],
    ];
    for (const [expectedCode, output] of malformedCases) {
      const evaluated = ReviewRejectionEnvelope.evaluate({ output, diffIdentity: diff, processStatus: 0 });
      assert.equal(evaluated.verdict.value, 'BLOCK');
      assert.equal(evaluated.envelope.failure.code, expectedCode);
    }
  });

  it('ReviewPrompt invariant: requires non-empty diff hash, mandates multi-stage-review, and embeds required agent name', () => {
    assert.throws(() => new ReviewPrompt(''), TypeError);
    const prompt = new ReviewPrompt('abc123hash');
    assert.match(prompt.toString(), /abc123hash/);
    assert.match(prompt.toString(), /reviewer-kit/);
    assert.match(prompt.toString(), /multi-stage-review/);
    assert.match(prompt.toString(), /reality-first-review/);
    assert.match(prompt.toString(), /relevant project or user review skills discovered by OMP/);
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
    const repoRoot = await createTempRepo('omp-service-');
    const service = createReviewWorkflowService({
      git: (args) => (args[0] === 'rev-parse' ? Buffer.from(`${repoRoot}\n`) : Buffer.from('staged diff')),
      omp: () => ({ status: 0, stdout: rejectionOutput('staged diff'), stderr: '' }),
      clock: () => new Date('2026-09-04T12:00:00.000Z'),
      logger: { log: () => {}, error: () => {} },
    });
    const result = await service.execute({ cwd: repoRoot });
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
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
  it('ReviewExecutionResult invariant: rejects a non-array model trace', () => {
    assert.throws(
      () => new ReviewExecutionResult({ exitCode: 1, skipped: false, verdict: 'BLOCK', modelsTried: 'not-an-array' }),
      /modelsTried must be an array of strings/,
    );
  });

});
