// Given/When/Then over the maintainability part of the verdict. Pure: constructed native results,
// no OMP, no model, no Git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAINTAINABILITY_AGENT, evaluateReview, maintainabilityBlocks } from '../src/native/verdict.mjs';

const reviewerPass = () => ({ exitCode: 0, aborted: false, yieldStatus: 'success', text: '## Review\n\nREVIEW_RESULT=PASS' });
const completed = (agent, data) => ({ agent, exitCode: 0, aborted: false, structuredStatus: 'valid', data });
const baseStages = () => [
  completed('review-context-scout', { test_harness: 'present' }),
  completed('review-risk-hunter', { lane: 'correctness' }),
  completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
];
const evaluate = ({ stages = baseStages(), maintainability = { policy: 'block', status: 'analyzed', coverage: 'full', planned: true }, planned = [] } = {}) => evaluateReview({
  reviewer: reviewerPass(),
  stages,
  profile: 'full',
  lanes: ['correctness'],
  maintainability,
  planned,
});

const candidate = (fields = {}) => ({
  candidate_id: 'maintainability-1',
  group_id: 'g1',
  params: ['sessionId', 'runRoot', 'attemptId'],
  decision: 'confirmed',
  meaning: 'one run context',
  coordinated_change: 'rename attemptId to attemptKey',
  forwarding_only: false,
  stated_cost: 'attemptId is renamed in five callers and the definition',
  priority: 'P2',
  counterargument: 'these names are a framework signature',
  counterargument_evidence: ['src/a.mjs:1'],
  impact: 'every rename touches five files by hand',
  evidence: ['src/a.mjs:1'],
  triage_ground: 'stated-cost',
  ...fields,
});

const withCandidates = (...candidates) => [...baseStages(), completed(MAINTAINABILITY_AGENT, { candidates })];

test('Given a confirmed candidate with a stated cost and P2 under block, When evaluated, Then the PASS is rejected', () => {
  const verdict = evaluate({ stages: withCandidates(candidate()) });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.verdict, 'BLOCK');
  assert.match(verdict.reasons.join(' '), /review-maintainability confirmed 1 maintainability item/);
});

test('Given a confirmed candidate without a stated cost, When evaluated, Then the PASS stands', () => {
  assert.deepEqual(evaluate({ stages: withCandidates(candidate({ stated_cost: '' })) }).reasons, []);
});

test('Given a confirmed candidate with priority P1, When evaluated, Then the PASS stands', () => {
  assert.deepEqual(evaluate({ stages: withCandidates(candidate({ priority: 'P1' })) }).reasons, []);
});

test('Given a candidate that only forwards the group, When evaluated, Then the PASS stands', () => {
  assert.deepEqual(evaluate({ stages: withCandidates(candidate({ forwarding_only: true })) }).reasons, []);
});

test('Given the advisory policy, When evaluated, Then a blocking candidate never changes the verdict', () => {
  const verdict = evaluate({
    stages: withCandidates(candidate()),
    maintainability: { policy: 'advisory', status: 'analyzed', coverage: 'full', planned: true },
  });
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.verdict, 'PASS');
});

test('Given a failed analysis, When evaluated, Then the review blocks and names the analysis', () => {
  const verdict = evaluate({ maintainability: { policy: 'block', status: 'failed', coverage: 'partial', planned: false } });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /maintainability analysis failed/);
});

test('Given a planned stage that produced no completed result, When evaluated, Then the PASS is rejected even though the report claims success', () => {
  const verdict = evaluate();
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /no completed stage evidence for review-maintainability/);
});

test('Given an analysis without candidates, When evaluated, Then the stage is not required', () => {
  const verdict = evaluate({ maintainability: { policy: 'block', status: 'no-candidates', coverage: 'full', planned: false } });
  assert.deepEqual(verdict.reasons, []);
});

test('Given a maintainability stage with an invalid structured result, When evaluated, Then it is not evidence and the review blocks', () => {
  const stages = [...baseStages(), { agent: MAINTAINABILITY_AGENT, exitCode: 0, aborted: false, structuredStatus: 'invalid', data: { candidates: [] } }];
  const verdict = evaluate({ stages });
  assert.match(verdict.reasons.join(' '), /no completed stage evidence for review-maintainability/);
});

test('Given maintainability candidates, When evaluated, Then they are not read from confirmed findings or coverage gaps', () => {
  const verdict = evaluate({
    stages: withCandidates(candidate()),
    maintainability: { policy: 'advisory', status: 'analyzed', coverage: 'partial', planned: true },
  });
  assert.equal(verdict.pass, true);
  assert.doesNotMatch(verdict.reasons.join(' '), /verifier confirmed/);
});

test('Given an extra planned agent that never ran, When evaluated, Then the review blocks and names it', () => {
  const verdict = evaluate({
    maintainability: { policy: 'off', status: 'not-run', coverage: null, planned: false },
    planned: ['review-maintainability'],
  });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /planned agent\(s\): review-maintainability/);
});

test('Given the four blocking fields, When the predicate runs, Then each missing field alone is enough to keep the commit', () => {
  assert.equal(maintainabilityBlocks(candidate()), true);
  assert.equal(maintainabilityBlocks(candidate({ decision: 'not_proven' })), false);
  assert.equal(maintainabilityBlocks(candidate({ stated_cost: '   ' })), false);
  assert.equal(maintainabilityBlocks(candidate({ priority: 'P1' })), false);
  assert.equal(maintainabilityBlocks(candidate({ forwarding_only: true })), false);
  assert.equal(maintainabilityBlocks(null), false);
});
