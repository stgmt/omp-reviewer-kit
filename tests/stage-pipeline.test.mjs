// The host-driven stage pipeline: order, journal reuse, conditional steps and the evidence map.
// Pure: the runner and the journal are fakes, so no model, no OMP and no disk.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hunterBudget, runStagePipeline } from '../src/native/stage-pipeline.mjs';

const evidence = (agent, data = {}) => ({
  agent,
  lane: data.lane ?? null,
  exitCode: 0,
  aborted: false,
  structuredStatus: 'valid',
  data,
  role: 'task',
  model: 'm',
  durationMs: 1,
  tokens: 1,
  requests: 1,
  contextTokens: 1,
});

function fakeRunner(answers) {
  const calls = [];
  return {
    calls,
    async run(agent, name, task) {
      calls.push({ agent, name, task });
      const answer = answers[agent];
      if (typeof answer === 'function') return { evidence: answer(task) };
      if (answer) return { evidence: answer };
      return { evidence: evidence(agent) };
    },
  };
}

test('Given a plan, When the pipeline runs, Then every step runs in order and its evidence is kept', async () => {
  const runner = fakeRunner({
    'review-context-scout': evidence('review-context-scout', { test_harness: 'present' }),
    'review-risk-hunter': evidence('review-risk-hunter', { lane: 'correctness', candidates: [] }),
  });
  const steps = [
    { id: 'scout', agent: 'review-context-scout', name: 'ContextScout', task: 'SCOUT' },
    { id: 'hunter:correctness', agent: 'review-risk-hunter', name: 'RiskHunter-correctness', task: task => `HUNTER ${task}` },
  ];
  const result = await runStagePipeline({ runner, steps });
  assert.deepEqual(runner.calls.map(call => call.agent), ['review-context-scout', 'review-risk-hunter']);
  assert.equal(result.stages.length, 2);
  assert.equal(result.evidence.get('scout').data.test_harness, 'present');
  assert.equal(result.reused.length, 0);
});

test('Given a journaled stage, When the pipeline reaches it, Then the runner is not called and the entry is reused', async () => {
  const runner = fakeRunner({});
  const stored = {
    schema: 'review-stage@1',
    key: 'k1',
    stageId: 'scout',
    exitCode: 0,
    aborted: false,
    structuredStatus: 'valid',
    evidence: evidence('review-context-scout', { test_harness: 'present' }),
  };
  const written = [];
  const journal = {
    key: 'k1',
    read: async id => (id === 'scout' ? stored : null),
    write: async (id, value) => written.push({ id, value }),
  };
  const result = await runStagePipeline({
    runner,
    steps: [
      { id: 'scout', agent: 'review-context-scout', name: 'ContextScout', task: 'SCOUT' },
      { id: 'hunter:correctness', agent: 'review-risk-hunter', name: 'RiskHunter', task: 'HUNTER' },
    ],
    journal,
  });
  assert.deepEqual(runner.calls.map(call => call.agent), ['review-risk-hunter'], 'the reused stage never runs');
  assert.deepEqual(result.reused, ['scout']);
  assert.deepEqual(written.map(entry => entry.id), ['hunter:correctness'], 'a fresh stage is written at once');
});

test('Given a stale journal entry for another key, When the pipeline reads it, Then the stage runs again', async () => {
  const runner = fakeRunner({});
  const journal = {
    key: 'k2',
    read: async () => ({ schema: 'review-stage@1', key: 'k1', stageId: 'scout', exitCode: 0, aborted: false, structuredStatus: 'valid', evidence: evidence('x') }),
    write: async () => {},
  };
  const result = await runStagePipeline({
    runner,
    steps: [{ id: 'scout', agent: 'review-context-scout', name: 'ContextScout', task: 'SCOUT' }],
    journal,
  });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(result.reused, []);
});

test('Given a step condition that is false, When the pipeline runs, Then the step is skipped and nothing is written', async () => {
  const runner = fakeRunner({});
  const written = [];
  const journal = { key: 'k1', read: async () => null, write: async (id) => written.push(id) };
  const result = await runStagePipeline({
    runner,
    steps: [
      { id: 'scout', agent: 'review-context-scout', name: 'ContextScout', task: 'SCOUT' },
      { id: 'verifier', agent: 'review-finding-verifier', name: 'FindingVerifier', task: 'VERIFY', when: () => false },
    ],
    journal,
  });
  assert.deepEqual(runner.calls.map(call => call.agent), ['review-context-scout']);
  assert.deepEqual(written, ['scout']);
  assert.equal(result.evidence.has('verifier'), false);
});

test('Given a runner that returns no evidence, When the pipeline runs, Then it fails instead of inventing a stage', async () => {
  const runner = { async run() { return {}; } };
  await assert.rejects(
    runStagePipeline({ runner, steps: [{ id: 'scout', agent: 'review-context-scout', name: 'ContextScout', task: 'SCOUT' }] }),
    /stage scout produced no evidence/,
  );
});

test('Given the scout output, When the hunter budget is chosen, Then a small diff and few consumers get the short leash', () => {
  assert.equal(hunterBudget({ changedPaths: 5, consumers: 3 }), 15);
  assert.equal(hunterBudget({ changedPaths: 6, consumers: 3 }), 30);
  assert.equal(hunterBudget({ changedPaths: 2, consumers: 4 }), 30);
});
