import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import * as source from '../src/domain/review-batch.mjs';
import * as bundled from '../scripts/run-review.mjs';

for (const { createReviewBatchManifest, gateReviewBatch, validateBatchResults, planScoutScopes, mergeScoutReports } of [source, bundled]) {

const test = (name, body) => nodeTest(`${mergeScoutReports === source.mergeScoutReports ? 'source' : 'bundle'}: ${name}`, body);
const diff = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
const manifest = createReviewBatchManifest({ invocationToken: 'test', prompt: 'staged inputs', diffText: diff('src/a.mjs'), riskLanes: ['correctness', 'security'] });
const fields = ['changed_paths', 'relevant_consumers', 'invariants', 'test_evidence', 'coverage_map', 'non_coverable_items', 'claims', 'declared_checks', 'unknowns', 'reviewed_paths'];
const scout = (scope) => ({ ...Object.fromEntries(fields.map((f) => [f, []])), change_goal: 'goal', changed_paths: scope.paths, reviewed_paths: scope.paths, invariants: ['Owned behavior inspected against the staged contract'], test_harness: 'present', completion: { scope_id: scope.id, completed_paths: scope.paths, unresolved: [] } });

test('Given a claimed completion, When substantive discovery or owned paths are empty, Then the scout cannot complete', () => {
  const scopes = [{ id: 'Scout1', paths: ['src/a.mjs'] }];
  const empty = { ...Object.fromEntries(fields.map((f) => [f, []])), change_goal: '', test_harness: 'present', completion: { scope_id: 'Scout1', completed_paths: scopes[0].paths, unresolved: [] } };
  assert.throws(() => mergeScoutReports([empty], scopes), /Incomplete scout discovery/);
  for (const field of ['changed_paths', 'reviewed_paths', 'invariants']) {
    assert.throws(() => mergeScoutReports([{ ...scout(scopes[0]), [field]: [] }], scopes), /Incomplete scout discovery/);
  }
});

test('Given scoped scouts, When dispatching, Then output ownership excludes cross-scope evidence paths', () => {
  const tasks = manifest.scouts.map((scope) => ({ name: scope.id, agent: 'review-context-scout', task: 'Map the full staged change' }));
  const gated = gateReviewBatch({ tasks }, manifest);
  assert.match(gated.tasks[0].task, /changed_paths and completion\.completed_paths must contain exactly the primary owned paths/);
  assert.match(gated.tasks[0].task, /coverage_map and non_coverable_items file_path, and claims and declared_checks source_path must belong to primary owned paths/);
  assert.match(gated.tasks[0].task, /Cross-scope evidence belongs in relevant_consumers, invariants, test_evidence and reviewed_paths/);
});

test('Given native flat tasks, When each planned item is requested, Then preserve flat policy without dropping ownership', () => {
  const task = { name: manifest.hunters[0].id, agent: 'review-risk-hunter', task: 'hunt' };
  const gated = gateReviewBatch(task, manifest, { batchEnabled: false });
  assert.equal(gated.tasks.length, 1);
  assert.equal(gated.tasks[0].name, task.name);
  assert.throws(() => gateReviewBatch({ ...task, name: 'foreign' }, manifest, { batchEnabled: false }), /planned flat task/);
  assert.throws(() => gateReviewBatch({ tasks: manifest.hunters.map((h) => ({ ...task, name: h.id })) }, manifest, { batchEnabled: false }), /One planned flat task/);
});

test('Given independent source/test pairs sharing a test directory, When grouping, Then tests do not bridge unrelated contracts', () => {
  const diffText = ['src/a.mjs', 'lib/b.mjs', 'tests/a.test.mjs', 'tests/b.test.mjs'].map(diff).join('');
  const scopes = planScoutScopes({ diffText, thresholdBytes: 1, files: [
    { path: 'tests/a.test.mjs', content: Buffer.from("import '../src/a.mjs'") },
    { path: 'tests/b.test.mjs', content: Buffer.from("import '../lib/b.mjs'") },
  ] });
  assert.equal(scopes.length, 2);
  assert.ok(scopes.some((s) => s.paths.includes('src/a.mjs') && s.paths.includes('tests/a.test.mjs') && !s.paths.includes('lib/b.mjs')));
});

test('Given independent changes, When planning scopes, Then all paths are owned and direct imports stay together', () => {
  const diffText = diff('src/a.mjs') + diff('tests/other.test.mjs') + diff('docs/contract.md');
  const scopes = planScoutScopes({ diffText, thresholdBytes: 1, files: [{ path: 'tests/other.test.mjs', content: Buffer.from("import a from '../src/a.mjs'") }] });
  assert.equal(scopes.length, 2);
  assert.deepEqual(scopes.flatMap((s) => s.paths).sort(), ['docs/contract.md', 'src/a.mjs', 'tests/other.test.mjs']);
  assert.ok(scopes.some((s) => s.paths.includes('src/a.mjs') && s.paths.includes('tests/other.test.mjs')));
  assert.equal(planScoutScopes({ diffText, thresholdBytes: 10000 }).length, 1);
});

test('Given planned hunters, When a lane is missing, duplicated or overridden, Then reject before dispatch', () => {
  const tasks = manifest.hunters.map((p) => ({ name: p.id, agent: 'review-risk-hunter', task: 'hunt' }));
  assert.throws(() => gateReviewBatch({ tasks: tasks.slice(0, 1) }, manifest), /complete native batch/);
  assert.throws(() => gateReviewBatch({ tasks: [tasks[0], tasks[0]] }, manifest), /complete native batch/);
  assert.throws(() => gateReviewBatch({ tasks: tasks.map((t) => ({ ...t, model: 'wrong' })) }, manifest), /inherit/);
  const gated = gateReviewBatch({ tasks }, manifest);
  assert.deepEqual(gated.tasks.map((t) => t.name), tasks.map((t) => t.name));
  assert.match(gated.context, /staged inputs/);
  assert.match(gated.tasks[1].task, /security/);
});

test('Given native results, When preflight, abort, missing or foreign identity appears, Then it is not successful coverage', () => {
  const input = gateReviewBatch({ tasks: manifest.hunters.map((p) => ({ name: p.id, agent: 'review-risk-hunter' })) }, manifest);
  const good = input.tasks.map((t) => ({ id: t.name, agent: t.agent, exitCode: 0, structuredOutput: { status: 'valid', data: { coverage_summary: 'checked', candidates: [], coverage_gaps: [], suppressed_coverage_items: [] } } }));
  assert.equal(validateBatchResults(input, { results: good }).length, 2);
  for (const results of [[], [...good, good[0]], good.slice(0, 1), [{ ...good[0], id: 'foreign' }, good[1]], [{ ...good[0], aborted: true }, good[1]], [{ ...good[0], structuredOutput: { status: 'valid', data: { aborted: true } } }, good[1]]]) assert.throws(() => validateBatchResults(input, { results }));
});

test('Given scoped scouts, When obligations or ownership are lost, Then merge cannot hide the gap', () => {
  const scopes = [{ id: 'Scout1', paths: ['a'] }, { id: 'Scout2', paths: ['b'] }];
  const reports = scopes.map(scout);
  assert.deepEqual(mergeScoutReports(reports, scopes).completion.scopes, ['Scout1', 'Scout2']);
  assert.throws(() => mergeScoutReports(reports.slice(0, 1), scopes));
  const incomplete = structuredClone(reports);
  incomplete[1].completion.unresolved = ['caller unknown'];
  assert.throws(() => mergeScoutReports(incomplete, scopes), /Unresolved/);
  const foreign = structuredClone(reports);
  foreign[0].coverage_map = [{ file_path: 'b', behavior: 'x', line_start: 1, line_end: 1, covering_test: null }];
  assert.throws(() => mergeScoutReports(foreign, scopes), /ownership/);
  const conflict = structuredClone(reports);
  conflict[1].test_harness = 'absent';
  assert.throws(() => mergeScoutReports(conflict, scopes), /harness conflict/);
  const duplicate = structuredClone(reports);
  duplicate[0].completion.completed_paths = ['a', 'a'];
  assert.throws(() => mergeScoutReports(duplicate, scopes), /Unresolved/);
});

}
