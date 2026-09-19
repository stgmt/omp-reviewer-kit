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
  SlopReport,
  ReviewReport,
  ReviewExecutionResult,
  SubprocessGitAdapter,
  createReviewWorkflowService,
} from '../src/index.mjs';
import { runReview } from '../scripts/run-review.mjs';

const TEST_ROLES = { smol: 'acme/smol-flash:high', task: 'acme/task-fast:high', slow: 'acme/slow-max:max' };
const testRoleResolver = () => TEST_ROLES;

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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
      omp: () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
      now: new Date('2026-09-04T12:00:00.000Z'),
    });

    const second = await runReview({
      cwd: repoRoot,
      git,
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
      ompOptions: { roleResolver: testRoleResolver },
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
    assert.match(capturedPrompt, /staged snapshot directory/);
    assert.match(capturedPrompt, /never from the working tree/);
    assert.match(capturedPrompt, /correctness and security risk lanes/);
    assert.match(capturedPrompt, /focused tests.*YAGNI|YAGNI.*focused tests/i);
    assert.match(capturedPrompt, /supported name, agent, and task fields/);
    assert.match(capturedPrompt, /omit model, outputSchema, schemaMode, and isolated/);
    assert.match(capturedPrompt, /reproduce its complete report verbatim/);
    assert.match(capturedPrompt, /read that URI first/);
    assert.match(capturedPrompt, /never summarize or omit a rejection envelope/);
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
          ['malformed_rejection_envelope', validOutput.replace('REVIEW_REJECTION_ENVELOPE_END\nREVIEW_RESULT=BLOCK', 'REVIEW_REJECTION_ENVELOPE_END\nunexpected output\nREVIEW_RESULT=BLOCK')],
          ['contradictory_rejection_envelope', validOutput.replace('REVIEW_RESULT=BLOCK', 'REVIEW_RESULT=PASS')],
          ['malformed_rejection_envelope', rejectionOutput('envelope diff', { envelope: { diff_hash: 'b'.repeat(64) } })],
          ['malformed_rejection_envelope', rejectionOutput('envelope diff', { envelope: { unexpected: true } })],
          ['malformed_rejection_envelope', rejectionOutput('envelope diff', { finding: { defect_class: 'maintainability' } })],
          ['malformed_rejection_envelope', rejectionOutput('envelope diff', { finding: { file_path: '../escape.mjs' } })],
          ['malformed_rejection_envelope', rejectionOutput('envelope diff', { finding: { line_start: 2, line_end: 1 } })],
          ['malformed_rejection_envelope', 'REVIEW_REJECTION_ENVELOPE_BEGIN\n{"schema":"review-rejection-envelope@1","schema":"review-rejection-envelope@1"}\nREVIEW_REJECTION_ENVELOPE_END\nREVIEW_RESULT=BLOCK'],
          ['malformed_rejection_envelope', validOutput.replace('"schema":', '"__proto__":{"unexpected":true},"schema":')],
          ['malformed_rejection_envelope', validOutput.replace('"finding_id":', '"__proto__":{"unexpected":true},"finding_id":')],
          ['malformed_rejection_envelope', rejectionOutput('envelope diff', {
            kind: 'review_failure',
            failure: {
              code: 'execution_failure',
              message: 'stage 3 verifier returned an unavailable diagnostic',
            },
          }).replace('"code":', '"__proto__":{"unexpected":true},"code":')],
        ];
    for (const [expectedCode, output] of malformedCases) {
      const evaluated = ReviewRejectionEnvelope.evaluate({ output, diffIdentity: diff, processStatus: 0 });
      assert.equal(evaluated.verdict.value, 'BLOCK');
      assert.equal(evaluated.envelope.failure.code, expectedCode);
    }

    const innerTaskResult = [
      '<task-result id="ReviewerKit">',
      '<output>',
      'REVIEW_REJECTION_ENVELOPE_BEGIN',
      JSON.stringify({
        schema: 'review-rejection-envelope@1',
        kind: 'review_failure',
        diff_hash: diff.hash,
        findings: [],
        failure: { code: 'execution_failure', message: 'inner failure' },
      }),
      'REVIEW_REJECTION_ENVELOPE_END',
      '</output>',
      '</task-result>',
    ].join('\n');

    const recovered = ReviewRejectionEnvelope.evaluate({
      output: `${innerTaskResult}\n${validOutput}`,
      diffIdentity: diff,
      processStatus: 0,
    });
    assert.equal(recovered.verdict.value, 'BLOCK');
    assert.equal(recovered.envelope.kind, 'confirmed_findings');

    const adjacentMalformed = ReviewRejectionEnvelope.evaluate({
      output: `${innerTaskResult}\nREVIEW_REJECTION_ENVELOPE_BEGIN\n{still bad}\nREVIEW_REJECTION_ENVELOPE_END\nREVIEW_RESULT=BLOCK`,
      diffIdentity: diff,
      processStatus: 0,
    });
    assert.equal(adjacentMalformed.envelope.failure.code, 'malformed_rejection_envelope');
  });

  it('ReviewRejectionEnvelope coverage_required: accepts strict coverage items and deep-freezes them', () => {
    const diff = DiffIdentity.fromString('coverage diff');
    const diffHash = diff.hash;
    const item = {
      coverage_id: 'coverage-1',
      file_path: 'src/example.mjs',
      line_start: 10,
      line_end: 24,
      behavior: 'New retry branch on provider 429 has no covering test.',
      required_tests: [
        { kind: 'edge', scenario: '429 on the final attempt exhausts retries.', mutant: '' },
        { kind: 'mutation', scenario: 'Test fails when the attempts guard is removed.', mutant: 'remove the attempts < max guard' },
      ],
    };
    const output = [
      'REVIEW_REJECTION_ENVELOPE_BEGIN',
      JSON.stringify({
        schema: 'review-rejection-envelope@1',
        kind: 'coverage_required',
        diff_hash: diffHash,
        findings: [],
        coverage_items: [item],
      }),
      'REVIEW_REJECTION_ENVELOPE_END',
      'REVIEW_RESULT=BLOCK',
    ].join('\n');

    const evaluated = ReviewRejectionEnvelope.evaluate({ output, diffIdentity: diff, processStatus: 0 });
    assert.equal(evaluated.verdict.value, 'BLOCK');
    assert.equal(evaluated.envelope.kind, 'coverage_required');
    assert.equal(evaluated.envelope.findings.length, 0);
    assert.equal(evaluated.envelope.coverageItems.length, 1);
    assert.equal(evaluated.envelope.coverageItems[0].coverage_id, 'coverage-1');

    // Deep-freeze: mutating the source object after evaluation must not alter the envelope.
    item.behavior = 'tampered';
    item.required_tests.push({ kind: 'edge', scenario: 'injected', mutant: '' });
    assert.equal(evaluated.envelope.coverageItems[0].behavior, 'New retry branch on provider 429 has no covering test.');
    assert.equal(evaluated.envelope.coverageItems[0].required_tests.length, 2);
    assert.throws(() => evaluated.envelope.coverageItems[0].required_tests.push({ kind: 'edge', scenario: 'x', mutant: '' }), TypeError);
    assert.throws(() => { evaluated.envelope.coverageItems[0].behavior = 'tampered'; }, TypeError);

    // Getter fallback: a confirmed_findings envelope exposes an empty coverageItems list.
    const findingsEvaluated = ReviewRejectionEnvelope.evaluate({
      output: rejectionOutput('coverage diff'),
      diffIdentity: diff,
      processStatus: 0,
    });
    assert.equal(findingsEvaluated.envelope.kind, 'confirmed_findings');
    assert.deepEqual(findingsEvaluated.envelope.coverageItems, []);

    // Reject paths through the domain copy.
    const malformedCoverage = [
      { ...item, required_tests: [{ kind: 'mutation', scenario: 's', mutant: '' }] },
      { ...item, required_tests: [{ kind: 'edge', scenario: 's' }] },
      { ...item, coverage_id: '' },
      { ...item, file_path: '../escape.mjs' },
      { ...item, line_start: 5, line_end: 4 },
      { ...item, required_tests: [] },
    ];
    for (const bad of malformedCoverage) {
      const badOutput = [
        'REVIEW_REJECTION_ENVELOPE_BEGIN',
        JSON.stringify({
          schema: 'review-rejection-envelope@1',
          kind: 'coverage_required',
          diff_hash: diffHash,
          findings: [],
          coverage_items: [bad],
        }),
        'REVIEW_REJECTION_ENVELOPE_END',
        'REVIEW_RESULT=BLOCK',
      ].join('\n');
      const rejected = ReviewRejectionEnvelope.evaluate({ output: badOutput, diffIdentity: diff, processStatus: 0 });
      assert.equal(rejected.envelope.kind, 'review_failure');
      assert.equal(rejected.envelope.failure.code, 'malformed_rejection_envelope');
    }

    // Duplicate coverage_id rejected.
    const dupOutput = [
      'REVIEW_REJECTION_ENVELOPE_BEGIN',
      JSON.stringify({
        schema: 'review-rejection-envelope@1',
        kind: 'coverage_required',
        diff_hash: diffHash,
        findings: [],
        coverage_items: [item, { ...item, behavior: 'other' }],
      }),
      'REVIEW_REJECTION_ENVELOPE_END',
      'REVIEW_RESULT=BLOCK',
    ].join('\n');
    const dup = ReviewRejectionEnvelope.evaluate({ output: dupOutput, diffIdentity: diff, processStatus: 0 });
    assert.equal(dup.envelope.failure.code, 'malformed_rejection_envelope');

    // Additional rejection boundaries: non-empty findings, non-string edge mutant,
    // zero line_start, unknown top-level key, findings-must-be-empty guard.
    const boundaryCases = [
      { findings: [item], coverage_items: [item] },
      { findings: [], coverage_items: [{ ...item, required_tests: [{ kind: 'edge', scenario: 's', mutant: 5 }] }] },
      { findings: [], coverage_items: [{ ...item, line_start: 0 }] },
      { findings: [], coverage_items: [item], unexpected: true },
      { findings: [], coverage_items: [{ ...item, required_tests: [{ kind: 'boundary', scenario: 's', mutant: '' }] }] },
      { findings: [], coverage_items: 'x' },
      { findings: [], coverage_items: [null] },
      { findings: [], coverage_items: [42] },
      { findings: [], coverage_items: [{ ...item, required_tests: [null] }] },
    ];
    for (const overrides of boundaryCases) {
      const badOutput = [
        'REVIEW_REJECTION_ENVELOPE_BEGIN',
        JSON.stringify({
          schema: 'review-rejection-envelope@1',
          kind: 'coverage_required',
          diff_hash: diffHash,
          ...overrides,
        }),
        'REVIEW_REJECTION_ENVELOPE_END',
        'REVIEW_RESULT=BLOCK',
      ].join('\n');
      const rejected = ReviewRejectionEnvelope.evaluate({ output: badOutput, diffIdentity: diff, processStatus: 0 });
      assert.equal(rejected.envelope.kind, 'review_failure');
      assert.equal(rejected.envelope.failure.code, 'malformed_rejection_envelope');
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
    assert.match(prompt.toString(), /correctness and security risk lanes/);
    assert.match(prompt.toString(), /focused tests.*YAGNI|YAGNI.*focused tests/i);
    assert.match(prompt.toString(), /reproduce its complete report verbatim/);
    assert.match(prompt.toString(), /read that URI first/);
    assert.match(prompt.toString(), /never summarize or omit a rejection envelope/);
    assert.doesNotMatch(prompt.toString(), /do not run any other agent/);
    assert.ok(prompt.toString().includes('Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.'));
    assert.ok(prompt.toString().includes('The verdict contract in this prompt overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line as the last non-empty line of the output — markers anywhere else are ignored — even if a skill describes a different verdict vocabulary.'));
  });

  it('ReviewPrompt inlines a small diff and forbids git re-derivation', () => {
    const diffText = 'diff --git a/calc.js b/calc.js\n+export const divide = (x) => x / 0;\n';
    const prompt = ReviewPrompt.forDiff('abc123hash', '/snap/dir', ['calc.js'], { inlineDiff: diffText });
    const output = prompt.toString();

    assert.match(output, /---STAGED DIFF \(inline, authoritative\)---/);
    assert.ok(output.includes(diffText));
    assert.match(output, /---END STAGED DIFF---/);
    assert.match(output, /MUST NOT run git diff, git show, or git cat-file/);
    assert.match(output, /Embed the inline diff verbatim into every subagent task text/);
    assert.doesNotMatch(output, /materialized at .*diff\.patch/);
  });

  it('ReviewPrompt falls back to snapshot paths when no inline diff is given', () => {
    const prompt = ReviewPrompt.forDiff('abc123hash', '/snap/dir', ['calc.js']);
    const output = prompt.toString();

    assert.match(output, /materialized at .*\.review\/diff\.patch/);
    assert.doesNotMatch(output, /STAGED DIFF \(inline/);
  });

  it('S9: ReviewPrompt output includes raw markdown reproduction and verdict contract override instructions', () => {
    // Given
    const prompt = new ReviewPrompt('abc123hash');

    // When
    const output = prompt.toString();

    // Then
    assert.ok(output.includes('Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.'));
    assert.ok(output.includes('The verdict contract in this prompt overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line as the last non-empty line of the output — markers anywhere else are ignored — even if a skill describes a different verdict vocabulary.'));
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

  it('ReviewReport invariant: renders verified okay checks', () => {
    const report = new ReviewReport({
      diffIdentity: 'verified123',
      verdict: 'PASS',
      rawOutput: 'Reviewer report without a verified section.',
      verifiedOk: ['staged snapshot was materialized from the Git index'],
    });
    assert.match(report.toMarkdown(), /### Verified-OK/);
    assert.match(report.toMarkdown(), /staged snapshot was materialized from the Git index/);
  });

  it('ReviewWorkflowService invariant: requires both status 0 and PASS verdict for approval', async () => {
    const repoRoot = await createTempRepo('omp-service-');
    const service = createReviewWorkflowService({
      git: (args) => {
        if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
        if (args[0] === 'diff') return Buffer.from('staged diff');
        if (args[0] === 'ls-files') return Buffer.alloc(0);
        return Buffer.alloc(0);
      },
      omp: () => ({ status: 0, stdout: rejectionOutput('staged diff'), stderr: '' }),
      clock: () => new Date('2026-09-04T12:00:00.000Z'),
      logger: { log: () => {}, error: () => {} },
    });
    const result = await service.execute({ cwd: repoRoot });
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('SubprocessGitAdapter invariant: enforces --cached in staged diff invocation', async () => {
    let passedArgs = [];
    const adapter = new SubprocessGitAdapter((args) => {
      passedArgs = args;
      return Buffer.from('diff-content');
    });
    const diff = await adapter.getStagedDiff('/repo');
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

  it('Scenario: Given a review run, When it completes, Then runs.jsonl and last-run.json expose the full trace', async () => {
    // Given
    const repoRoot = await createTempRepo('omp-telemetry-bdd-');
    const git = createFakeGit(repoRoot, 'observable diff content');

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      ompOptions: { roleResolver: testRoleResolver },
      omp: async (prompt, cwd, timeout, model, options) => {
        options?.onSpawn?.(5150);
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
      now: new Date('2026-09-13T09:00:00.000Z'),
      logger: { log: () => {}, error: () => {} },
    });

    // Then
    assert.equal(result.exitCode, 0);
    const reportsDir = path.join(repoRoot, 'audit-reports', 'commit-reviews');
    const events = (await readFile(path.join(reportsDir, 'runs.jsonl'), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const attemptStarted = events.find((event) => event.type === 'review_attempt_started');
    assert.equal(attemptStarted.pid, 5150);
    const finished = events.find((event) => event.type === 'run_finished');
    assert.equal(finished.verdict, 'PASS');
    assert.ok(finished.ompLogHints.some((hint) => hint.includes('5150')));
    const lastRun = JSON.parse(await readFile(path.join(reportsDir, 'last-run.json'), 'utf8'));
    assert.equal(lastRun.state, 'passed');
    assert.equal(lastRun.reportPath, result.reportPath);
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('Scenario: Given both fast model roles are down, When the review runs, Then the commit is blocked with an actionable infrastructure message', async () => {
    // Given
    const repoRoot = await createTempRepo('omp-outage-bdd-');
    const git = createFakeGit(repoRoot, 'outage diff content');
    const logs = [];
    const logger = { log: (msg) => logs.push(msg), error: (msg) => logs.push(msg) };

    // When
    const result = await runReview({
      cwd: repoRoot,
      git,
      omp: async () => ({ status: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests' }),
      ompOptions: {
        primaryModel: '@smol',
        modelsProvider: async () => ['@task'],
        modelProbe: async () => ({ status: 1, stdout: '', stderr: 'provider unavailable' }),
        roleResolver: () => ({ smol: 'acme/smol-flash:high', task: 'acme/task-fast:high' }),
      },
      now: new Date('2026-09-13T09:05:00.000Z'),
      logger,
    });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.match(result.details, /infrastructure failure/);
    assert.match(result.details, /modelRoles\.smol/);
    const lastRun = JSON.parse(await readFile(
      path.join(repoRoot, 'audit-reports', 'commit-reviews', 'last-run.json'), 'utf8'));
    assert.equal(lastRun.state, 'blocked');
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('Scenario: Given staged diff with a deleted test file, When reviewed, Then the dispatcher prompt carries the suspicion map entry', async () => {
    // Given a repository with a deleted test file in staged diff
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'omp-bdd-suspicion-'));
    const stagedDiff = [
      'diff --git a/tests/old.test.mjs b/tests/old.test.mjs',
      'deleted file mode 100644',
      '--- a/tests/old.test.mjs',
      '+++ /dev/null',
      '@@ -1,10 +0,0 @@',
      ...Array.from({ length: 10 }, (_, i) => `-line ${i}`),
    ].join('\n');

    let capturedPrompt = '';
    const fakeGit = (args) => {
      if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
      if (args[0] === 'diff') return Buffer.from(stagedDiff);
      return Buffer.alloc(0);
    };
    const fakeOmp = (prompt) => {
      capturedPrompt = prompt;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    };

    // When reviewed
    const result = await runReview({
      cwd: repoRoot,
      git: fakeGit,
      omp: fakeOmp,
      ompOptions: { roleResolver: () => ({ smol: 'acme/smol-flash:high', task: 'acme/task-fast:high' }) },
      now: new Date('2026-09-15T10:00:00.000Z'),
    });

    // Then
    assert.equal(result.exitCode, 0);
    assert.match(capturedPrompt, /Deterministic suspicion map \(computed from the staged diff; every entry must be addressed\):/);
    assert.match(capturedPrompt, /- tests\/old\.test\.mjs: deleted test file \(10 removed lines\)/);
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('Scenario: Given execution enabled and a staged test that passes without the change, When reviewed, Then the prompt carries the staged-pass/reverted-pass interpretation', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'omp-bdd-exec-'));
    const stagedDiff = [
      'diff --git a/tests/calc.test.mjs b/tests/calc.test.mjs',
      '--- a/tests/calc.test.mjs',
      '+++ b/tests/calc.test.mjs',
      '@@ -1 +1 @@',
      '-1',
      '+2',
      'diff --git a/src/calc.mjs b/src/calc.mjs',
      '--- a/src/calc.mjs',
      '+++ b/src/calc.mjs',
      '@@ -1 +1 @@',
      '-1',
      '+2',
    ].join('\n');

    let capturedPrompt = '';
    const fakeGit = (args) => {
      if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
      if (args[0] === 'diff') return Buffer.from(stagedDiff);
      if (args[0] === 'cat-file') return Buffer.from('1');
      return Buffer.alloc(0);
    };

    const fakeExecutionPort = {
      run: async () => ({ ok: true, exitCode: 0, durationMs: 50, stdout: 'all passed\n', stderr: '' }),
    };

    const result = await runReview({
      cwd: repoRoot,
      git: fakeGit,
      executionPort: fakeExecutionPort,
      execution: {
        enabled: true,
        command: 'npm test',
        redProof: true,
      },
      omp: (prompt) => {
        capturedPrompt = prompt;
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
      ompOptions: { roleResolver: () => ({ smol: 'acme/smol-flash:high', task: 'acme/task-fast:high' }) },
      now: new Date('2026-09-15T11:00:00.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.match(capturedPrompt, /staged pass \+ reverted pass => the staged tests do not discriminate the staged change/);
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  });

});

describe('Feature: Slop Adversarial Audit (BDD Scenarios)', () => {
  // Simulates the slop orchestrator's mandatory stage chain: a fake task
  // dispatch returns the slop-scout candidate list, then the slop-verifier
  // verdict; stage 3 synthesizes the report via SlopReport (the single source
  // for the VERDICT: contract the orchestrator emits).
  function createFakeSlopDispatch({ scoutResult, verifierResult }) {
    const calls = [];
    return {
      calls,
      dispatch: async (agentName, taskText) => {
        calls.push({ agentName, taskText });
        if (agentName === 'slop-scout') return scoutResult;
        if (agentName === 'slop-verifier') return verifierResult;
        throw new Error(`unexpected agent ${agentName}`);
      },
    };
  }

  async function runSlopOrchestration(dispatch, { target = '', focus = '' } = {}) {
    const scout = await dispatch('slop-scout', `target=${target} focus=${focus}`);
    if (!scout || !Array.isArray(scout.candidates)) {
      return SlopReport.failure('slop-scout failed or returned no candidates; nothing inspected; this is NOT a clean result').toString();
    }
    const verifier = await dispatch('slop-verifier', JSON.stringify(scout.candidates));
    if (!verifier || !Array.isArray(verifier.verified)) {
      return SlopReport.failure(`slop-verifier failed; ${scout.candidates.length} candidate finding(s) left unverified; this is NOT a clean result`).toString();
    }
    return new SlopReport(verifier).toString();
  }

  it('Scenario: Given a verified P1 candidate, When the slop orchestrator synthesizes, Then it emits VERDICT: BLOCKED', async () => {
    // Given
    const { calls, dispatch } = createFakeSlopDispatch({
      scoutResult: {
        candidates: [
          { file: 'tests/calc.test.mjs', line: '4', claim: 'assert.ok(true) cannot fail', suspectedCategory: 'P1_BLOCKER', evidence: 'assert.ok(true)' },
        ],
        summary: 'one dead check',
      },
      verifierResult: {
        verified: [
          { file: 'tests/calc.test.mjs', line: '4', title: 'Vacuous check cannot turn red', category: 'P1', observation: 'assert.ok(true)', failureMechanism: 'No code change can fail this test', nativeAlternative: '' },
        ],
        rejectedCount: 0,
        verdict: 'BLOCKED',
        verdictReason: 'One dead check blocks the suite',
      },
    });

    // When
    const report = await runSlopOrchestration(dispatch, { target: 'tests/', focus: 'tests' });

    // Then
    assert.equal(calls[0].agentName, 'slop-scout');
    assert.equal(calls[1].agentName, 'slop-verifier');
    assert.match(calls[1].taskText, /calc\.test\.mjs/);
    assert.match(report, /^VERDICT: BLOCKED — One dead check blocks the suite/);
    assert.match(report, /### 🔴 P1: Блокеры \(1\)/);
    assert.match(report, /calc\.test\.mjs:4/);
  });

  it('Scenario: Given the scout returns empty, When the slop orchestrator synthesizes, Then it emits VERDICT: ERROR and never CLEAN', async () => {
    // Given
    const { calls, dispatch } = createFakeSlopDispatch({
      scoutResult: null,
      verifierResult: { verified: [], rejectedCount: 0, verdict: 'CLEAN', verdictReason: 'unused' },
    });

    // When
    const report = await runSlopOrchestration(dispatch);

    // Then
    assert.equal(calls.length, 1, 'verifier must not run when the scout failed');
    assert.match(report, /^VERDICT: ERROR — slop-scout failed/);
    assert.match(report, /NOT a clean result/);
    assert.doesNotMatch(report, /VERDICT: CLEAN/);
  });

  it('Scenario: Given the verifier fails after candidates, When the slop orchestrator synthesizes, Then it emits VERDICT: ERROR naming the unverified count', async () => {
    // Given
    const { dispatch } = createFakeSlopDispatch({
      scoutResult: {
        candidates: [
          { file: 'src/x.mjs', line: '1', claim: 'c', suspectedCategory: 'P2_PARASITIC_OR_SLOP', evidence: 'e' },
          { file: 'src/y.mjs', line: '2', claim: 'c2', suspectedCategory: 'P3_DRIFT', evidence: 'e2' },
        ],
        summary: 'two candidates',
      },
      verifierResult: null,
    });

    // When
    const report = await runSlopOrchestration(dispatch);

    // Then
    assert.match(report, /^VERDICT: ERROR — slop-verifier failed; 2 candidate finding\(s\) left unverified/);
    assert.doesNotMatch(report, /VERDICT: CLEAN/);
  });
});
