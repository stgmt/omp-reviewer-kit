// Given/When/Then over the contract part of the verdict. Pure: constructed native results, no OMP,
// no model, no Git, no child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReview } from '../src/native/verdict.mjs';
import { completed, reviewerPass } from './support/stage-fixtures.mjs';

const stages = () => [
  completed('review-context-scout', { test_harness: 'present' }),
  completed('review-risk-hunter', { lane: 'correctness' }),
  completed('review-maintainability', { candidates: [], status: 'completed' }),
  completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
];

const evaluate = (contract) => evaluateReview({
  reviewer: reviewerPass(),
  stages: stages(),
  profile: 'full',
  lanes: ['correctness'],
  maintainability: { policy: 'block', status: 'analyzed', coverage: 'full', planned: true },
  planned: ['review-maintainability'],
  contract,
});

const rejection = {
  file: 'src/ledger.mjs',
  writer: 'writeRecord',
  reader: 'readRecord',
  error: 'Error: ledger: service must be a name',
  record: '{"service":null}',
};

test('Given a reader that rejects the record its own writer produces, When the verdict is made, Then a passing reviewer cannot rescue the commit', () => {
  const verdict = evaluate({ policy: 'block', status: 'contract-violated', rejected: [rejection], probed: 1, note: '1 pair(s) write a record their own reader rejects.' });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join('\n'), /contract violated: src\/ledger\.mjs writeRecord produces a record readRecord rejects/);
});

test('Given the same violation under the advisory policy, When the verdict is made, Then it is reported and does not block', () => {
  const verdict = evaluate({ policy: 'advisory', status: 'contract-violated', rejected: [rejection], probed: 1, note: 'violated' });
  assert.equal(verdict.pass, true);
  assert.doesNotMatch(verdict.reasons.join('\n'), /contract violated/);
});

test('Given pairs that all round-tripped, When the verdict is made, Then the stage adds no reason', () => {
  const verdict = evaluate({ policy: 'block', status: 'ok', rejected: [], probed: 3, note: '3 pair(s) round-tripped' });
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.reasons, []);
});

test('Given the stage could not run, When the verdict is made, Then it blocks as an infrastructure failure rather than passing silently', () => {
  const verdict = evaluate({ policy: 'block', status: 'failed', rejected: [], probed: 0, note: 'the probe answer was not JSON' });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join('\n'), /contract analysis failed: the probe answer was not JSON/);
});

test('Given no producer/consumer pair in the diff, When the verdict is made, Then nothing is claimed either way', () => {
  const verdict = evaluate({ policy: 'block', status: 'no-pairs', rejected: [], probed: 0, note: 'no pair found' });
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.reasons, []);
});
