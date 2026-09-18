import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { runReview } from '../src/index.mjs';

const TEST_ROLES = { smol: 'acme/smol-flash:high', task: 'acme/task-fast:high', slow: 'acme/slow-max:max' };
const testRoleResolver = () => TEST_ROLES;
const DIFF_TEXT = 'reemit recovery diff content';
const DIFF_HASH = createHash('sha256').update(DIFF_TEXT).digest('hex');

/**
 * Creates an isolated mock repository directory.
 */
async function createTempRepo() {
  return await mkdtemp(path.join(tmpdir(), 'omp-reemit-'));
}

function createFakeGit(repoRoot, diffText = DIFF_TEXT) {
  return (args) => {
    if (args[0] === 'rev-parse') {
      return Buffer.from(`${repoRoot}\n`);
    }
    if (args[0] === 'diff') {
      return Buffer.from(diffText);
    }
    return Buffer.alloc(0);
  };
}

function createSilentLogger() {
  return { log: () => {}, error: () => {} };
}

function createTelemetryCapture() {
  const events = [];
  return {
    events,
    port: {
      forRun: () => ({
        record: async (type, payload) => {
          events.push({ type, ...payload });
        },
        updateLastRun: async () => {},
      }),
    },
  };
}

/**
 * Fake OMP runner: the first call is the full review attempt, every later
 * call is the verbatim re-emit re-prompt. Records noTools/timeout/model.
 */
function createRunner({ review, reemit }) {
  const calls = [];
  const runner = async (prompt, cwd, timeoutMs, model, options = {}) => {
    const call = { prompt, timeoutMs, model, noTools: options.noTools === true };
    calls.push(call);
    if (calls.length === 1) {
      call.kind = 'review';
      return typeof review === 'function' ? review(call) : review;
    }
    call.kind = 'reemit';
    return typeof reemit === 'function' ? reemit(call) : reemit;
  };
  return { calls, runner };
}

/**
 * Minimal excerpt of the real wrapped-PASS output observed in
 * audit-reports/commit-reviews/2026-09-14T15-10-33-702Z-*.md: the reviewer
 * JSON-encoded its whole report into one line and never emitted a marker.
 */
const WRAPPED_PASS_OUTPUT = JSON.stringify({
  verdict: 'PASS',
  report: '### Review coverage\n- **Diff Hash**: `7ddc044373634c2f4fa4c704692977ffbe3f039db0befc8d200652129f649910`\n- **Active Skills Consulted**:\n  - `skill://reality-first-review`\n  - `skill://multi-stage-review`\n- **Pipeline Stages Executed**:\n  1. `review-context-scout`: mapped change goal and invariants.\n  2. `review-risk-hunter`: ran correctness and security lanes.\n\n### Confirmed findings\nNone.\n\n### Verified-OK\n- Staged snapshot isolation preserved.\n\n### Verdict\nPASS',
});

/**
 * Minimal excerpt of the real VERDICT-vocabulary output observed in
 * audit-reports/commit-reviews/2026-09-13T21-34-47-961Z-*.md: a complete
 * markdown report that ends with an invented verdict vocabulary.
 */
const VERDICT_VOCABULARY_OUTPUT = [
  '### Review coverage',
  '- **Diff inspected**: 6bfe02bb4338d4d8dcc86290af088be9dd6f1a7cdd222655c60e6c053283de32',
  '- **Active review skills**:',
  '  - `skill://reality-first-review`',
  '  - `skill://multi-stage-review`',
  '',
  '### Confirmed findings',
  'None.',
  '',
  '### Verdict',
  'VERDICT=PASS',
  'SEVERITY_CEILING=NONE',
  'CONFIRMED_COUNT=0',
  'REJECTED_COUNT=0',
  '',
].join('\n');

const REEMITTED_PASS_REPORT = [
  '### Review coverage',
  '- **Diff Hash**: `7ddc044373634c2f4fa4c704692977ffbe3f039db0befc8d200652129f649910`',
  '- **Pipeline Stages Executed**:',
  '  1. `review-context-scout`: mapped change goal and invariants.',
  '  2. `review-risk-hunter`: ran correctness and security lanes.',
  '',
  '### Confirmed findings',
  'None.',
  '',
  '### Verdict',
  'REVIEW_RESULT=PASS',
  '',
].join('\n');

function envelopeBlockOutput(diffText, { kind = 'confirmed_findings' } = {}) {
  const diffHash = createHash('sha256').update(diffText).digest('hex');
  const value = {
    schema: 'review-rejection-envelope@1',
    kind,
    diff_hash: diffHash,
    findings: [
      {
        finding_id: 'correctness-1',
        priority: 'P2',
        defect_class: 'correctness',
        file_path: 'src/example.mjs',
        line_start: 1,
        line_end: 1,
        verifier_argument: 'The repository already provides the same responsibility.',
        counterexample: 'The staged wrapper only calls the existing mechanism.',
      },
    ],
  };
  return [
    '### Review coverage',
    '- one confirmed defect',
    '',
    'REVIEW_REJECTION_ENVELOPE_BEGIN',
    JSON.stringify(value),
    'REVIEW_REJECTION_ENVELOPE_END',
    'REVIEW_RESULT=BLOCK',
    '',
  ].join('\n');
}

async function runWithCleanup(repoRoot, options) {
  return await runReview({
    cwd: repoRoot,
    git: createFakeGit(repoRoot),
    ompOptions: { roleResolver: testRoleResolver },
    logger: createSilentLogger(),
    now: new Date('2026-09-15T10:00:00.000Z'),
    ...options,
  });
}

describe('Feature: Verbatim Re-emit Recovery (missing verdict marker)', () => {
  it('S1: Given a JSON-wrapped PASS report, When re-emit reproduces it verbatim, Then the commit passes and the report keeps its sections', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const telemetry = createTelemetryCapture();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: WRAPPED_PASS_OUTPUT + '\n', stderr: '' },
      reemit: { status: 0, stdout: REEMITTED_PASS_REPORT, stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner, telemetry: telemetry.port });

    // Then
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, 'PASS');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].kind, 'reemit');
    assert.match(calls[1].prompt, /---ORIGINAL OUTPUT---\n/);
    assert.ok(calls[1].prompt.includes(WRAPPED_PASS_OUTPUT));
    const recovery = telemetry.events.find((event) => event.type === 'reemit_recovery');
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.originalBytes, Buffer.byteLength(`${WRAPPED_PASS_OUTPUT}\n\n`));
    const reportContent = await readFile(result.reportPath, 'utf8');
    assert.match(reportContent, /result: PASS/);
    assert.match(reportContent, /### Review coverage/);
    assert.match(reportContent, /### Confirmed findings/);
    assert.match(reportContent, /REVIEW_RESULT=PASS/);
  });

  it('S2: Given a JSON-wrapped BLOCK report, When re-emit reproduces it verbatim, Then the commit blocks with confirmed findings', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const wrappedBlock = JSON.stringify({
      verdict: 'BLOCK',
      report: envelopeBlockOutput(DIFF_TEXT).replace(/\n/g, '\\n'),
    });
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: wrappedBlock + '\n', stderr: '' },
      reemit: { status: 0, stdout: envelopeBlockOutput(DIFF_TEXT), stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 2);
    assert.equal(result.envelope.kind, 'confirmed_findings');
    assert.equal(result.envelope.findings.length, 1);
    assert.equal(result.envelope.findings[0].finding_id, 'correctness-1');
    assert.equal(result.envelope.diff_hash, DIFF_HASH);
  });

  it('S3: Given a bare verdict JSON blob, When re-emit returns the same markerless output, Then the commit blocks with missing_verdict_marker after exactly one re-emit', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const bare = '{"verdict":"PASS"}';
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: bare, stderr: '' },
      reemit: { status: 0, stdout: bare, stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.filter((call) => call.kind === 'reemit').length, 1);
    assert.equal(result.envelope.kind, 'review_failure');
    assert.equal(result.envelope.failure.code, 'missing_verdict_marker');
  });

  it('S4: Given a markerless output, When the re-emit runner times out, Then the commit blocks with the original reason preserved', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: WRAPPED_PASS_OUTPUT + '\n', stderr: '' },
      reemit: { status: 1, stdout: '', stderr: 'Review timed out after 60000ms\n' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 2);
    assert.equal(result.envelope.kind, 'review_failure');
    assert.equal(result.envelope.failure.code, 'missing_verdict_marker');
  });

  it('S5: Given a report using invented VERDICT=PASS vocabulary, When re-emit normalizes the marker, Then the commit passes', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: VERDICT_VOCABULARY_OUTPUT, stderr: '' },
      reemit: {
        status: 0,
        // The re-emitted report keeps the invented vocabulary verbatim and
        // appends the canonical marker as the last non-empty line, per the
        // verdict contract.
        stdout: VERDICT_VOCABULARY_OUTPUT + 'REVIEW_RESULT=PASS\n',
        stderr: '',
      },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, 'PASS');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].kind, 'reemit');
  });

  it('S10: Given a markerless output, When re-emit runs, Then the runner is invoked with the no-tools flag and the probe-timeout budget', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: WRAPPED_PASS_OUTPUT + '\n', stderr: '' },
      reemit: { status: 0, stdout: REEMITTED_PASS_REPORT, stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].noTools, false);
    assert.equal(calls[1].noTools, true);
    assert.equal(calls[1].timeoutMs, 60_000);
    assert.equal(calls[1].model, calls[0].model);
  });

  it('E1: Given an empty reviewer output, When the review executes, Then no re-emit is attempted', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: '', stderr: '' },
      reemit: { status: 0, stdout: REEMITTED_PASS_REPORT, stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 1);
  });

  it('E2: Given a whitespace-only reviewer output, When the review executes, Then no re-emit is attempted', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: '   \n\t\n  ', stderr: '' },
      reemit: { status: 0, stdout: REEMITTED_PASS_REPORT, stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 1);
  });

  it('E5: Given a wrapped PASS, When re-emit returns a BLOCK envelope, Then the re-emitted output is authoritative and the commit blocks', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: WRAPPED_PASS_OUTPUT + '\n', stderr: '' },
      reemit: { status: 0, stdout: envelopeBlockOutput(DIFF_TEXT), stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 2);
    assert.equal(result.envelope.kind, 'confirmed_findings');
    assert.equal(result.envelope.findings.length, 1);
  });

  it('E6: Given a markerless output, When re-emit returns two verdict markers, Then the commit blocks with multiple_verdict_markers', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: WRAPPED_PASS_OUTPUT + '\n', stderr: '' },
      reemit: { status: 0, stdout: 'REVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK\n', stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 2);
    assert.equal(result.envelope.kind, 'review_failure');
    assert.equal(result.envelope.failure.code, 'multiple_verdict_markers');
  });

  it('E7: Given a non-zero reviewer exit, When the review executes, Then no re-emit is attempted', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const { calls, runner } = createRunner({
      review: { status: 1, stdout: 'partial output without marker', stderr: 'reviewer crashed' },
      reemit: { status: 0, stdout: REEMITTED_PASS_REPORT, stderr: '' },
    });

    // When
    const result = await runWithCleanup(repoRoot, { omp: runner });

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(calls.length, 1);
  });

  it('E8: Given OMP_REVIEW_KIT_REEMIT=0, When the reviewer output lacks a marker, Then no re-emit is attempted', async () => {
    // Given
    const repoRoot = await createTempRepo();
    const previous = process.env.OMP_REVIEW_KIT_REEMIT;
    process.env.OMP_REVIEW_KIT_REEMIT = '0';
    const { calls, runner } = createRunner({
      review: { status: 0, stdout: WRAPPED_PASS_OUTPUT + '\n', stderr: '' },
      reemit: { status: 0, stdout: REEMITTED_PASS_REPORT, stderr: '' },
    });

    try {
      // When
      const result = await runWithCleanup(repoRoot, { omp: runner });

      // Then
      assert.equal(result.exitCode, 1);
      assert.equal(result.verdict, 'BLOCK');
      assert.equal(calls.length, 1);
      assert.equal(result.envelope.failure.code, 'missing_verdict_marker');
    } finally {
      if (previous === undefined) delete process.env.OMP_REVIEW_KIT_REEMIT;
      else process.env.OMP_REVIEW_KIT_REEMIT = previous;
    }
  });
});
