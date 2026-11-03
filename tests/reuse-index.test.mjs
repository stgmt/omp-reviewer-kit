// The candidate rules: a renamed copy inside or outside the diff is found, unrelated code is not,
// boilerplate cannot flood the list, and the same pair is never reported twice.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReuseConfig } from '../src/native/reuse/config.mjs';
import { commonShingleLimit, findReuseCandidates, MIN_COMMON_UNITS } from '../src/native/reuse/index.mjs';
import { shapeOfSource } from '../src/native/reuse/shape.mjs';

const config = resolveReuseConfig({ maxCandidates: 5 });

function unit(path, lineStart, source, name = null) {
  const shape = shapeOfSource(source, 'javascript');
  return { path, language: 'javascript', name, lineStart, lineEnd: lineStart + source.split('\n').length - 1, ...shape };
}

const BILLING = `export function computeChargeTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}`;

const ORDERS = `export function sumOrderAmount(rows, vat) {
  let accrued = 0;
  for (const row of rows) {
    accrued += row.cost * row.count;
  }
  const fee = accrued * vat;
  return Math.round((accrued + fee) * 100) / 100;
}`;

const FORMATTER = `export function formatLabel(name, count) {
  return \`\${name}: \${count}\`;
}`;

test('Given a renamed copy in another file, When candidates are computed, Then the pair is found with a high shape score', () => {
  const units = [unit('src/orders.mjs', 1, ORDERS, 'sumOrderAmount'), unit('src/billing.mjs', 1, BILLING, 'computeChargeTotal')];
  const { candidates, considered } = findReuseCandidates({ units, changedPaths: ['src/orders.mjs'], config });
  assert.equal(considered, 2);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].changedPath, 'src/orders.mjs');
  assert.equal(candidates[0].existingPath, 'src/billing.mjs');
  assert.equal(candidates[0].similarity, 1);
  assert.equal(candidates[0].existingIsInDiff, false);
  assert.deepEqual(candidates[0].sharedCalls, ['Math.round']);
});

test('Given a copy inside the diff itself, When candidates are computed, Then the pair is reported once and marked as inside the diff', () => {
  const units = [unit('src/a.mjs', 1, BILLING, 'a'), unit('src/b.mjs', 1, ORDERS, 'b')];
  const { candidates } = findReuseCandidates({ units, changedPaths: ['src/a.mjs', 'src/b.mjs'], config });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].changedPath, 'src/a.mjs');
  assert.equal(candidates[0].existingPath, 'src/b.mjs');
  assert.equal(candidates[0].existingIsInDiff, true);
});

test('Given unrelated code, When candidates are computed, Then nothing is reported', () => {
  const units = [unit('src/orders.mjs', 1, ORDERS, 'sumOrderAmount'), unit('src/labels.mjs', 1, FORMATTER, 'formatLabel')];
  const { candidates } = findReuseCandidates({ units, changedPaths: ['src/orders.mjs'], config });
  assert.deepEqual(candidates, []);
});

test('Given a unit too small to fingerprint, When candidates are computed, Then it never becomes a candidate', () => {
  const units = [unit('src/a.mjs', 1, 'export const a = (x, y) => x;', 'a'), unit('src/b.mjs', 1, 'export const b = (x, y) => x;', 'b')];
  const { considered, candidates } = findReuseCandidates({ units, changedPaths: ['src/a.mjs'], config });
  assert.equal(considered, 0);
  assert.deepEqual(candidates, []);
});

test('Given more pairs than the cap, When candidates are computed, Then the strongest pairs are kept in a stable order', () => {
  const units = [];
  for (let index = 0; index < 8; index += 1) units.push(unit(`src/copy-${index}.mjs`, 1, ORDERS, `copy${index}`));
  const { candidates } = findReuseCandidates({ units, changedPaths: ['src/copy-0.mjs'], config });
  assert.equal(candidates.length, 5);
  const keys = candidates.map(candidate => `${candidate.changedPath}:${candidate.existingPath}`);
  assert.deepEqual(keys, [...new Set(keys)], 'no pair appears twice');
  assert.deepEqual(keys, [...keys].sort(), 'the order is deterministic');
});

test('Given a definition nested inside another, When candidates are computed, Then the pair is not counted as a second implementation', () => {
  const innerBody = BILLING.slice(BILLING.indexOf('{') + 1, BILLING.lastIndexOf('}'));
  const outer = `export function outer(items, taxRate) {${innerBody}}`;
  const units = [unit('src/outer.mjs', 1, outer, 'outer'), unit('src/outer.mjs', 2, innerBody, 'inner')];
  const { candidates } = findReuseCandidates({ units, changedPaths: ['src/outer.mjs'], config });
  assert.deepEqual(candidates.filter(candidate => candidate.existingPath === 'src/outer.mjs' && candidate.changedLine !== candidate.existingLine), []);
});

test('Given a snapshot of a hundred units, When the boilerplate cutoff is asked for, Then a shingle shared by thirteen units is boilerplate', () => {
  const limit = commonShingleLimit(100);
  assert.equal(limit, MIN_COMMON_UNITS, 'a thirteenth share of a hundred units is not boilerplate');
  assert.ok(13 > limit, 'a shingle shared by thirteen units of a hundred is boilerplate');
  assert.ok(12 <= limit, 'a shingle shared by twelve units is still evidence');
  assert.equal(commonShingleLimit(5), MIN_COMMON_UNITS, 'a small set never loses every shingle');
  assert.equal(commonShingleLimit(0), MIN_COMMON_UNITS);
});

test('Given two similar sibling definitions on one physical line, When candidates are computed, Then the pair is reported', () => {
  const body = BILLING.slice(BILLING.indexOf('{') + 1, BILLING.lastIndexOf('}'));
  const left = { ...unit('src/one-line.mjs', 1, body, 'chargeA'), startOffset: 0, endOffset: body.length };
  const right = { ...unit('src/one-line.mjs', 1, body, 'chargeB'), startOffset: body.length + 1, endOffset: body.length * 2 + 1 };
  const { candidates } = findReuseCandidates({ units: [left, right], changedPaths: ['src/one-line.mjs'], config });
  assert.equal(candidates.length, 1, 'the two siblings are one pair, not one unit');
  assert.equal(candidates[0].similarity, 1);
});

test('Given one unit compared with itself, When candidates are computed, Then no pair is invented', () => {
  const only = { ...unit('src/only.mjs', 1, BILLING, 'only'), startOffset: 0, endOffset: BILLING.length };
  const { candidates } = findReuseCandidates({ units: [only], changedPaths: ['src/only.mjs'], config });
  assert.deepEqual(candidates, []);
});

test('Given two same-line siblings matching one existing unit, When candidates are computed, Then both pairs survive deduplication', () => {
  const body = BILLING.slice(BILLING.indexOf('{') + 1, BILLING.lastIndexOf('}'));
  const twin = { ...unit('src/billing.mjs', 1, body, 'twin'), startOffset: 0, endOffset: body.length };
  const left = { ...unit('src/one-line.mjs', 1, body, 'left'), startOffset: 0, endOffset: body.length };
  const right = { ...unit('src/one-line.mjs', 1, body, 'right'), startOffset: body.length + 1, endOffset: body.length * 2 + 1 };
  const { candidates } = findReuseCandidates({ units: [twin, left, right], changedPaths: ['src/one-line.mjs'], config });
  const pairs = candidates.filter(candidate => candidate.existingPath === 'src/billing.mjs');
  assert.equal(pairs.length, 2, 'each sibling is its own pair with the existing unit');
});
