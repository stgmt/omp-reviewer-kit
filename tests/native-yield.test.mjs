// Given/When/Then over the reviewer's native yield payload. Pure: no OMP, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewerYield, stageEvidence } from '../src/native/task-engine.mjs';
import { evaluateReview } from '../src/native/verdict.mjs';

const yieldOf = data => ({ extractedToolData: { yield: [{ status: 'success', data }] } });
const everyStage = [
  { agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { test_harness: 'absent' } },
  { agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredStatus: 'valid', data: null },
  { agent: 'review-finding-verifier', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { confirmed_findings: [], confirmed_coverage_gaps: [] } },
];

test('Given the yield data is one raw Markdown string, When decoded, Then the string is the report', () => {
  assert.deepEqual(reviewerYield(yieldOf('## Report\n\nREVIEW_RESULT=PASS')), { status: 'success', text: '## Report\n\nREVIEW_RESULT=PASS' });
});

test('Given the yield data is exactly one report string field, When decoded, Then the field is the report', () => {
  assert.deepEqual(reviewerYield(yieldOf({ report: '## Report\n\nREVIEW_RESULT=PASS' })), { status: 'success', text: '## Report\n\nREVIEW_RESULT=PASS' });
});

test('Given the yield data is an object with other fields, When decoded, Then no report is recovered', () => {
  assert.deepEqual(reviewerYield(yieldOf({ report: 'x', verdict: 'PASS' })), { status: 'success', text: null });
});

test('Given the yield data is a number, When decoded, Then no report is recovered', () => {
  assert.equal(reviewerYield(yieldOf(42)).text, null);
});

test('Given no yield was recorded, When decoded, Then there is no yield', () => {
  assert.equal(reviewerYield({ extractedToolData: {} }), undefined);
});

test('Given a yield with no report, When the verdict is evaluated, Then it blocks with the missing-report reason', () => {
  const reviewer = { exitCode: 0, aborted: false, yieldStatus: 'success', text: null };
  const result = evaluateReview({ reviewer, stages: everyStage, profile: 'full', lanes: ['correctness'] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer yield carries no Markdown report/);
});

test('Given the yield data is one field named other than report, When decoded, Then no report is recovered even through the prototype', () => {
  const data = Object.assign(Object.create({ report: 'inherited' }), { verdict: 'PASS' });
  assert.deepEqual(reviewerYield(yieldOf(data)), { status: 'success', text: null });
});

test('Given two yields are recorded, When decoded, Then the last one is the reviewer final report', () => {
  const reviewer = { extractedToolData: { yield: [{ status: 'success', data: '## First draft' }, { status: 'success', data: '## Final report' }] } };
  assert.equal(reviewerYield(reviewer).text, '## Final report');
});

const nestedStage = result => ({ extractedToolData: { task: [{ results: [{ agent: 'review-risk-hunter', exitCode: 0, ...result }] }] } });

test('Given a nested stage with an invalid structured result, When its evidence is read, Then the invalid status is kept', () => {
  assert.equal(stageEvidence(nestedStage({ structuredOutput: { status: 'invalid', data: null } }))[0].structuredStatus, 'invalid');
});

test('Given a nested stage with no structured result, When its evidence is read, Then the structured status is null', () => {
  assert.equal(stageEvidence(nestedStage({}))[0].structuredStatus, null);
});

test('Given a nested stage that aborted, When its evidence is read, Then the aborted flag is kept', () => {
  assert.equal(stageEvidence(nestedStage({ aborted: true }))[0].aborted, true);
});
