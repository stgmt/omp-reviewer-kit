import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as source from '../src/domain/review-batch.mjs';
import * as bundled from '../scripts/run-review.mjs';
import { registerReviewBatchGate } from '../src/infra/review-batch-extension.mjs';

const FIELDS = ['changed_paths', 'relevant_consumers', 'invariants', 'test_evidence', 'coverage_map', 'non_coverable_items', 'claims', 'declared_checks', 'unknowns', 'reviewed_paths'];
const scopes = [{ id: 'Scout1', paths: ['a.json'] }, { id: 'Scout2', paths: ['b.md'] }];
const claim = (file, line = 1) => ({ claim: 'recorded number', source_path: file, source_line: line, kind: 'number' });
const scout = (scope, extra = {}) => ({
  ...Object.fromEntries(FIELDS.map((field) => [field, []])),
  change_goal: 'goal', changed_paths: scope.paths, reviewed_paths: scope.paths, invariants: ['owned contract'], test_harness: 'present',
  completion: { scope_id: scope.id, completed_paths: scope.paths, unresolved: [] }, ...extra,
});
const nativeResult = (scope, data) => ({ id: scope.id, agent: 'review-context-scout', exitCode: 0, structuredOutput: { status: 'valid', data } });

for (const [label, domain] of [['source', source], ['bundle', bundled]]) {
  test(`${label}: Given a scout cites a file another scout owns, When the batch merges, Then the entry is kept once and nothing fails`, () => {
    const reports = [scout(scopes[0], { claims: [claim('b.md', 7)], declared_checks: [{ command: 'npm test', source_path: 'b.md', source_line: 9 }] }),
      scout(scopes[1], { claims: [claim('b.md', 7)] })];
    const merged = domain.mergeScoutReports(reports, scopes);
    assert.deepEqual(merged.claims, [claim('b.md', 7)], 'the same claim from the owner is not repeated');
    assert.deepEqual(merged.declared_checks, [{ command: 'npm test', source_path: 'b.md', source_line: 9 }]);
    assert.equal('dropped_entries' in merged, false);
  });

  test(`${label}: Given a scout cites a path no scout owns, When the batch merges, Then the entry is dropped and counted, never failed`, () => {
    const reports = [scout(scopes[0], {
      claims: [claim('a.json'), claim('package.json', 3), claim('docs/x.md')],
      declared_checks: [{ command: 'x', source_path: 'ghost.mjs', source_line: 1 }],
      non_coverable_items: [{ file_path: 'ghost.mjs', line_start: 1, line_end: 2, reason: 'generated' }],
    }), scout(scopes[1])];
    const merged = domain.mergeScoutReports(reports, scopes);
    assert.deepEqual(merged.claims, [claim('a.json')]);
    assert.deepEqual(merged.declared_checks, []);
    assert.deepEqual(merged.non_coverable_items, []);
    assert.deepEqual(merged.dropped_entries, [
      { scope: 'Scout1', field: 'non_coverable_items', count: 1 },
      { scope: 'Scout1', field: 'claims', count: 2 },
      { scope: 'Scout1', field: 'declared_checks', count: 1 },
    ]);
  });

  test(`${label}: Given a scout whose only discovery was outside the batch, When it merges, Then it still has not discovered anything`, () => {
    const only = scout(scopes[0], { invariants: [], claims: [claim('ghost.mjs')] });
    assert.throws(() => domain.mergeScoutReports([only, scout(scopes[1])], scopes), /Incomplete scout discovery/);
  });

  test(`${label}: Given foreign coverage, completion or changed paths, When it merges, Then ownership still fails the scout`, () => {
    const coverage = { file_path: 'b.md', behavior: 'x', line_start: 1, line_end: 1, covering_test: null };
    assert.throws(() => domain.mergeScoutReports([scout(scopes[0], { coverage_map: [coverage] }), scout(scopes[1])], scopes), /Scout coverage outside ownership/);
    const claimed = scout(scopes[0]);
    claimed.completion.completed_paths = ['a.json', 'b.md'];
    assert.throws(() => domain.mergeScoutReports([claimed, scout(scopes[1])], scopes), /foreign ownership/);
  });

  test(`${label}: Given per-task validation of a scout that cites another scout's file, Then the task is not failed, and an unowned path is dropped silently`, () => {
    const input = { tasks: scopes.map((scope) => ({ name: scope.id, agent: 'review-context-scout' })) };
    const results = [
      nativeResult(scopes[0], scout(scopes[0], { claims: [claim('b.md', 2), claim('ghost.mjs')] })),
      nativeResult(scopes[1], scout(scopes[1])),
    ];
    const { valid, failures } = domain.validateBatchTasks(input, { results }, null, scopes);
    assert.deepEqual(failures, []);
    assert.deepEqual([...valid.keys()], ['Scout1', 'Scout2']);
    // What a neighbour owns counts as discovery for the batch even when it is all a scout found in its own scope.
    const thin = [nativeResult(scopes[0], scout(scopes[0], { invariants: [], claims: [claim('b.md', 2)] })), results[1]];
    assert.deepEqual(domain.validateBatchTasks(input, { results: thin }, null, scopes).failures, []);
  });
}

test('Given a native batch where a scout cites a neighbour\'s file, When the gate judges it, Then there is no retry and the merged scout reaches the hunters', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-foreign-gate-'));
  try {
    const file = path.join(root, 'manifest.json');
    await writeFile(file, JSON.stringify({ schema: 'review-batch@1', invocationToken: 'test', prompt: 'source', scouts: scopes, hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: [] }] }));
    const handlers = {};
    registerReviewBatchGate({ on: (event, fn) => { handlers[event] = fn; } }, file);
    const input = { tasks: scopes.map((scope) => ({ name: scope.id, agent: 'review-context-scout', task: 'inspect' })) };
    await handlers.tool_call({ toolName: 'task', toolCallId: 'batch', input });
    const results = [
      nativeResult(scopes[0], scout(scopes[0], { claims: [claim('b.md', 4)] })),
      nativeResult(scopes[1], scout(scopes[1])),
    ];
    const outcome = await handlers.tool_result({ toolName: 'task', toolCallId: 'batch', content: [], details: { results } });
    assert.equal(outcome.isError, undefined);
    assert.deepEqual(outcome.details.mergedScout.claims, [claim('b.md', 4)]);
    const events = (await readFile(`${file}.events`, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === 'task_retry'), false);
    assert.equal(events.at(-1).complete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
