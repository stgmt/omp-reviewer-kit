// Given/When/Then over the prompt-safe rendering of a staged path. Pure: no Git, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePromptToken } from '../src/domain/prompt-token.mjs';

const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const TAG_LATIN_A = String.fromCodePoint(0xe0041);

test('Given a name with a newline, a carriage return and a tab, When sanitized, Then each is a literal escape and no raw control character remains', () => {
  const out = sanitizePromptToken('a\nb\rc\td');
  assert.equal(out, 'a\\nb\\rc\\td');
  assert.doesNotMatch(out, /[\x00-\x1f\x7f]/);
});

test('Given a bidi override and a tag character, When sanitized, Then both are written as escapes', () => {
  assert.equal(sanitizePromptToken(`a${BIDI_OVERRIDE}b`), 'a\\u202eb');
  assert.equal(sanitizePromptToken(`a${TAG_LATIN_A}b`), 'a\\u{e0041}b');
});

test('Given an ordinary name, When sanitized, Then it is unchanged', () => {
  assert.equal(sanitizePromptToken('src/a-b_c.d.mjs'), 'src/a-b_c.d.mjs');
});

test('Given a value that is not text, When sanitized, Then the result is empty', () => {
  assert.equal(sanitizePromptToken(undefined), '');
  assert.equal(sanitizePromptToken(42), '');
});
