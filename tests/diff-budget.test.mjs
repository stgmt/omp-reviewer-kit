// Given/When/Then over the diff budget: how it is configured and when it refuses a review before any
// model runs. Pure: no Git, no filesystem, no environment mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_PATHS, assessDiff, formatDiffSize, readDiffBudget } from '../src/domain/diff-budget.mjs';

test('Given no configuration, When the budget is read, Then it is the documented default', () => {
  assert.deepEqual(readDiffBudget({ env: {} }), { ok: true, enabled: true, maxPaths: DEFAULT_MAX_PATHS, maxBytes: DEFAULT_MAX_BYTES, raw: '' });
  assert.equal(DEFAULT_MAX_PATHS, 40);
  assert.equal(DEFAULT_MAX_BYTES, 1_500_000);
});

test('Given off, When the budget is read, Then the check is disabled', () => {
  assert.deepEqual(readDiffBudget({ env: { OMP_REVIEW_KIT_MAX_DIFF: 'off' } }), { ok: true, enabled: false, maxPaths: null, maxBytes: null, raw: 'off' });
});

test('Given paths and megabytes, When the budget is read, Then both limits are used', () => {
  assert.deepEqual(readDiffBudget({ env: { OMP_REVIEW_KIT_MAX_DIFF: '20/2.5' } }), { ok: true, enabled: true, maxPaths: 20, maxBytes: 2_500_000, raw: '20/2.5' });
});

test('Given only a path count, When the budget is read, Then the default byte limit is kept', () => {
  assert.deepEqual(readDiffBudget({ env: { OMP_REVIEW_KIT_MAX_DIFF: '20' } }), { ok: true, enabled: true, maxPaths: 20, maxBytes: DEFAULT_MAX_BYTES, raw: '20' });
});

test('Given a malformed value, When the budget is read, Then it is refused instead of silently defaulting', () => {
  for (const raw of ['abc', '0', '40/x', '-1', '40/0']) {
    const budget = readDiffBudget({ env: { OMP_REVIEW_KIT_MAX_DIFF: raw } });
    assert.equal(budget.ok, false, raw);
    assert.equal(budget.error, `diff budget invalid: ${raw}`);
  }
});

test('Given more paths than the budget, When the diff is assessed, Then it is refused with the observed numbers', () => {
  const budget = readDiffBudget({ env: {} });
  assert.deepEqual(assessDiff({ paths: 41, bytes: 1024 }, budget), { refused: true, reason: 'too-many-paths', paths: 41, bytes: 1024, maxPaths: 40, maxBytes: DEFAULT_MAX_BYTES });
  assert.equal(assessDiff({ paths: 40, bytes: 1024 }, budget).refused, false);
});

test('Given more bytes than the budget, When the diff is assessed, Then it is refused', () => {
  const budget = readDiffBudget({ env: {} });
  const result = assessDiff({ paths: 3, bytes: DEFAULT_MAX_BYTES + 1 }, budget);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'patch-too-large');
});

test('Given a disabled budget, When any diff is assessed, Then it is never refused', () => {
  const budget = readDiffBudget({ env: { OMP_REVIEW_KIT_MAX_DIFF: 'off' } });
  assert.deepEqual(assessDiff({ paths: 5000, bytes: 999_999_999 }, budget), { refused: false, reason: null, paths: 5000, bytes: 999_999_999, maxPaths: null, maxBytes: null });
  assert.equal(assessDiff({ paths: 5000, bytes: 1 }, budget).refused, false);
});

test('Given byte counts, When they are formatted, Then they are readable and never NaN', () => {
  assert.equal(formatDiffSize(512), '512 B');
  assert.equal(formatDiffSize(2048), '2.0 KB');
  assert.equal(formatDiffSize(1_800_000), '1.8 MB');
  assert.equal(formatDiffSize(undefined), 'unknown');
});
