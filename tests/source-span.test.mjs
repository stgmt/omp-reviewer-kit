// The span shape every scan reports: one rule for both ends, so a consumer that slices by it cannot
// get a range that starts somewhere and ends at the start.

import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceSpan } from '../src/domain/source-span.mjs';

test('Given a range, When the span is built, Then both ends are carried', () => {
  assert.deepEqual(sourceSpan(10, 20), { lineStart: 10, lineEnd: 20 });
});

test('Given a missing end, When the span is built, Then it ends where it starts', () => {
  assert.deepEqual(sourceSpan(7, Number.NaN), { lineStart: 7, lineEnd: 7 });
  assert.deepEqual(sourceSpan(7, undefined), { lineStart: 7, lineEnd: 7 });
});

test('Given a missing start, When the span is built, Then it begins at line one', () => {
  assert.deepEqual(sourceSpan(Number.NaN, 3), { lineStart: 1, lineEnd: 3 });
});

test('Given a single line, When the span is built, Then start and end are that line', () => {
  assert.deepEqual(sourceSpan(4, 4), { lineStart: 4, lineEnd: 4 });
});
