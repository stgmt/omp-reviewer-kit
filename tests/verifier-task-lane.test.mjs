import assert from 'node:assert/strict';
import test from 'node:test';

import * as source from '../src/domain/review-batch.mjs';
import * as bundled from '../scripts/run-review.mjs';

const verifierData = { coverage_summary: 'checked', decisions: [], confirmed_findings: [], confirmed_coverage_gaps: [], rejected_coverage_gaps: [] };
const hunterData = (lane) => ({ coverage_summary: 'checked', candidates: lane ? [{ candidate_id: 'c1', lane }] : [], coverage_gaps: [], suppressed_coverage_items: [] });
const batch = (name, agent, task, data) => ({
  input: { tasks: [{ name, agent, task }] },
  details: { results: [{ id: name, agent, exitCode: 0, structuredOutput: { status: 'valid', data } }] },
});

for (const [label, domain] of [['source', source], ['bundle', bundled]]) {
  test(`${label}: Given a verifier task that quotes a lane, When its result is validated, Then the lane belongs to the hunters and the verifier passes`, () => {
    for (const task of ['Verify candidate c1 (lane: "correctness") against the snapshot', 'lane: "security" lane: "content-risk"']) {
      const { input, details } = batch('Verifier', 'review-finding-verifier', task, verifierData);
      assert.doesNotThrow(() => domain.validateBatchResults(input, details));
      const { failures, valid } = domain.validateBatchTasks(input, details);
      assert.deepEqual(failures, []);
      assert.deepEqual([...valid.keys()], ['Verifier']);
    }
  });

  test(`${label}: Given a hunter task for one lane, When a candidate names another lane, Then the result is refused as belonging to another lane`, () => {
    const task = 'Hunt defects. lane: "correctness"';
    const wrong = batch('Hunter-correctness', 'review-risk-hunter', task, hunterData('security'));
    assert.throws(() => domain.validateBatchResults(wrong.input, wrong.details), /Hunter result belongs to another lane/);
    const { failures } = domain.validateBatchTasks(wrong.input, wrong.details);
    assert.deepEqual(failures.map((item) => [item.task, item.reason]), [['Hunter-correctness', 'Hunter result belongs to another lane']]);
  });

  test(`${label}: Given hunter results of the lane they were asked for, When validated, Then they pass, with or without candidates`, () => {
    for (const data of [hunterData('correctness'), hunterData(null)]) {
      const { input, details } = batch('Hunter-correctness', 'review-risk-hunter', 'Hunt defects. lane: "correctness"', data);
      assert.doesNotThrow(() => domain.validateBatchResults(input, details));
    }
  });
}
