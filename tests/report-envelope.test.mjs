// Given/When/Then over the one boundary that turns the reviewer's yield payload into Markdown.
// Exactly two accepted shapes (a string and one wrapper object), everything else is refused with the
// keys that actually arrived, so an unusable payload is never guessed at.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readReportEnvelope } from '../src/domain/report-envelope.mjs';

const REPORT = '## Review\n\nREVIEW_RESULT=PASS';

test('Given the payload is the report string, When it is read, Then the Markdown and no keys are reported', () => {
  assert.deepEqual(readReportEnvelope(REPORT), { ok: true, markdown: REPORT, reason: null, observed: [] });
});

test('Given the payload is one object wrapping the report, When it is read, Then the Markdown is returned and the wrapper key is reported', () => {
  assert.deepEqual(readReportEnvelope({ data: REPORT }), { ok: true, markdown: REPORT, reason: null, observed: ['data'] });
});

test('Given the payload is the double wrapper observed in the 12:18 run, When it is read, Then it is refused and the nested path is reported', () => {
  assert.deepEqual(readReportEnvelope({ data: { data: REPORT } }), { ok: false, markdown: null, reason: 'nested-payload', observed: ['data.data'] });
});

test('Given two string fields, When it is read, Then it is refused as ambiguous instead of choosing one', () => {
  assert.deepEqual(readReportEnvelope({ report: REPORT, summary: 'x' }), { ok: false, markdown: null, reason: 'ambiguous-payload', observed: ['report', 'summary'] });
});

test('Given no usable payload, When it is read, Then every unsupported shape is refused and named', () => {
  assert.equal(readReportEnvelope({}).reason, 'unsupported-shape');
  assert.equal(readReportEnvelope({ data: 42 }).reason, 'unsupported-shape');
  assert.deepEqual(readReportEnvelope({ data: 42 }).observed, ['data']);
  assert.equal(readReportEnvelope(null).reason, 'unsupported-shape');
  assert.equal(readReportEnvelope(['a']).reason, 'unsupported-shape');
  assert.equal(readReportEnvelope(undefined).reason, 'unsupported-shape');
});

test('Given a blank string, When it is read, Then it is refused as empty rather than accepted as a report', () => {
  assert.equal(readReportEnvelope('   \n ').reason, 'empty-payload');
});
