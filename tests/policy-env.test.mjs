// The shared policy switch: a typo or an absent value keeps the caller's fallback, so a mistyped
// environment variable can never quietly turn a blocking gate into an advisory one. The cases live in
// one table: the switch name, the accepted values and the fallback are written once.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePolicyFromEnv } from '../src/domain/policy-env.mjs';
import { POLICY_ENV as MAINTAINABILITY_ENV, resolvePolicy } from '../src/native/maintainability/config.mjs';
import { POLICY_ENV as REUSE_ENV, resolveReusePolicy } from '../src/native/reuse/config.mjs';

const SWITCH = { name: 'OMP_TEST_POLICY', policies: ['off', 'advisory', 'block'], fallback: 'block' };

const CASES = [
  { given: 'a known value', value: 'advisory', expected: 'advisory' },
  { given: 'another known value', value: 'off', expected: 'off' },
  { given: 'an absent value', value: undefined, expected: 'block' },
  { given: 'an empty value', value: '', expected: 'block' },
  { given: 'a typo', value: 'advisroy', expected: 'block' },
  { given: 'mixed case and padding', value: '  ADVISORY  ', expected: 'advisory' },
  { given: 'a capitalised value', value: 'Off', expected: 'off' },
];

for (const testCase of CASES) {
  test(`Given ${testCase.given}, When the switch is read, Then it resolves to ${testCase.expected}`, () => {
    const env = testCase.value === undefined ? {} : { [SWITCH.name]: testCase.value };
    assert.equal(resolvePolicyFromEnv(env, SWITCH), testCase.expected);
  });
}

test('Given no environment at all, When the switch is read, Then the caller fallback is returned', () => {
  assert.equal(resolvePolicyFromEnv(undefined, SWITCH), 'block');
});

test('Given the maintainability switch, When it is absent or mistyped, Then it stays block so the gate stays fail-closed', () => {
  assert.equal(resolvePolicy({}), 'block');
  assert.equal(resolvePolicy({ [MAINTAINABILITY_ENV]: 'nonsense' }), 'block');
  assert.equal(resolvePolicy({ [MAINTAINABILITY_ENV]: 'advisory' }), 'advisory');
});

test('Given the reuse switch, When it is absent or mistyped, Then it stays advisory', () => {
  assert.equal(resolveReusePolicy({}), 'advisory');
  assert.equal(resolveReusePolicy({ [REUSE_ENV]: 'blocc' }), 'advisory');
  assert.equal(resolveReusePolicy({ [REUSE_ENV]: 'off' }), 'off');
});
