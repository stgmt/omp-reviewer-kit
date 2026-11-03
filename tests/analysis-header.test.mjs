// The artifact header: one shape for the schema, the diff and the policy both analyses record, so a
// consumer comparing two artifacts cannot see one of them answer a different question.

import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisHeader } from '../src/domain/analysis-header.mjs';

test('Given an artifact identity, When the header is built, Then the schema, the diff and the policy are all carried', () => {
  assert.deepEqual(analysisHeader({ schema: 'reuse@1', diffHash: 'abc', policy: 'advisory' }), {
    schema: 'reuse@1', diffHash: 'abc', policy: 'advisory',
  });
});

test('Given two artifacts of one diff, When their headers are compared, Then the shared fields agree', () => {
  const reuse = analysisHeader({ schema: 'reuse@1', diffHash: 'abc', policy: 'advisory' });
  const maintainability = analysisHeader({ schema: 'maintainability@1', diffHash: 'abc', policy: 'block' });
  assert.equal(reuse.diffHash, maintainability.diffHash);
  assert.notEqual(reuse.schema, maintainability.schema);
});
