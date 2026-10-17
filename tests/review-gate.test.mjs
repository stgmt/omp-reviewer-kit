import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerReviewBatchGate } from '../src/infra/review-batch-extension.mjs';
import { OmpCliReviewerAdapter } from '../src/infra/omp-cli-reviewer-adapter.mjs';
import { ReviewPrompt } from '../src/domain/review-prompt.mjs';
import { ReviewRejectionEnvelope } from '../src/domain/review-rejection-envelope.mjs';
import { OmpCliReviewerAdapter as BundledAdapter } from '../scripts/run-review.mjs';

const verifiedFinding = { candidate_id: 'c1', lane: 'correctness', priority: 'P2', title: 'Wrong calculation', file_path: 'src/a.mjs', line_start: 1, line_end: 2, observed_behavior: 'Returns zero', expected_behavior: 'Returns the sum', trigger_scenario: 'add(1, 2) returns 0 instead of 3', impact: 'Caller receives a wrong total', evidence: ['src/a.mjs:1-2'] };
const verifiedData = { coverage_summary: 'Inspected changed calculation and caller', decisions: [{ candidate_id: 'c1', disposition: 'confirmed', triage: 'not_applicable', reason: 'Reachable wrong total', evidence: 'src/a.mjs:1-2' }], confirmed_findings: [verifiedFinding], confirmed_coverage_gaps: [], rejected_coverage_gaps: [] };

for (const [label, Adapter] of [['source', OmpCliReviewerAdapter], ['bundle', BundledAdapter]]) {
  for (const scenario of ['valid', 'nonzero', 'timeout', 'incomplete', 'foreign', 'duplicate', 'malformed', 'still-present-missing']) {
    test(`${label}: Given native verified findings ${scenario}, Then preserve a substantive BLOCK only with complete successful provenance`, async () => {
      const adapter = new Adapter({ nativeBatch: true, runner: async (_prompt, _cwd, _timeout, options) => {
        const file = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(await readFile(`${file}.config.yml`, 'utf8'), 'task:\n  structured: true\n');
        const data = structuredClone(verifiedData);
        if (scenario === 'malformed') data.confirmed_findings[0].observed_behavior = '';
        if (scenario === 'still-present-missing') { data.decisions[0].disposition = 'still_present'; data.confirmed_findings = []; }
        const events = [
          { stage: 'review-context-scout', complete: true, mergedScout: { test_harness: 'present' } },
          { stage: 'review-risk-hunter', complete: true, requiresVerifier: true },
          { stage: 'review-finding-verifier', complete: true, blocksApproval: true, verifierData: data },
          { stage: 'reviewer-kit', complete: scenario !== 'incomplete' },
        ];
        if (scenario === 'duplicate') events.push(events[2]);
        await writeFile(`${file}.events`, events.map((event) => JSON.stringify({ invocationToken: scenario === 'foreign' ? 'foreign' : manifest.invocationToken, ...event })).join('\n'));
        return { status: scenario === 'nonzero' ? 7 : 0, timedOut: scenario === 'timeout', stdout: 'Original synthesis\nREVIEW_RESULT=PASS', stderr: '' };
      } });
      const result = await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), '', [], { batchPlan: plan }), cwd: process.cwd() });
      const normalized = ReviewRejectionEnvelope.evaluate({ output: result.stdout, diffIdentity: 'a'.repeat(64), processStatus: result.status });
      assert.equal(normalized.verdict.isPass(), false);
      assert.equal(normalized.envelope.kind, scenario === 'valid' ? 'confirmed_findings' : 'review_failure');
      if (scenario === 'valid') {
        assert.equal(result.status, 0, 'a completed child emits a substantive BLOCK, not an infrastructure failure');
        assert.equal(normalized.envelope.findings[0].counterexample, verifiedFinding.trigger_scenario);
        assert.match(normalized.envelope.findings[0].verifier_argument, /Returns zero.*Returns the sum/);
      }
    });
  }
}

for (const [label, Adapter] of [['source', OmpCliReviewerAdapter], ['bundle', BundledAdapter]]) {
  for (const blocked of ['findings', 'coverage', 'missing-disposition']) {
    test(`${label}: Given verifier ${blocked}, When synthesis incorrectly returns PASS, Then completion evidence blocks approval`, async () => {
      const adapter = new Adapter({ nativeBatch: true, runner: async (_prompt, _cwd, _timeout, options) => {
        const file = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        const events = [
          { stage: 'review-context-scout', complete: true },
          { stage: 'review-risk-hunter', complete: true, requiresVerifier: true },
          { stage: 'review-finding-verifier', complete: blocked !== 'missing-disposition', blocksApproval: blocked !== 'missing-disposition' },
          { stage: 'reviewer-kit', complete: true },
        ];
        await writeFile(`${file}.events`, events.map((e) => JSON.stringify({ invocationToken: manifest.invocationToken, ...e })).join('\n'));
        return { status: 0, stdout: 'REVIEW_RESULT=PASS', stderr: '' };
      } });
      const result = await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), '', [], { batchPlan: plan }), cwd: process.cwd() });
      assert.equal(result.status, 1);
    });
  }
}

for (const [label, Adapter] of [['source', OmpCliReviewerAdapter], ['bundle', BundledAdapter]]) {
  test(`${label}: Given invalid native scout output, When the session is removed, Then bounded schema diagnostics survive in stderr`, async () => {
    const adapter = new Adapter({ nativeBatch: true, runner: async (_prompt, _cwd, _timeout, options) => {
      const file = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      const handlers = {};
      registerReviewBatchGate({ on: (event, handler) => { handlers[event] = handler; } }, file);
      const invalid = { id: 'Scout1', agent: 'review-context-scout', exitCode: 0, structuredOutput: { status: 'invalid', source: 'agent', mode: 'permissive', data: { private_payload: 'DO_NOT_LOG' }, error: 'coverage_map.0.line_start: expected integer; secret=DO_NOT_LOG https://private.invalid/account' } };
      const dispatch = (toolCallId) => handlers.tool_call({ toolName: 'task', toolCallId, input: { tasks: [{ name: 'Scout1', agent: 'review-context-scout', task: 'inspect' }] } });
      await dispatch('scout');
      const first = await handlers.tool_result({ toolName: 'task', toolCallId: 'scout', content: [], details: { results: [invalid] } });
      assert.equal(first.isError, undefined, 'the first failure of a task is retried, not final');
      assert.equal((await dispatch('scout-retry')).block, undefined);
      const output = await handlers.tool_result({ toolName: 'task', toolCallId: 'scout-retry', content: [], details: { results: [invalid] } });
      assert.equal(output.isError, true);
      const raw = await readFile(`${file}.events`, 'utf8');
      const events = raw.trim().split('\n').map((line) => JSON.parse(line));
      const event = events.at(-1);
      assert.equal(event.complete, false);
      assert.deepEqual(event.diagnostic, { task: 'Scout1', status: 'invalid', source: 'agent', mode: 'permissive', reason: 'schema_validation', field: 'coverage_map.0.line_start' });
      assert.equal(events.at(-2).event, 'task_retry');
      assert.deepEqual(events.at(-2).failures[0].diagnostic, event.diagnostic);
      assert.doesNotMatch(raw, /DO_NOT_LOG|private_payload|private\.invalid/);
      assert.equal(event.invocationToken, manifest.invocationToken);
      return { status: 0, stdout: 'REVIEW_RESULT=PASS', stderr: '' };
    } });
    const result = await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), '', [], { batchPlan: plan }), cwd: process.cwd() });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Native output diagnostics:\n\{"task":"Scout1","status":"invalid".*"field":"coverage_map\.0\.line_start"\}/);
    assert.match(result.stderr, /Native task failures:\n.*"task":"Scout1".*"reason":"Invalid specialist output/);
    assert.match(result.stderr, /Native task retries:\n.*"task":"Scout1"/);
    assert.doesNotMatch(result.stderr, /DO_NOT_LOG|private_payload|private\.invalid/);
  });
}

const plan = { scouts: [{ id: 'Scout1', paths: ['a'] }], hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: [] }] };
test('Given no invocation manifest, When registering gate, Then ordinary sessions are untouched', () => {
  let registrations = 0;
  registerReviewBatchGate({ on: () => registrations++ }, '');
  assert.equal(registrations, 0);
});

test('Given a review invocation, When checking tasks and outputs, Then gates precede dispatch and errors remain visible', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-gate-'));
  try {
    const file = path.join(root, 'manifest.json');
    await writeFile(file, JSON.stringify({ schema: 'review-batch@1', invocationToken: 'test', prompt: 'source', ...plan }));
    const handlers = {};
    const pi = { on: (event, fn) => { handlers[event] = fn; } };
    registerReviewBatchGate(pi, file);
    assert.equal((await handlers.tool_call({ toolName: 'write' })).block, true);
    assert.equal((await handlers.tool_call({ toolName: 'task', input: { tasks: [{ name: 'Wrong', agent: 'review-context-scout' }] } })).block, true);
    const input = { tasks: [{ name: 'Scout1', agent: 'review-context-scout', task: 'scout' }] };
    const revised = await handlers.tool_call({ toolName: 'task', toolCallId: 'x', input });
    assert.match(revised.input.context, /source/);
    const first = await handlers.tool_result({ toolName: 'task', toolCallId: 'x', details: { results: [] }, content: [{ type: 'text', text: 'native preflight explanation' }] });
    assert.equal(first.isError, undefined);
    assert.match(first.additionalContext, /Scout1.*once more/);
    assert.equal((await handlers.tool_call({ toolName: 'task', toolCallId: 'y', input })).block, undefined);
    const output = await handlers.tool_result({ toolName: 'task', toolCallId: 'y', details: { results: [] }, content: [{ type: 'text', text: 'native preflight explanation' }] });
    assert.equal(output.isError, true);
    assert.equal(output.content[1].text, 'native preflight explanation');
    const events = (await readFile(`${file}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const event = events.at(-1);
    assert.equal(event.complete, false);
    assert.match(event.reason, /Native task failed again after its retry: Scout1/);
    assert.match(events.find((e) => e.event === 'dispatch_rejected')?.reason ?? '', /complete native batch/);
    const masked = await handlers.tool_call({ toolName: 'task', toolCallId: 'z', input: { tasks: [{ name: 'Hunter-correctness', agent: 'review-risk-hunter', model: 'forbidden' }] } });
    assert.equal(masked.block, true);
    assert.match(masked.reason, /Review already failed \(Native task failed again after its retry: Scout1\)/);
    assert.doesNotMatch(masked.reason, /inherit/);
    for (let i = 0; i < 2; i++) await handlers.tool_result({ toolName: 'yield', isError: true });
    assert.match((await handlers.tool_call({ toolName: 'yield', input: { data: {} } })).input.error, /Repeated invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given authoritative hunter outputs, When verifier confirms or omits them, Then gate records blocking evidence or failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-verifier-gate-'));
  try {
    for (const disposition of ['confirmed', 'rejected', 'missing', 'coverage', 'non-coverable', 'previous-fixed', 'previous-still', 'previous-missing']) {
      const file = path.join(root, `${disposition}.json`);
      const previous = disposition.startsWith('previous-');
      const coverage = disposition === 'coverage' || disposition === 'non-coverable';
      await writeFile(file, JSON.stringify({ schema: 'review-batch@1', invocationToken: 'test', prompt: 'source', ...plan, previousFindings: previous ? [{ id: 'old1' }] : [] }));
      const handlers = {};
      registerReviewBatchGate({ on: (event, fn) => { handlers[event] = fn; } }, file);
      const dispatch = async (name, agent, data) => {
        const call = { toolName: 'task', toolCallId: name, input: { tasks: [{ name, agent, task: 'inspect' }] } };
        const gated = await handlers.tool_call(call);
        assert.equal(gated.block, undefined, gated.reason);
        const result = await handlers.tool_result({ toolName: 'task', toolCallId: name, content: [], details: { results: [{ id: name, agent, exitCode: 0, structuredOutput: { status: 'valid', data } }] } });
        return { gated, result };
      };
      await dispatch('Scout1', 'review-context-scout', { change_goal: 'goal', changed_paths: ['a'], reviewed_paths: ['a'], invariants: ['owned contract'], relevant_consumers: [], test_evidence: [], test_harness: disposition === 'non-coverable' ? 'absent' : 'present', coverage_map: [], non_coverable_items: [], claims: [], declared_checks: [], unknowns: [], completion: { scope_id: 'Scout1', completed_paths: ['a'], unresolved: [] } });
      await dispatch('Hunter-correctness', 'review-risk-hunter', { coverage_summary: 'checked', candidates: coverage || previous ? [] : [{ candidate_id: 'c1', lane: 'correctness' }], coverage_gaps: coverage ? [{ coverage_id: 'g1' }] : [], suppressed_coverage_items: [] });
      const missing = disposition === 'missing' || disposition === 'previous-missing';
      const decisions = missing || coverage ? [] : previous ? [{ candidate_id: 'old1', disposition: disposition === 'previous-fixed' ? 'fixed' : 'still_present' }] : [{ candidate_id: 'c1', disposition }];
      const { gated, result } = await dispatch('Verifier', 'review-finding-verifier', { coverage_summary: 'checked', decisions, confirmed_findings: disposition === 'confirmed' ? [{ candidate_id: 'c1' }] : [], confirmed_coverage_gaps: coverage ? [{ coverage_id: 'g1' }] : [], rejected_coverage_gaps: [] });
      assert.match(gated.input.context, /Authoritative completed hunter outputs/);
      assert.match(gated.input.context, previous ? /old1/ : coverage ? /g1/ : /c1/);
      const event = (await readFile(`${file}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1);
      if (missing) {
        assert.equal(result?.isError, true);
        assert.equal(event.complete, false);
      } else {
        assert.equal(event.complete, true);
        assert.equal(event.blocksApproval, ['confirmed', 'coverage', 'previous-still'].includes(disposition));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given two planned flat scouts, When only one finishes, Then hunting stays blocked until the merged scope is complete', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-flat-gate-'));
  try {
    const file = path.join(root, 'manifest.json');
    const scouts = [{ id: 'Scout1', paths: ['a'] }, { id: 'Scout2', paths: ['b'] }];
    await writeFile(file, JSON.stringify({ schema: 'review-batch@1', invocationToken: 'test', prompt: 'source', ...plan, scouts }));
    const handlers = {};
    registerReviewBatchGate({ on: (event, fn) => { handlers[event] = fn; }, getAllTools: () => [{ name: 'task', parameters: { properties: { task: {} } } }] }, file);
    for (const [index, scope] of scouts.entries()) {
      const call = { toolName: 'task', toolCallId: scope.id, input: { name: scope.id, agent: 'review-context-scout', task: 'inspect' } };
      const gated = await handlers.tool_call(call);
      assert.equal(gated.input.tasks, undefined);
      assert.equal(gated.input.context, undefined);
      const data = { change_goal: 'goal', changed_paths: scope.paths, reviewed_paths: scope.paths, invariants: ['owned contract'], relevant_consumers: [], test_evidence: [], test_harness: 'present', coverage_map: [], non_coverable_items: [], claims: [], declared_checks: [], unknowns: [], completion: { scope_id: scope.id, completed_paths: scope.paths, unresolved: [] } };
      await handlers.tool_result({ toolName: 'task', toolCallId: scope.id, content: [], details: { results: [{ id: scope.id, agent: 'review-context-scout', exitCode: 0, structuredOutput: { status: 'valid', data } }] } });
      if (index === 0) {
        const blocked = await handlers.tool_call({ toolName: 'task', toolCallId: 'hunter', input: { name: 'Hunter-correctness', agent: 'review-risk-hunter', task: 'hunt' } });
        assert.equal(blocked.block, true);
      }
    }
    const events = (await readFile(`${file}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.stage);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].mergedScout.completion.scopes, ['Scout1', 'Scout2']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given PASS stdout but missing mandatory native stages, When the real batch integration is enabled, Then the process result blocks', async () => {
  const adapter = new OmpCliReviewerAdapter({ nativeBatch: true, runner: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS' }) });
  const result = await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), '', [], { batchPlan: plan }), cwd: process.cwd() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /batch incomplete/);
});
