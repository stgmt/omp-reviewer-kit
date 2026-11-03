// The shape rules a reuse hint rests on: names disappear, structure stays, and a copy that was
// renamed, reformatted or moved keeps the same shingles. Without this, a candidate list would be
// either empty for real copies or full for unrelated code.

import assert from 'node:assert/strict';
import test from 'node:test';
import { callsOf, jaccard, shapeOfSource, shapeTokens, shinglesOf } from '../src/native/reuse/shape.mjs';

const ORIGINAL = `export function computeChargeTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}`;

const RENAMED = `export function sumOrderAmount(rows, vat) {
  let accrued = 0;
  for (const row of rows) {
    accrued += row.cost * row.count;
  }
  const fee = accrued * vat;
  return Math.round((accrued + fee) * 100) / 100;
}`;

test('Given a function, When its shape is taken, Then identifiers and literals are placeholders and keywords stay', () => {
  const tokens = shapeTokens('const total = items.length + 42;', 'javascript');
  assert.deepEqual(tokens.slice(0, 6), ['const', 'I', '=', 'I', '.', 'I']);
  assert.ok(tokens.includes('N'), 'the number becomes N');
  assert.ok(!tokens.includes('length'), 'no identifier survives');
});

test('Given the same logic with every name changed, When the shapes are compared, Then the shingles are identical', () => {
  const left = shapeOfSource(ORIGINAL, 'javascript');
  const right = shapeOfSource(RENAMED, 'javascript');
  assert.equal(jaccard(left.shingles, right.shingles), 1);
});

test('Given two different functions, When the shapes are compared, Then the shingles share little', () => {
  const left = shapeOfSource(ORIGINAL, 'javascript');
  const right = shapeOfSource('export function formatName(first, last) { return `${last}, ${first}`; }', 'javascript');
  assert.ok(jaccard(left.shingles, right.shingles) < 0.2);
});

test('Given comments and string bodies, When the shape is taken, Then neither contributes tokens of its own', () => {
  const withComment = shapeTokens('// hidden words\nconst value = "another words";', 'javascript');
  assert.deepEqual(withComment, ['const', 'I', '=', 'S', ';']);
  const python = shapeTokens('# a python comment\nvalue = "words"', 'python');
  assert.deepEqual(python, ['I', '=', 'S']);
});

test('Given a JavaScript private field, When Python-style comments are not in play, Then the field keeps its shape token', () => {
  const tokens = shapeTokens('class A { #value = 1; get() { return this.#value; } }', 'javascript');
  assert.ok(tokens.includes('#'), 'the hash of a private field is not a comment');
});

test('Given a source calling dotted functions, When the calls are collected, Then the full chain is named and keywords are not', () => {
  const calls = callsOf('if (ready) { Math.round(total); store.save(item); }', 'javascript');
  assert.deepEqual(calls, ['Math.round', 'store.save']);
});

test('Given call-shaped text inside comments and strings, When the calls are collected, Then only real invocations are named', () => {
  const source = [
    '// store.save(item) in a comment is text',
    '/* audit.log(entry) in a block comment is text */',
    'const note = "store.save(item) inside a string";',
    'const prompt = `remember to audit.log(entry)`;',
    'return store.load(id);',
  ].join('\n');
  assert.deepEqual(callsOf(source, 'javascript'), ['store.load']);
  assert.deepEqual(callsOf('# audit.log(entry)\nvalue = store.load(id)\n', 'python'), ['store.load']);
});

test('Given a unit too small to fingerprint, When its shingles are taken, Then there are none', () => {
  assert.deepEqual(shinglesOf(['I', '='], 5), []);
});

test('Given two empty shingle sets, When the similarity is asked, Then it is zero rather than a perfect match', () => {
  assert.equal(jaccard([], []), 0);
});
