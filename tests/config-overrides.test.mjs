// One override rule for every analysis: an unknown key is an error even when the name is inherited
// from Object.prototype, and only a positive value of the right kind is accepted.

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNumberOverrides } from '../src/domain/config-overrides.mjs';

const DEFAULTS = Object.freeze({ maxFiles: 10, minSimilarity: 0.5 });
const INTEGER = { label: 'demo', integer: true };
const NUMBER = { label: 'demo' };

test('Given a declared key, When it is overridden, Then the value is accepted and the defaults are untouched', () => {
  const config = applyNumberOverrides(DEFAULTS, { maxFiles: 25 }, INTEGER);
  assert.equal(config.maxFiles, 25);
  assert.equal(config.minSimilarity, 0.5);
  assert.equal(DEFAULTS.maxFiles, 10, 'the shared defaults are never mutated');
});

test('Given an unknown key, When it is overridden, Then it is rejected', () => {
  assert.throws(() => applyNumberOverrides(DEFAULTS, { maxFile: 3 }, INTEGER), /unknown demo config key: maxFile/);
});

test('Given a name inherited from Object.prototype, When it is overridden, Then it is rejected like any unknown key', () => {
  assert.throws(() => applyNumberOverrides(DEFAULTS, { toString: 1 }, INTEGER), /unknown demo config key: toString/);
  assert.throws(() => applyNumberOverrides(DEFAULTS, { constructor: 1 }, INTEGER), /unknown demo config key: constructor/);
});

test('Given a value that is not positive, When it is overridden in integer mode, Then it is rejected', () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => applyNumberOverrides(DEFAULTS, { maxFiles: value }, INTEGER), /must be a positive integer/);
  }
});

test('Given a positive value, When it is overridden in number mode, Then a fraction is accepted', () => {
  const config = applyNumberOverrides(DEFAULTS, { minSimilarity: 0.75 }, NUMBER);
  assert.equal(config.minSimilarity, 0.75);
});

test('Given a value that is not positive, When it is overridden in number mode, Then it is rejected', () => {
  for (const value of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => applyNumberOverrides(DEFAULTS, { minSimilarity: value }, NUMBER), /must be a positive number/);
  }
});

test('Given no overrides, When the config is resolved, Then it is a copy of the defaults', () => {
  const config = applyNumberOverrides(DEFAULTS, {}, INTEGER);
  assert.deepEqual(config, { ...DEFAULTS });
  assert.notEqual(config, DEFAULTS);
});
