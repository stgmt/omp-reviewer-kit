// The task text of every host-driven stage: it carries the staged inputs and the stage's own inputs,
// and it never names a model, role, provider or fallback.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hunterTask, maintainabilityTask, recheckTask, scoutTask, synthesisTask, verifierTask } from '../src/native/stage-tasks.mjs';

const input = {
  context: {
    snapshot: { dir: '/tmp/staged-abc', diffHash: 'a'.repeat(64), changedPaths: ['src/a.mjs', 'test/a.test.mjs'] },
    repo: '/repo',
    profile: 'full',
    lanes: ['correctness'],
  },
  maintainability: { path: '/tmp/staged-abc/.review/maintainability.json', policy: 'block', status: 'analyzed', coverage: 'full', candidates: 1 },
  reuse: { policy: 'advisory', files: 2, units: 3, coverage: 'full', lines: [] },
  contract: { policy: 'advisory', status: 'no-pairs', probed: 0, rejected: [], unproven: [], unparsedFiles: [] },
};

const scout = { change_goal: 'Adds a function', changed_paths: ['src/a.mjs'], relevant_consumers: [], invariants: [], test_evidence: [], test_harness: 'present', coverage_map: [], non_coverable_items: [], claims: [], declared_checks: [], unknowns: [], reviewed_paths: [], completion: { scope_id: 'x', completed_paths: [], unresolved: [] } };

test('Given the staged inputs, When the scout task is built, Then it names the snapshot, the manifest and the stage role', () => {
  const text = scoutTask(input);
  assert.match(text, /The staged snapshot directory is \/tmp\/staged-abc/);
  assert.match(text, /Changed-file manifest: \/tmp\/staged-abc\/\.review\/changed-files\.txt/);
  assert.match(text, /You are the context scout stage/);
  assert.doesNotMatch(text, /\bmodel\b/i);
  assert.doesNotMatch(text, /@task|fallback|provider/i);
});

test('Given a lane and the scout result, When the hunter task is built, Then it names the lane, the budget and the scout JSON', () => {
  const text = hunterTask({ input, scout, lane: 'security', budget: 30 });
  assert.match(text, /You are the only hunter for lane: security/);
  assert.match(text, /Tool budget for this lane: 30 calls/);
  assert.match(text, /"change_goal": "Adds a function"/);
  assert.match(text, /Risk lanes for this diff: \["correctness"\]/, 'the shared staged inputs are still carried');
});

test('Given a candidate file, When the maintainability task is built, Then it names the file, the policy and the budget', () => {
  const text = maintainabilityTask({
    snapshotDir: '/tmp/staged-abc',
    candidatePath: '/tmp/staged-abc/.review/maintainability.json',
    policy: 'block',
    profile: 'full',
    budget: 8,
  });
  assert.match(text, /Candidate file \(deterministic, written before this task\): \/tmp\/staged-abc\/\.review\/maintainability\.json/);
  assert.match(text, /Policy: block/);
  assert.match(text, /Budget: about 8 tool calls/);
  assert.match(text, /You are the maintainability stage/);
});

test('Given candidates, gaps and shape duplicates, When the verifier task is built, Then every candidate is carried with its lane and each duplicate pair with both ranges', () => {
  const text = verifierTask({
    input,
    scout,
    hunters: [{ lane: 'correctness', data: { candidates: [{ candidate_id: 'correctness-1', title: 'Boom' }], coverage_gaps: [{ coverage_id: 'coverage-1' }] } }],
    coverageGaps: [{ coverage_id: 'coverage-1' }],
    duplicates: [{
      changedPath: 'src/new.mjs',
      changedLine: 4,
      changedName: 'secondCopy',
      existingPath: 'src/old.mjs',
      existingLine: 9,
      existingName: 'firstCopy',
      similarity: 0.93,
      sharedCalls: ['push', 'sort'],
    }],
    profile: 'full',
  });
  assert.match(text, /"candidate_id": "reuse-1"/);
  assert.match(text, /"changed": "src\/new\.mjs:4"/);
  assert.match(text, /"existing": "src\/old\.mjs:9"/);
  assert.match(text, /not findings/);
  assert.match(text, /"lane": "correctness"/);
  assert.match(text, /"candidate_id": "correctness-1"/);
  assert.match(text, /"coverage_id": "coverage-1"/);
  assert.match(text, /Maintainability candidates are not yours/);
});

test('Given every stage result, When the synthesis task is built, Then the facts are supplied, the scout prose is withheld and spawning is forbidden', () => {
  const text = synthesisTask({
    input,
    scout,
    hunters: [{ lane: 'correctness', data: { candidates: [], coverage_gaps: [] } }],
    maintainability: { candidates: [] },
    verifier: { confirmed_findings: [], confirmed_coverage_gaps: [] },
    profile: 'full',
    lanes: ['correctness'],
  });
  assert.match(text, /You are the final synthesis stage/);
  assert.match(text, /Do not spawn a subagent and do not re-run a stage/);
  assert.match(text, /Context scout facts/);
  assert.match(text, /Hunter results:/);
  assert.match(text, /Maintainability stage result:/);
  assert.match(text, /Verifier result:/);
  assert.match(text, /A confirmed finding must come from the verifier result/);
  assert.match(text, /"changed_paths": \[/, 'the scout facts are still carried');
  assert.match(text, /"test_harness": "present"/);
  assert.doesNotMatch(text, /"change_goal"/, 'a documented history of a past block must not reach synthesis as prose');
  assert.doesNotMatch(text, /"claims"/);
  assert.match(text, /end it with the single verdict marker/);
  assert.doesNotMatch(text, /\bmodel\b/i);
});

test('Given the claims a report made, When the recheck task is built, Then every claim is carried verbatim against the snapshot', () => {
  const text = recheckTask({ snapshotDir: '/tmp/staged-abc', findings: ['R1 (blocking): a conflict', 'R2: a second claim'] });
  assert.match(text, /Staged snapshot directory: \/tmp\/staged-abc/);
  assert.match(text, /asked a second time/);
  assert.match(text, /1\. R1 \(blocking\): a conflict/);
  assert.match(text, /2\. R2: a second claim/);
  assert.match(text, /Every source file read must come from the snapshot directory/);
  assert.doesNotMatch(text, /\bmodel\b/i);
  assert.doesNotMatch(text, /@task|fallback|provider/i);
});
