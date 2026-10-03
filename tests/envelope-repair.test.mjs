import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runReview } from '../src/index.mjs';
import { ReviewPrompt } from '../src/domain/review-prompt.mjs';

const DIFF_TEXT = 'envelope repair diff content';
const DIFF_HASH = createHash('sha256').update(DIFF_TEXT).digest('hex');

const fakeGit = (repoRoot) => (args) => {
  if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
  if (args[0] === 'diff') return Buffer.from(DIFF_TEXT);
  return Buffer.alloc(0);
};

const telemetryCapture = () => {
  const events = [];
  return {
    events,
    port: { forRun: () => ({ record: async (type, payload) => { events.push({ type, ...payload }); }, updateLastRun: async () => {} }) },
  };
};

const runner = ({ review, reemit }) => {
  const calls = [];
  const fn = async (prompt, cwd, timeoutMs, options = {}) => {
    calls.push({ prompt: String(prompt), noTools: options.noTools === true });
    return calls.length === 1 ? review : reemit;
  };
  return { calls, fn };
};

const validEnvelope = () => JSON.stringify({
  schema: 'review-rejection-envelope@1',
  kind: 'confirmed_findings',
  diff_hash: DIFF_HASH,
  findings: [{
    finding_id: 'correctness-1', priority: 'P2', severity: 'P2', defect_class: 'correctness', category_kind: 'finding',
    blocking: true, source: 'correctness', file_path: 'src/a.mjs', line_start: 1, line_end: 1,
    verifier_argument: 'proven', counterexample: 'input x yields y',
  }],
  non_coverable_items: [],
});

const withEnvelope = () => ['### Confirmed findings', '- one', '', 'REVIEW_REJECTION_ENVELOPE_BEGIN', validEnvelope(), 'REVIEW_REJECTION_ENVELOPE_END', 'REVIEW_RESULT=BLOCK', ''].join('\n');
const noEnvelope = ['### Confirmed findings', '- P2 src/a.mjs:1 something', '', 'REVIEW_RESULT=BLOCK', ''].join('\n');
const malformed = ['### Confirmed findings', '', 'REVIEW_REJECTION_ENVELOPE_BEGIN', '{not json', 'REVIEW_REJECTION_ENVELOPE_END', 'REVIEW_RESULT=BLOCK', ''].join('\n');
const passOutput = '### Confirmed findings\nNone.\n\nREVIEW_RESULT=PASS\n';

const run = async (omp, extra = {}) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'omp-repair-'));
  return runReview({
    cwd: repoRoot,
    git: fakeGit(repoRoot),
    logger: { log: () => {}, error: () => {} },
    now: new Date('2026-09-15T10:00:00.000Z'),
    omp,
    ...extra,
  });
};

describe('Feature: BLOCK envelope repair via one verbatim re-emit', () => {
  for (const [label, output] of [['missing envelope', noEnvelope], ['malformed envelope', malformed]]) {
    it(`Given a BLOCK with ${label}, When the re-emit returns a valid envelope, Then the BLOCK carries the repaired confirmed_findings envelope after exactly one re-emit`, async () => {
      const telemetry = telemetryCapture();
      const { calls, fn } = runner({ review: { status: 0, stdout: output, stderr: '' }, reemit: { status: 0, stdout: withEnvelope(), stderr: '' } });

      const result = await run(fn, { telemetry: telemetry.port });

      assert.equal(result.exitCode, 1);
      assert.equal(result.envelope.kind, 'confirmed_findings');
      assert.equal(result.envelope.findings.length, 1);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].noTools, true);
      assert.match(calls[1].prompt, /must stay BLOCK/);
      const recovery = telemetry.events.find((event) => event.type === 'reemit_recovery');
      assert.equal(recovery.mode, 'envelope_repair');
      assert.equal(recovery.recovered, true);
    });
  }

  it('Given a BLOCK without envelope, When the re-emit flips it to PASS, Then the original BLOCK stands (a repair can never downgrade)', async () => {
    const telemetry = telemetryCapture();
    const { calls, fn } = runner({ review: { status: 0, stdout: noEnvelope, stderr: '' }, reemit: { status: 0, stdout: passOutput, stderr: '' } });

    const result = await run(fn, { telemetry: telemetry.port });

    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(result.envelope.kind, 'review_failure');
    assert.equal(result.envelope.failure.code, 'missing_rejection_envelope');
    assert.equal(calls.length, 2);
    assert.equal(telemetry.events.find((event) => event.type === 'reemit_recovery').recovered, false);
  });

  it('Given a BLOCK without envelope, When the re-emit again lacks a valid envelope or fails, Then the original failure is kept and only one re-emit runs', async () => {
    for (const reemit of [{ status: 0, stdout: noEnvelope, stderr: '' }, { status: 1, stdout: '', stderr: 'boom' }]) {
      const { calls, fn } = runner({ review: { status: 0, stdout: noEnvelope, stderr: '' }, reemit });
      const result = await run(fn);
      assert.equal(result.exitCode, 1);
      assert.equal(result.envelope.failure.code, 'missing_rejection_envelope');
      assert.equal(calls.length, 2);
    }
  });

  it('Given a malformed envelope, When the re-emit has no envelope at all, Then the original malformed_rejection_envelope failure is kept, not replaced', async () => {
    const { fn } = runner({ review: { status: 0, stdout: malformed, stderr: '' }, reemit: { status: 0, stdout: noEnvelope, stderr: '' } });
    const result = await run(fn);
    assert.equal(result.envelope.failure.code, 'malformed_rejection_envelope');
  });

  it('Given a clean BLOCK with a valid envelope, Then no re-emit is attempted', async () => {
    const { calls, fn } = runner({ review: { status: 0, stdout: withEnvelope(), stderr: '' }, reemit: { status: 0, stdout: passOutput, stderr: '' } });
    const result = await run(fn);
    assert.equal(result.exitCode, 1);
    assert.equal(result.envelope.kind, 'confirmed_findings');
    assert.equal(calls.length, 1);
  });

  it('Given OMP_REVIEW_KIT_REEMIT=0, Then a missing envelope is not repaired', async () => {
    const previous = process.env.OMP_REVIEW_KIT_REEMIT;
    process.env.OMP_REVIEW_KIT_REEMIT = '0';
    try {
      const { calls, fn } = runner({ review: { status: 0, stdout: noEnvelope, stderr: '' }, reemit: { status: 0, stdout: withEnvelope(), stderr: '' } });
      const result = await run(fn);
      assert.equal(calls.length, 1);
      assert.equal(result.envelope.failure.code, 'missing_rejection_envelope');
    } finally {
      if (previous === undefined) delete process.env.OMP_REVIEW_KIT_REEMIT;
      else process.env.OMP_REVIEW_KIT_REEMIT = previous;
    }
  });

  it('forReemit adds the repair instruction only when asked', () => {
    assert.doesNotMatch(String(ReviewPrompt.forReemit('x')), /must stay BLOCK/);
    assert.match(String(ReviewPrompt.forReemit('x', { repairEnvelope: true })), /must stay BLOCK/);
  });
});
