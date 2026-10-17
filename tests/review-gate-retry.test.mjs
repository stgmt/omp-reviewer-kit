import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerReviewBatchGate } from '../src/infra/review-batch-extension.mjs';
import { OmpCliReviewerAdapter } from '../src/infra/omp-cli-reviewer-adapter.mjs';
import { ReviewPrompt } from '../src/domain/review-prompt.mjs';
import * as source from '../src/domain/review-batch.mjs';
import * as bundled from '../scripts/run-review.mjs';
import { OmpCliReviewerAdapter as BundledAdapter } from '../scripts/run-review.mjs';

const scoutData = (scope, extra = {}) => ({ change_goal: 'goal', changed_paths: scope.paths, reviewed_paths: scope.paths, invariants: ['owned contract'], relevant_consumers: [], test_evidence: [], test_harness: 'present', coverage_map: [], non_coverable_items: [], claims: [], declared_checks: [], unknowns: [], completion: { scope_id: scope.id, completed_paths: scope.paths, unresolved: [] }, ...extra });
const nativeResult = (name, agent, data) => ({ id: name, agent, exitCode: 0, structuredOutput: { status: 'valid', data } });
const hunterData = { coverage_summary: 'checked', candidates: [], coverage_gaps: [], suppressed_coverage_items: [] };

async function withGate(scouts, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-retry-gate-'));
  try {
    const file = path.join(root, 'manifest.json');
    const plan = { scouts, hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: [] }] };
    await writeFile(file, JSON.stringify({ schema: 'review-batch@1', invocationToken: 'test', prompt: 'source', ...plan }));
    const handlers = {};
    registerReviewBatchGate({ on: (event, fn) => { handlers[event] = fn; } }, file);
    const events = async () => (await readFile(`${file}.events`, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const scoutBatch = (names) => ({ tasks: names.map((name) => ({ name, agent: 'review-context-scout', task: 'inspect' })) });
    await body({ handlers, events, scoutBatch, scouts, file });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const threeScouts = [{ id: 'Scout1', paths: ['a'] }, { id: 'Scout2', paths: ['b'] }, { id: 'Scout3', paths: ['c'] }];
const scoutResults = (scopes, skip = []) => scopes.filter((scope) => !skip.includes(scope.id)).map((scope) => nativeResult(scope.id, 'review-context-scout', scoutData(scope)));

test('Given one scout of a batch fails natively, When the call is flagged as error, Then only that scout is dispatched again and its siblings are kept', async () => {
  await withGate(threeScouts, async ({ handlers, events, scoutBatch }) => {
    const all = ['Scout1', 'Scout2', 'Scout3'];
    assert.equal((await handlers.tool_call({ toolName: 'task', toolCallId: 'batch', input: scoutBatch(all) })).block, undefined);
    // OMP flags the whole call when one child fails and returns no result for it.
    const first = await handlers.tool_result({ toolName: 'task', toolCallId: 'batch', isError: true, content: [{ type: 'text', text: 'Task execution failed' }], details: { results: scoutResults(threeScouts, ['Scout2']) } });
    assert.equal(first.isError, undefined, 'a recoverable stage failure must not poison the review');
    assert.match(first.additionalContext, /1 native task\(s\) failed \(Scout2\)/);
    assert.doesNotMatch(first.additionalContext, /Scout1|Scout3/);
    assert.equal((await events()).some((event) => event.complete === false), false);

    const whole = await handlers.tool_call({ toolName: 'task', toolCallId: 'again-all', input: scoutBatch(all) });
    assert.equal(whole.block, true);
    assert.match(whole.reason, /One complete native batch required: Scout2$/);
    const hunterEarly = await handlers.tool_call({ toolName: 'task', toolCallId: 'hunt-early', input: { tasks: [{ name: 'Hunter-correctness', agent: 'review-risk-hunter', task: 'hunt' }] } });
    assert.match(hunterEarly.reason, /Scout must complete before hunting/);

    assert.equal((await handlers.tool_call({ toolName: 'task', toolCallId: 'retry', input: scoutBatch(['Scout2']) })).block, undefined);
    // OMP names a re-dispatched task with the next free id.
    const reissued = scoutResults(threeScouts).filter((result) => result.id === 'Scout2').map((result) => ({ ...result, id: 'Scout2-2' }));
    const done = await handlers.tool_result({ toolName: 'task', toolCallId: 'retry', content: [], details: { results: reissued } });
    assert.deepEqual(JSON.parse(done.content?.[0]?.text ?? 'null')?.completion?.scopes, ['Scout1', 'Scout2', 'Scout3']);
    const stage = (await events()).filter((event) => event.complete);
    assert.equal(stage.length, 1);
    assert.deepEqual(stage[0].tasks, ['Scout1', 'Scout2', 'Scout3']);
    assert.equal(stage[0].complete, true);

    const hunters = { tasks: [{ name: 'Hunter-correctness', agent: 'review-risk-hunter', task: 'hunt' }] };
    assert.equal((await handlers.tool_call({ toolName: 'task', toolCallId: 'hunt', input: hunters })).block, undefined);
    const doneAgain = await handlers.tool_call({ toolName: 'task', toolCallId: 'scout-after', input: scoutBatch(all) });
    assert.match(doneAgain.reason, /already complete/);
  });
});

test('Given a scout fails again after its retry, When the review ends, Then every failure is recorded and later dispatches name that cause', async () => {
  await withGate(threeScouts, async ({ handlers, events, scoutBatch }) => {
    const all = ['Scout1', 'Scout2', 'Scout3'];
    await handlers.tool_call({ toolName: 'task', toolCallId: 'batch', input: scoutBatch(all) });
    const failing = { id: 'Scout2', agent: 'review-context-scout', exitCode: 1, error: 'SECRET provider text', structuredOutput: { status: 'unavailable' } };
    await handlers.tool_result({ toolName: 'task', toolCallId: 'batch', isError: true, content: [], details: { results: [...scoutResults(threeScouts, ['Scout2']), failing] } });
    await handlers.tool_call({ toolName: 'task', toolCallId: 'retry', input: scoutBatch(['Scout2']) });
    const second = await handlers.tool_result({ toolName: 'task', toolCallId: 'retry', isError: true, content: [{ type: 'text', text: 'native text' }], details: { results: [{ ...failing, id: 'Scout2-2' }] } });
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /Native task failed again after its retry: Scout2/);
    assert.equal(second.content[1].text, 'native text');

    const recorded = (await events()).at(-1);
    assert.equal(recorded.complete, false);
    assert.equal(recorded.stage, 'review-context-scout');
    assert.equal(recorded.failureCount, 1);
    assert.deepEqual(recorded.failures, [{ task: 'Scout2', reason: 'Failed or mismatched native review result', exitCode: 1, errored: true }]);
    assert.doesNotMatch(JSON.stringify(recorded), /SECRET/, 'provider text must not be persisted');

    const later = await handlers.tool_call({ toolName: 'task', toolCallId: 'hunt', input: { tasks: [{ name: 'Hunter-correctness', agent: 'review-risk-hunter', task: 'hunt', schemaMode: 'strict' }] } });
    assert.equal(later.block, true);
    assert.match(later.reason, /Review already failed \(Native task failed again after its retry: Scout2\)/);
    assert.doesNotMatch(later.reason, /inherit/);
  });
});

test('Given the orchestrator task itself fails, When the result arrives, Then it is not retried', async () => {
  await withGate(threeScouts, async ({ handlers, events }) => {
    const input = { tasks: [{ name: 'ReviewerKit', agent: 'reviewer-kit', task: 'review' }] };
    assert.equal((await handlers.tool_call({ toolName: 'task', toolCallId: 'orchestrator', input })).block, undefined);
    const result = await handlers.tool_result({ toolName: 'task', toolCallId: 'orchestrator', isError: true, content: [], details: { results: [] } });
    assert.equal(result.isError, true);
    const recorded = (await events()).at(-1);
    assert.equal(recorded.complete, false);
    assert.equal(recorded.stage, 'reviewer-kit');
    assert.match(recorded.reason, /^Native task failed:/);
  });
});

test('Given an error flag while every task result is intact, When the stage is judged, Then it still fails without a retry', async () => {
  await withGate(threeScouts, async ({ handlers, events, scoutBatch }) => {
    await handlers.tool_call({ toolName: 'task', toolCallId: 'batch', input: scoutBatch(['Scout1', 'Scout2', 'Scout3']) });
    const result = await handlers.tool_result({ toolName: 'task', toolCallId: 'batch', isError: true, content: [], details: { results: scoutResults(threeScouts) } });
    assert.equal(result.isError, true);
    assert.equal((await events()).at(-1).reason, 'Native task failed');
  });
});

test('Given a scout reports unresolved obligations, When it is the first failure, Then that scout alone is retried with its reason recorded', async () => {
  await withGate(threeScouts, async ({ handlers, events, scoutBatch }) => {
    await handlers.tool_call({ toolName: 'task', toolCallId: 'batch', input: scoutBatch(['Scout1', 'Scout2', 'Scout3']) });
    const results = scoutResults(threeScouts);
    results[1] = nativeResult('Scout2', 'review-context-scout', scoutData(threeScouts[1], { completion: { scope_id: 'Scout2', completed_paths: ['b'], unresolved: ['caller not read'] } }));
    const first = await handlers.tool_result({ toolName: 'task', toolCallId: 'batch', content: [], details: { results } });
    assert.match(first.additionalContext, /\(Scout2\)/);
    const retry = (await events()).find((event) => event.event === 'task_retry');
    assert.deepEqual(retry.failures.map((item) => [item.task, item.reason]), [['Scout2', 'Unresolved scout obligations']]);
  });
});

test('Given far more failures than fit a record, When the review ends, Then the record is bounded and keeps the true count', async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `Scout${index + 1}`, paths: [`f${index}`] }));
  await withGate(many, async ({ handlers, events, scoutBatch }) => {
    const names = many.map((scope) => scope.id);
    for (const [index, id] of ['batch', 'retry'].entries()) {
      await handlers.tool_call({ toolName: 'task', toolCallId: id, input: scoutBatch(names) });
      const result = await handlers.tool_result({ toolName: 'task', toolCallId: id, isError: true, content: [], details: { results: [] } });
      assert.equal(result.isError, index === 1 ? true : undefined);
    }
    const recorded = (await events()).at(-1);
    assert.equal(recorded.failureCount, 40);
    assert.equal(recorded.failures.length, 32);
  });
});

for (const [label, domain] of [['source', source], ['bundle', bundled]]) {
  test(`${label}: Given results of a partly failed batch, When validating per task, Then successes stay usable and failures carry no model text`, () => {
    const input = { tasks: threeScouts.map((scope) => ({ name: scope.id, agent: 'review-context-scout' })) };
    const results = [...scoutResults(threeScouts, ['Scout2']), { id: 'Scout2', agent: 'review-context-scout', exitCode: 2, aborted: true, error: 'PRIVATE', structuredOutput: { status: 'valid', data: scoutData(threeScouts[1]) } }];
    const { valid, failures } = domain.validateBatchTasks(input, { results }, null, threeScouts);
    assert.deepEqual([...valid.keys()], ['Scout1', 'Scout3']);
    assert.deepEqual(failures, [{ task: 'Scout2', reason: 'Failed or mismatched native review result', exitCode: 2, aborted: true, errored: true }]);
    assert.deepEqual(domain.validateBatchTasks(input, { results: [...results, results[0]] }, null).failures.map((item) => [item.task, item.reason]), [['Scout1', 'Duplicate native result for task'], ['Scout2', 'Failed or mismatched native review result']]);
    assert.equal(domain.validateBatchTasks(input, undefined).failures.length, 3);
    const unresolved = scoutResults(threeScouts);
    unresolved[0] = nativeResult('Scout1', 'review-context-scout', scoutData(threeScouts[0], { completion: { scope_id: 'Scout1', completed_paths: ['a'], unresolved: ['caller not read'] } }));
    assert.deepEqual(domain.validateBatchTasks(input, { results: unresolved }, null, threeScouts).failures.map((item) => [item.task, item.reason]), [['Scout1', 'Unresolved scout obligations']]);
    assert.equal(domain.validateBatchTasks(input, { results: unresolved }, null).failures.length, 0, 'without scopes only the native contract is judged');
    assert.equal(domain.describeTaskFailure('T', undefined, new Error('x'.repeat(500))).reason.length, 200);
  });

  test(`${label}: Given OMP re-issues the id of a dispatched name, When matching results, Then the suffixed id belongs to that task alone`, () => {
    const scoutAgent = 'review-context-scout';
    const one = { tasks: [{ name: 'Scout2', agent: scoutAgent }] };
    const second = scoutResults(threeScouts).filter((result) => result.id === 'Scout2');
    for (const parentId of [null, 'Parent']) {
      const prefix = parentId ? `${parentId}.` : '';
      const named = (id) => second.map((result) => ({ ...result, id: `${prefix}${id}` }));
      assert.deepEqual([...domain.validateBatchTasks(one, { results: named('Scout2-2') }, parentId, threeScouts).valid.keys()], ['Scout2']);
      assert.deepEqual([...domain.validateBatchTasks(one, { results: named('Scout2-17') }, parentId, threeScouts).valid.keys()], ['Scout2']);
      for (const id of ['Scout2-x', 'Scout2-', 'Scout22', 'xScout2-2', 'Scout2-2-2']) {
        assert.equal(domain.validateBatchTasks(one, { results: named(id) }, parentId, threeScouts).failures.length, 1, id);
      }
    }
    // A planned task that really carries a suffixed name keeps its own result.
    const both = { tasks: [{ name: 'Scout1', agent: scoutAgent }, { name: 'Scout1-2', agent: scoutAgent }] };
    const scopes = [{ id: 'Scout1', paths: ['a'] }, { id: 'Scout1-2', paths: ['b'] }];
    const onlySuffixed = [nativeResult('Scout1-2', scoutAgent, scoutData(scopes[1]))];
    const judged = domain.validateBatchTasks(both, { results: onlySuffixed }, null, scopes);
    assert.deepEqual([...judged.valid.keys()], ['Scout1-2']);
    assert.deepEqual(judged.failures.map((item) => [item.task, item.reason]), [['Scout1', 'No native result for task']]);
  });

  test(`${label}: Given completed tasks, When gating a retry, Then only the remainder is accepted`, () => {
    const manifest = { prompt: 'source', invocationToken: 'test', scouts: threeScouts, hunters: [] };
    const retry = { tasks: [{ name: 'Scout2', agent: 'review-context-scout', task: 'inspect' }] };
    const completed = new Set(['Scout1', 'Scout3']);
    // A wrongly rejected retry must surface as a failed assertion, not as an exception.
    const accepted = (input, options) => { try { return domain.gateReviewBatch(input, manifest, options).tasks.map((task) => task.name); } catch (error) { return `rejected: ${error.message}`; } };
    assert.deepEqual(accepted(retry, { completed }), ['Scout2']);
    assert.throws(() => domain.gateReviewBatch({ tasks: threeScouts.map((scope) => ({ name: scope.id, agent: 'review-context-scout' })) }, manifest, { completed }), /One complete native batch required: Scout2/);
    assert.throws(() => domain.gateReviewBatch(retry, manifest, { completed: new Set(['Scout1', 'Scout2', 'Scout3']) }), /already complete/);
    assert.throws(() => domain.gateReviewBatch({ ...retry.tasks[0], name: 'Scout1' }, manifest, { batchEnabled: false, completed }), /One planned flat task required/);
  });
}

for (const [label, Adapter] of [['source', OmpCliReviewerAdapter], ['bundle', BundledAdapter]]) {
  test(`${label}: Given a review that ends on a repeated scout failure, When the session is gone, Then the report text names the stage, tasks and gate rejections`, async () => {
    const adapter = new Adapter({ nativeBatch: true, runner: async (_prompt, _cwd, _timeout, options) => {
      const file = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
      const handlers = {};
      registerReviewBatchGate({ on: (event, handler) => { handlers[event] = handler; } }, file);
      const input = { tasks: [{ name: 'Scout1', agent: 'review-context-scout', task: 'inspect' }] };
      for (const id of ['first', 'second']) {
        await handlers.tool_call({ toolName: 'task', toolCallId: id, input });
        await handlers.tool_result({ toolName: 'task', toolCallId: id, isError: true, content: [], details: { results: [] } });
      }
      await handlers.tool_call({ toolName: 'task', toolCallId: 'late', input: { tasks: [{ name: 'Hunter-correctness', agent: 'review-risk-hunter', schemaMode: 'strict' }] } });
      return { status: 0, stdout: 'REVIEW_RESULT=PASS', stderr: '' };
    } });
    const plan = { scouts: [{ id: 'Scout1', paths: ['a'] }], hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: [] }] };
    const result = await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), '', [], { batchPlan: plan }), cwd: process.cwd() });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Review stage failures:\nreview-context-scout: Native task failed again after its retry: Scout1/);
    assert.match(result.stderr, /Native task failures:\n\{"task":"Scout1","reason":"No native result for task"\}/);
    assert.match(result.stderr, /Native task retries:\n\{"task":"Scout1"/);
    assert.match(result.stderr, /Gate rejections:\nReview already failed \(Native task failed again after its retry: Scout1\)/);
  });
}
