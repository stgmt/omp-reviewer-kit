// Given/When/Then over the risk lanes Stage 2 spawns. Pure: the environment map is passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskLanesFor } from '../src/domain/file-class.mjs';

test('Given no lane override, When the lanes are chosen, Then full runs correctness only and spec-docs runs content-risk', () => {
  assert.deepEqual(riskLanesFor('full', {}), ['correctness']);
  assert.deepEqual(riskLanesFor('spec-docs', {}), ['content-risk']);
});

test('Given a lane list with spaces, mixed case and a repeat, When the lanes are chosen, Then the names are normalized and each lane appears once', () => {
  assert.deepEqual(riskLanesFor('full', { OMP_REVIEW_KIT_LANES: ' Security, correctness,security ' }), ['security', 'correctness']);
});

test('Given a lane list made only of separators, When the lanes are chosen, Then it fails instead of disabling Stage 2', () => {
  assert.throws(() => riskLanesFor('full', { OMP_REVIEW_KIT_LANES: ' , ' }), /names no usable lane/);
});

test('Given an unknown lane name, When the lanes are chosen, Then it fails naming the unknown lane', () => {
  assert.throws(() => riskLanesFor('full', { OMP_REVIEW_KIT_LANES: 'correctness,bogus' }), /unknown lane "bogus"/);
});
