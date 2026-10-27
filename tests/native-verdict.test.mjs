// Given/When/Then over the native verdict rule. Pure: no OMP, no model, no Git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReview, readVerdictMarker } from '../src/native/verdict.mjs';

const done = (agent, data = {}) => ({
  agent,
  exitCode: 0,
  aborted: false,
  structuredStatus: 'valid',
  data,
  role: 'task',
  model: 'resolved-by-omp',
});
const reviewerPass = text => ({ exitCode: 0, aborted: false, yieldStatus: 'success', text });
const FULL = { profile: 'full', lanes: ['correctness'] };
const everyStage = [
  done('review-context-scout', { test_harness: 'present' }),
  done('review-risk-hunter', { lane: 'correctness' }),
  done('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
];

test('Given one PASS marker as the last line and every stage completed, When evaluated, Then the review passes', () => {
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'), stages: everyStage, ...FULL });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.reasons, []);
});

test('Given a BLOCK marker, When evaluated, Then the review blocks with the reviewer verdict as the reason', () => {
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=BLOCK'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK']);
});

test('Given PASS and BLOCK markers together, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer verdict markers: 2/);
});

test('Given a PASS marker and a verifier that omits its confirmed lists, When evaluated, Then the review passes without reading a missing list', () => {
  const stages = [everyStage[0], everyStage[1], done('review-finding-verifier', {})];
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given two PASS markers, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS\nREVIEW_RESULT=PASS'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
});

test('Given a PASS marker inside a sentence, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('I would say REVIEW_RESULT=PASS here'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
});

test('Given a PASS marker that is not the last line, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS\n\nTrailing prose'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /not the last line/);
});

test('Given a marker with trailing punctuation, When read, Then it is not a verdict', () => {
  assert.deepEqual(readVerdictMarker('REVIEW_RESULT=PASS.'), { verdict: null, reason: 'reviewer verdict marker is not PASS or BLOCK' });
});

test('Given the scout never completed, When evaluated, Then it blocks and names the scout', () => {
  const stages = everyStage.filter(stage => stage.agent !== 'review-context-scout');
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /review-context-scout/);
});

test('Given the scout exits 1 with otherwise valid output, When evaluated, Then the scout is not evidence and the review blocks naming it', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-context-scout' ? { ...stage, exitCode: 1 } : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed stage evidence for review-context-scout/);
});

test('Given the only correctness hunter exits 1, When evaluated, Then its lane is missing and the review blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-risk-hunter' ? { ...stage, exitCode: 1 } : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed review-risk-hunter task for planned lane\(s\): correctness/);
});

test('Given the only correctness hunter has no exit code, When evaluated, Then its lane is missing and the review blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-risk-hunter' ? { ...stage, exitCode: null } : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /planned lane\(s\): correctness/);
});

test('Given a planned lane with no completed hunter, When evaluated, Then it blocks and names the lane', () => {
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=PASS'),
    stages: everyStage,
    profile: 'full',
    lanes: ['correctness', 'security'],
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed review-risk-hunter task for planned lane\(s\): security/);
});

test('Given two correctness hunters and no security hunter under the correctness and security lanes, When evaluated, Then it blocks and names the security lane', () => {
  const stages = [
    ...everyStage.filter(stage => stage.agent !== 'review-risk-hunter'),
    done('review-risk-hunter', { lane: 'correctness' }),
    done('review-risk-hunter', { lane: 'correctness' }),
  ];
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, profile: 'full', lanes: ['correctness', 'security'] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /planned lane\(s\): security/);
});

test('Given a full profile with no completed verifier, When evaluated, Then it blocks', () => {
  const stages = everyStage.filter(stage => stage.agent !== 'review-finding-verifier');
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /review-finding-verifier/);
});

test('Given a spec-docs profile with no verifier, When evaluated, Then the verifier is not required', () => {
  const stages = [done('review-context-scout', { test_harness: 'absent' }), done('review-risk-hunter', { lane: 'content-risk' })];
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, profile: 'spec-docs', lanes: ['content-risk'] });
  assert.equal(result.pass, true);
});

test('Given a stage that aborted, When evaluated, Then it is not evidence', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-finding-verifier' ? { ...stage, aborted: true } : stage));
  assert.equal(evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL }).pass, false);
});

test('Given a stage with an invalid structured result, When evaluated, Then it is not evidence', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-risk-hunter' ? { ...stage, structuredStatus: 'invalid' } : stage));
  assert.equal(evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL }).pass, false);
});

test('Given the reviewer task exited non-zero with a PASS marker, When evaluated, Then it blocks with the exit reason', () => {
  const reviewer = { ...reviewerPass('REVIEW_RESULT=PASS'), exitCode: 1 };
  const result = evaluateReview({ reviewer, stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer task exit 1/);
});

test('Given the reviewer aborted, When evaluated, Then it blocks even with a PASS marker', () => {
  const reviewer = { ...reviewerPass('REVIEW_RESULT=PASS'), aborted: true };
  assert.equal(evaluateReview({ reviewer, stages: everyStage, ...FULL }).pass, false);
});

test('Given the reviewer never yielded, When evaluated, Then it blocks with the yield reason', () => {
  const reviewer = { ...reviewerPass('REVIEW_RESULT=PASS'), yieldStatus: null };
  const result = evaluateReview({ reviewer, stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer yield missing/);
});

test('Given no reviewer result, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: undefined, stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer task result missing/);
});

test('Given a PASS that stands against a confirmed finding, When evaluated, Then it blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-finding-verifier'
    ? { ...stage, data: { confirmed_findings: [{ id: 'correctness-1' }], confirmed_coverage_gaps: [] } }
    : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /verifier confirmed 1 finding/);
});

test('Given a PASS that stands against a confirmed gap while a test harness exists, When evaluated, Then it blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-finding-verifier'
    ? { ...stage, data: { confirmed_findings: [], confirmed_coverage_gaps: [{ id: 'coverage-1' }] } }
    : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /coverage gap/);
});

const withGap = gap => everyStage.map(stage => (stage.agent === 'review-finding-verifier'
  ? { ...stage, data: { confirmed_findings: [], confirmed_coverage_gaps: [gap] } }
  : stage));

test('Given a blocking gap with a concrete impact, When evaluated, Then the PASS is rejected', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'blocking', impact: 'a caller writes to the wrong account' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /blocking coverage gap/);
});

test('Given a blocking gap without a concrete impact, When evaluated, Then the impact floor keeps the PASS', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'blocking', impact: '   ' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given an advisory gap, When evaluated, Then it never blocks the PASS', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'advisory', impact: 'presentation text only' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given a blocking gap whose own per-entry harness is absent, When evaluated, Then it never blocks the PASS', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'blocking', impact: 'a caller writes to the wrong account', test_harness: 'absent' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
});

test('Given a blocking gap in a test-class file from the manifest, When evaluated, Then the test-class exemption keeps the PASS', () => {
  const gap = { coverage_id: 'coverage-1', file_path: 'tests/feature.test.mjs', severity: 'blocking', impact: 'a helper returns the wrong fixture' };
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=PASS'),
    stages: withGap(gap),
    fileClasses: [{ path: 'tests/feature.test.mjs', fileClass: 'test' }],
    ...FULL,
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given a blocking gap that declares its own test file class, When evaluated, Then the test-class exemption keeps the PASS', () => {
  const gap = { coverage_id: 'coverage-1', file_path: 'feature.test.mjs', file_class: 'test', severity: 'blocking', impact: 'a helper returns the wrong fixture' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
});

test('Given a blocking gap in an executable file, When evaluated with the manifest, Then the PASS remains blocked', () => {
  const gap = { coverage_id: 'coverage-1', file_path: 'src/feature.mjs', severity: 'blocking', impact: 'a caller writes to the wrong account' };
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=PASS'),
    stages: withGap(gap),
    fileClasses: [{ path: 'src/feature.mjs', fileClass: 'executable' }],
    ...FULL,
  });
  assert.equal(result.pass, false);
});

test('Given a confirmed gap while the scout reports no test harness, When evaluated, Then the PASS stands', () => {
  const stages = everyStage.map(stage => {
    if (stage.agent === 'review-finding-verifier') return { ...stage, data: { confirmed_findings: [], confirmed_coverage_gaps: [{ id: 'coverage-1' }] } };
    if (stage.agent === 'review-context-scout') return { ...stage, data: { test_harness: 'absent' } };
    return stage;
  });
  assert.equal(evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL }).pass, true);
});
