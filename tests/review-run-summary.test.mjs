// Given/When/Then over the value rules of one run record. These are pure functions: no file, no
// process, no model. The record is an observation, so every case also pins that nothing here can
// turn a malformed value into a confident one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_SCHEMA,
  formatDuration,
  isTerminalRun,
  normalizeRunRecord,
  runStateFor,
  shortAgent,
  stageCounts,
  stageSummaryLine,
} from '../src/domain/review-run-summary.mjs';

test('Given a duration in milliseconds, When it is formatted, Then minutes, seconds and hours stay readable', () => {
  assert.equal(formatDuration(820), '820ms');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(95_000), '1m35s');
  assert.equal(formatDuration(252_340), '4m12s');
  assert.equal(formatDuration(3_900_000), '1h05m');
});

test('Given an impossible duration, When it is formatted, Then the answer is unknown instead of NaN', () => {
  assert.equal(formatDuration(-1), 'unknown');
  assert.equal(formatDuration(Number.NaN), 'unknown');
  assert.equal(formatDuration('252340'), 'unknown');
  assert.equal(formatDuration(undefined), 'unknown');
});

test('Given the review finished, When its state is derived, Then only a PASS is passed, a BLOCK is blocked and an unstaged run is skipped', () => {
  assert.equal(runStateFor({ pass: true }), 'passed');
  assert.equal(runStateFor({ pass: false }), 'blocked');
  assert.equal(runStateFor({ pass: true }, { staged: false }), 'skipped');
  assert.equal(runStateFor(undefined), 'failed');
});

test('Given a stage structured payload, When its counts are taken, Then arrays become lengths and text stays out', () => {
  const counts = stageCounts({
    behaviors: [{}, {}, {}],
    candidates: [{}],
    confirmed: false,
    gaps: 3,
    summary: 'text that must never reach the record',
    nested: { deep: 'value' },
  });
  assert.deepEqual(counts, { behaviors: 3, candidates: 1, gaps: 3 });
  assert.equal(JSON.stringify(counts).includes('text that must never'), false);
});

test('Given a payload with many keys, When its counts are taken, Then the record keeps a bounded number of them', () => {
  const wide = {};
  for (let index = 0; index < 40; index += 1) wide[`key${String(index).padStart(2, '0')}`] = [index];
  assert.equal(Object.keys(stageCounts(wide)).length, 16);
});

test('Given a record of another shape, When it is normalized, Then unknown keys are dropped and the schema is pinned', () => {
  const normalized = normalizeRunRecord({
    schema: 'review-run-record@1',
    runId: 'run-1',
    state: 'passed',
    verdict: 'PASS',
    unknownField: 'dropped',
    durationMs: 1000,
    stages: [{ agent: 'review-context-scout', durationMs: 500, data: { secret: 'text' }, extra: 1 }],
  });
  assert.equal(normalized.schema, RUN_SCHEMA);
  assert.equal('unknownField' in normalized, false);
  assert.equal('data' in normalized.stages[0], false);
  assert.equal('extra' in normalized.stages[0], false);
  assert.equal(normalized.stages[0].durationMs, 500);
});

test('Given malformed values, When a record is normalized, Then nothing is invented', () => {
  const normalized = normalizeRunRecord({ runId: 7, state: 'exploded', durationMs: 'soon', stages: 'many', lanes: [1, 'correctness'] });
  assert.equal(normalized.runId, null);
  assert.equal(normalized.state, 'failed');
  assert.equal(normalized.durationMs, null);
  assert.deepEqual(normalized.stages, []);
  assert.deepEqual(normalized.lanes, ['correctness']);
});

test('Given a record, When its terminality is asked, Then only a settled run is terminal', () => {
  assert.equal(isTerminalRun({ state: 'passed' }), true);
  assert.equal(isTerminalRun({ state: 'skipped' }), true);
  assert.equal(isTerminalRun({ state: 'running' }), false);
  assert.equal(isTerminalRun(null), false);
});

test('Given stage durations, When they are summarized, Then each stage is named by its last segment', () => {
  assert.equal(shortAgent('review-context-scout'), 'scout');
  assert.equal(shortAgent('review-risk-hunter'), 'hunter');
  assert.equal(shortAgent(null), 'stage');
  assert.equal(
    stageSummaryLine([
      { agent: 'review-context-scout', durationMs: 62_000 },
      { agent: 'review-finding-verifier', durationMs: 58_000 },
      { agent: 'review-risk-hunter', durationMs: null },
    ]),
    'scout 1m02s · verifier 58s',
  );
});

test('Given a refused run, When its terminality is read, Then it is terminal so a follow loop settles instead of calling it interrupted', () => {
  assert.equal(isTerminalRun({ state: 'refused' }), true);
  for (const state of ['passed', 'blocked', 'failed', 'skipped', 'refused']) {
    assert.equal(isTerminalRun({ state }), true, state + ' is terminal');
  }
  assert.equal(isTerminalRun({ state: 'running' }), false);
  assert.equal(isTerminalRun(undefined), false);
});
