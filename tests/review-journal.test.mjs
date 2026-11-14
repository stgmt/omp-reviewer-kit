// The journal rules: one key per exact staged state, one stage plan, and the reuse predicates.
// Pure — every case here runs without a repository, a model or a file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOURNAL_SCHEMA,
  MAINTAINABILITY_STAGE,
  SCOUT_STAGE,
  STAGE_SCHEMA,
  VERIFIER_STAGE,
  configFingerprint,
  nextStage,
  planStages,
  resolveJournalPolicy,
  reviewKey,
  stageEntryValid,
  stageId,
  verdictReusable,
} from '../src/domain/review-journal.mjs';

const identity = {
  repoIdentity: 'e:\\repos\\demo',
  treeOid: 'a'.repeat(40),
  diffHash: 'b'.repeat(64),
  kitVersion: '0.30.0',
  agentsDigest: 'c'.repeat(64),
  configFingerprint: configFingerprint({ profile: 'full', lanes: ['correctness'] }),
};

test('Given the same staged identity, When the key is computed twice, Then it is the same key', () => {
  assert.equal(reviewKey(identity), reviewKey({ ...identity }));
});

test('Given a different index tree, When the key is computed, Then it changes', () => {
  assert.notEqual(reviewKey(identity), reviewKey({ ...identity, treeOid: 'd'.repeat(40) }));
});

test('Given a different kit version or agent digest, When the key is computed, Then it changes', () => {
  const base = reviewKey(identity);
  assert.notEqual(base, reviewKey({ ...identity, kitVersion: '0.30.1' }));
  assert.notEqual(base, reviewKey({ ...identity, agentsDigest: 'e'.repeat(64) }));
});

test('Given a missing identity part, When the key is computed, Then there is no key', () => {
  assert.equal(reviewKey({ ...identity, treeOid: null }), null);
  assert.equal(reviewKey({ ...identity, diffHash: '' }), null);
});

test('Given lanes in another order or case, When the configuration is fingerprinted, Then it is the same fingerprint', () => {
  const left = configFingerprint({ profile: 'full', lanes: ['correctness', 'security'] });
  const right = configFingerprint({ profile: 'full', lanes: [' Security ', 'correctness'] });
  assert.equal(left, right);
});

test('Given another stage policy, When the configuration is fingerprinted, Then it changes', () => {
  const base = configFingerprint({ profile: 'full', lanes: ['correctness'], contractPolicy: 'advisory' });
  const other = configFingerprint({ profile: 'full', lanes: ['correctness'], contractPolicy: 'block' });
  assert.notEqual(base, other);
});

test('Given another census policy, When the configuration is fingerprinted, Then it changes', () => {
  const base = configFingerprint({ profile: 'full', lanes: ['correctness'], compatPolicy: 'advisory', compatMaxLines: 12 });
  const off = configFingerprint({ profile: 'full', lanes: ['correctness'], compatPolicy: 'off', compatMaxLines: 12 });
  const shorter = configFingerprint({ profile: 'full', lanes: ['correctness'], compatPolicy: 'advisory', compatMaxLines: 4 });
  assert.notEqual(base, off, 'a verdict decided without the census must not answer a review that hands it to the hunter');
  assert.notEqual(base, shorter, 'the census block size decides what the hunter reads');
});

test('Given another maintainability analysis configuration, When the configuration is fingerprinted, Then it changes', () => {
  const base = configFingerprint({ profile: 'full', lanes: ['correctness'], maintainabilityConfig: { minSupport: 4, maxGroups: 200 } });
  const tighter = configFingerprint({ profile: 'full', lanes: ['correctness'], maintainabilityConfig: { minSupport: 8, maxGroups: 200 } });
  const reordered = configFingerprint({ profile: 'full', lanes: ['correctness'], maintainabilityConfig: { maxGroups: 200, minSupport: 4 } });
  assert.notEqual(base, tighter, 'thresholds decide which groups can block, so they belong to the key');
  assert.equal(base, reordered, 'the fingerprint depends on values, not on insertion order');
});

test('Given two lanes and a maintainability candidate file, When the plan is built, Then scout comes first and the verifier is not planned here', () => {
  const plan = planStages({ lanes: ['correctness', 'security'], maintainabilityPlanned: true });
  assert.deepEqual(plan, [
    SCOUT_STAGE,
    'review-risk-hunter:correctness',
    'review-risk-hunter:security',
    MAINTAINABILITY_STAGE,
  ]);
  assert.ok(!plan.includes(VERIFIER_STAGE));
});

test('Given a stage id, When a lane is present, Then the lane is part of the id', () => {
  assert.equal(stageId('review-risk-hunter', 'Correctness'), 'review-risk-hunter:correctness');
  assert.equal(stageId('review-context-scout'), 'review-context-scout');
});

test('Given a valid stage entry, When it is checked against another key or stage, Then it is not valid', () => {
  const entry = { schema: STAGE_SCHEMA, key: 'k1', stageId: SCOUT_STAGE, exitCode: 0, aborted: false, structuredStatus: 'valid' };
  assert.equal(stageEntryValid(entry, { key: 'k1', stageId: SCOUT_STAGE }), true);
  assert.equal(stageEntryValid(entry, { key: 'k2', stageId: SCOUT_STAGE }), false);
  assert.equal(stageEntryValid(entry, { key: 'k1', stageId: MAINTAINABILITY_STAGE }), false);
  assert.equal(stageEntryValid({ ...entry, exitCode: 1 }, { key: 'k1', stageId: SCOUT_STAGE }), false);
  assert.equal(stageEntryValid({ ...entry, aborted: true }, { key: 'k1', stageId: SCOUT_STAGE }), false);
  assert.equal(stageEntryValid({ ...entry, structuredStatus: 'invalid' }, { key: 'k1', stageId: SCOUT_STAGE }), false);
});

test('Given a finished journal for the same key, When it is checked for reuse, Then it is reusable', () => {
  const record = { schema: JOURNAL_SCHEMA, key: 'k1', state: 'done', verdict: { pass: false, verdict: 'BLOCK', reasons: [] } };
  assert.equal(verdictReusable(record, { key: 'k1' }), true);
  assert.equal(verdictReusable(record, { key: 'k2' }), false);
  assert.equal(verdictReusable({ ...record, state: 'running' }, { key: 'k1' }), false);
  assert.equal(verdictReusable({ ...record, schema: 'review-journal@0' }, { key: 'k1' }), false);
  assert.equal(verdictReusable({ ...record, verdict: { pass: true, verdict: 'MAYBE' } }, { key: 'k1' }), false);
});

test('Given a plan and some stored entries, When the resume point is asked, Then it is the first missing stage', () => {
  const plan = planStages({ lanes: ['correctness'] });
  assert.equal(nextStage(plan, []), SCOUT_STAGE);
  assert.equal(nextStage(plan, [{ stageId: SCOUT_STAGE }]), 'review-risk-hunter:correctness');
  assert.equal(nextStage(plan, [{ stageId: SCOUT_STAGE }, { stageId: 'review-risk-hunter:correctness' }]), null);
});

test('Given the journal policy environment, When it is resolved, Then only an explicit off disables reuse', () => {
  assert.equal(resolveJournalPolicy({}), 'read-write');
  assert.equal(resolveJournalPolicy({ OMP_REVIEW_KIT_JOURNAL: 'off' }), 'off');
  assert.equal(resolveJournalPolicy({ OMP_REVIEW_KIT_JOURNAL: ' OFF ' }), 'off');
  assert.equal(resolveJournalPolicy({ OMP_REVIEW_KIT_JOURNAL: 'nonsense' }), 'read-write');
});
