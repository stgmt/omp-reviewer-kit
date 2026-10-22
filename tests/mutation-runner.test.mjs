import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPool, classifyTestRun, captureTree, restoreTree, runTest, runMutationGate, findStaleMutants, mergeCalibration, mutantIdentity, testFileHash } from '../scripts/mutation-runner.mjs';

test('Given two mutants of one behavior, When calibrated with reusable workers, Then all IDs have reference and focused assertion proof', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-gate-test-'));
  try {
    for (const directory of ['src', 'scripts', 'agents', 'skills', 'tests', 'templates', '.omp-plugin', '.omp/review-kit', '.claude-plugin', 'claude-plugin', '.github', '.specs/native-task-review']) await mkdir(path.join(root, directory), { recursive: true });
    for (const file of ['package.json', 'README.md', 'AGENTS.md', 'ROADMAP.md', 'CHANGELOG.md']) await writeFile(path.join(root, file), file === 'package.json' ? '{"type":"module"}' : 'fixture');
    await writeFile(path.join(root, 'src', 'value.mjs'), 'export const value = 1;');
    await writeFile(path.join(root, '.specs/native-task-review', 'REQUIREMENTS.md'), 'native task requirements fixture');
    await writeFile(path.join(root, 'tests', 'value.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import {value} from '../src/value.mjs'; test('value contract',async()=>{assert.equal(await readFile('.specs/native-task-review/REQUIREMENTS.md','utf8'),'native task requirements fixture'); assert.equal(value,1);});");
    const mutants = [2, 3].map((value) => ({ id: `value-${value}`, file: 'src/value.mjs', testFile: 'tests/value.test.mjs', original: 'value = 1', replacement: `value = ${value}` }));
    const result = await runMutationGate(mutants, { root, workers: 2, calibrate: true, log: () => {} });
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 2);
    assert.equal(Object.keys(result.mappings).length, 2);
    assert.ok(result.maxActive <= 2 && result.maxActive > 1);
    assert.ok(result.timings.testMs > 0 && result.timings.resetMs >= 0);
    const focused = await runMutationGate(mutants, { root, workers: 2, selectors: result.mappings, log: () => {} });
    assert.equal(focused.passed, true);
    const stale = { ...result.mappings, 'value-2': { ...result.mappings['value-2'], mutantHash: 'stale' } };
    await assert.rejects(runMutationGate(mutants, { root, selectors: stale, log: () => {} }), /stale selector/);
    assert.equal(await readFile(path.join(root, 'src/value.mjs'), 'utf8'), 'export const value = 1;');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given missing, duplicate or escaping catalog entries, When admitted, Then the gate rejects them before copying', async () => {
  for (const mutants of [[], [{ id: 'same' }, { id: 'same' }], [{ id: 'escape', file: '../outside', testFile: 'test.mjs' }]]) {
    await assert.rejects(runMutationGate(mutants, { log: () => {} }), mutants.length === 2 ? /duplicate mutant IDs/ : /catalog|paths/);
  }
});

test('Given one worker failure, When others are active, Then the pool drains before propagating the error', async () => {
  let active = 0;
  await assert.rejects(runPool([{ id: 0 }, { id: 1 }], 2, async (job) => {
    if (job.id === 0) { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error('fixture'); }
    active++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
  }), /fixture/);
  assert.equal(active, 0);
});

test('Given an invalid import, When native tests execute, Then process failure is not a mutation kill', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-import-test-'));
  try {
    await writeFile(path.join(root, 'test.mjs'), "import './missing.mjs';");
    const result = await runTest(root, 'test.mjs');
    assert.notEqual(classifyTestRun(result), 'killed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given a hung test process, When timed out, Then it closes and timeout cannot count as a kill', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-timeout-test-'));
  try {
    await writeFile(path.join(root, 'test.mjs'), "import {test} from 'node:test'; test('hung',async()=>{await new Promise(()=>{});}); setInterval(()=>{},1000);");
    const result = await runTest(root, 'test.mjs', [], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.equal(classifyTestRun(result), 'timeout');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given parallel and exclusive jobs, When pooled, Then four workers overlap but exclusive jobs drain all work', async () => {
  let active = 0;
  let max = 0;
  const completed = [];
  await runPool([...Array.from({ length: 8 }, (_, id) => ({ id })), { id: 'exclusive', exclusive: true }, { id: 'last' }], 4, async (job) => {
    active++;
    max = Math.max(max, active);
    if (job.exclusive) assert.equal(active, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    completed.push(job.id);
    active--;
  });
  assert.equal(max, 4);
  assert.equal(completed.length, 10);
  assert.equal(new Set(completed).size, 10);
  assert.equal(completed[8], 'exclusive');
});

test('Given same leaf names in different suites, When selected by ancestry, Then only the intended contract executes', { skip: Number(process.versions.node.split('.')[0]) < 22 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-ancestry-test-'));
  try {
    await writeFile(path.join(root, 'test.mjs'), "import {describe,it} from 'node:test'; import assert from 'node:assert/strict'; describe('owned',()=>it('same',()=>assert.equal(1,2))); describe('foreign owned',()=>it('same',()=>{throw new Error('wrong scope');}));");
    const result = await runTest(root, 'test.mjs', ['same'], { ancestors: ['owned'] });
    assert.equal(classifyTestRun(result, ['same']), 'killed', JSON.stringify(result));
    assert.equal(result.events.filter((event) => ['test:pass', 'test:fail'].includes(event.type) && !event.suite && !event.skipped).length, 1);
    assert.deepEqual(result.events.find((event) => event.name === 'same' && !event.skipped).ancestors, ['owned']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given process and test evidence, When classified, Then only an expected assertion proves a kill', () => {
  const pass = { type: 'test:pass', name: 'contract', suite: false, skipped: false };
  const fail = { ...pass, type: 'test:fail', code: 'ERR_TEST_FAILURE', causeCode: 'ERR_ASSERTION' };
  assert.equal(classifyTestRun({ status: 1, events: [fail] }, ['contract']), 'killed');
  assert.equal(classifyTestRun({ status: 0, events: [pass] }, ['contract']), 'survived');
  assert.equal(classifyTestRun({ status: 1, events: [fail, { ...fail, ancestors: ['foreign'] }] }, ['contract']), 'selector_invalid');
  assert.equal(classifyTestRun({ status: 1, events: [fail], requireSummary: true }, ['contract']), 'infrastructure_error');
  assert.equal(classifyTestRun({ status: 1, events: [fail, { type: 'test:summary', counts: { tests: 1, cancelled: 1 } }], requireSummary: true }, ['contract']), 'infrastructure_error');
  for (const run of [{ status: 1, events: [] }, { status: 1, events: [{ ...fail, causeCode: undefined }] }, { status: 0, events: [{ ...pass, skipped: true }] }, { status: 1, events: [fail], timedOut: true }, { status: null, events: [fail], signal: 'SIGTERM' }, { status: 1, events: [{ ...fail, name: 'unrelated' }] }]) {
    assert.notEqual(classifyTestRun(run, ['contract']), 'killed');
    assert.notEqual(classifyTestRun(run, ['contract']), 'survived');
  }
});

test('Given a dirty reusable tree, When restored, Then changes, deletions and new paths cannot leak to the next job', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-reset-test-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.mjs'), 'original');
    await writeFile(path.join(root, 'deleted'), 'keep');
    const baseline = await captureTree(root);
    await writeFile(path.join(root, 'src', 'a.mjs'), 'mutated');
    await rm(path.join(root, 'deleted'));
    await mkdir(path.join(root, 'new'));
    await writeFile(path.join(root, 'new', 'artifact'), 'foreign state');
    await assert.doesNotReject(() => restoreTree(root, baseline), 'dirty worker must be restored before reuse');
    assert.deepEqual(await captureTree(root), baseline);
    assert.equal(await readFile(path.join(root, 'deleted'), 'utf8'), 'keep');
    await rm(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src'), 'directory replaced by file');
    await assert.doesNotReject(() => restoreTree(root, baseline), 'type replacement must restore descendants');
    assert.deepEqual(await captureTree(root), baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given an inherited test context and persistent paths, When a job starts, Then native subprocess state is isolated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-env-test-'));
  const nativeKeys = ['OMP_REVIEW_KIT_NATIVE_CLI', 'OMP_REVIEW_KIT_NATIVE_RUNTIME', 'OMP_REVIEW_KIT_NATIVE_KEEP'];
  const original = new Map(nativeKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of nativeKeys) process.env[key] = 'unapproved-native-fixture';
    await writeFile(path.join(root, 'test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import os from 'node:os'; import path from 'node:path'; test('isolated',()=>{ for(const key of ['OMP_REVIEW_KIT_RUNS_DIR','OMP_REVIEW_KIT_TARGETS','OMP_REVIEW_KIT_REPORTS_DIR']) assert.ok(process.env[key]?.startsWith(os.tmpdir()+path.sep)); for(const key of ['OMP_REVIEW_KIT_NATIVE_CLI','OMP_REVIEW_KIT_NATIVE_RUNTIME','OMP_REVIEW_KIT_NATIVE_KEEP']) assert.equal(process.env[key],undefined,'A mutant must never inherit an opt-in native launch'); });");
    const result = await runTest(root, 'test.mjs', ['isolated']);
    assert.equal(classifyTestRun(result, ['isolated']), 'survived', JSON.stringify(result));
    assert.ok(!result.events.some((event) => event.message?.includes('startsWith')));
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a native nested test, When selected precisely, Then reporter proves the deciding assertion instead of a suite heading', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-selector-test-'));
  try {
    await writeFile(path.join(root, 'test.mjs'), "import { describe, it } from 'node:test'; import assert from 'node:assert/strict'; describe('parent',()=>{ it('contract',()=>assert.equal(1,2)); it('unrelated',()=>{throw new Error('must not run');}); });");
    const result = await runTest(root, 'test.mjs', ['contract'], { timeoutMs: 5000, ancestors: ['parent'] });
    if (Number(process.versions.node.split('.')[0]) < 22) {
      assert.equal(classifyTestRun(result, ['contract']), 'infrastructure_error');
      assert.match(result.error, /require Node 22/);
      return;
    }
    assert.equal(classifyTestRun(result, ['contract']), 'killed');
    assert.ok(result.events.some((event) => event.name === 'contract' && event.causeCode === 'ERR_ASSERTION'));
    assert.ok(!result.events.some((event) => event.name === 'unrelated' && !event.skipped));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given a selector catalog after an edit, When stale entries are looked up, Then only mutants with a missing, moved or outdated selector need calibration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-stale-test-'));
  try {
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'tests', 'a.test.mjs'), 'a\r\ntest\r\n');
    await writeFile(path.join(root, 'tests', 'b.test.mjs'), 'b test\n');
    const mutant = (id, testFile, replacement = 'x') => ({ id, file: 'src/a.mjs', testFile, original: 'o', replacement });
    const fresh = mutant('fresh', 'tests/a.test.mjs');
    const moved = mutant('moved', 'tests/a.test.mjs');
    const edited = mutant('edited', 'tests/a.test.mjs');
    const changedTest = mutant('changed-test', 'tests/b.test.mjs');
    const missing = mutant('missing', 'tests/b.test.mjs');
    const aHash = testFileHash('a\ntest\n');
    const mapping = (m, over = {}) => ({ testFile: m.testFile, tests: ['t'], ancestors: [], mutantHash: mutantIdentity(m), testHash: m.testFile === 'tests/a.test.mjs' ? aHash : testFileHash('b test\n'), ...over });
    const mappings = {
      fresh: mapping(fresh),
      moved: mapping(moved, { testFile: 'tests/b.test.mjs' }),
      edited: mapping(edited, { mutantHash: mutantIdentity(mutant('edited', 'tests/a.test.mjs', 'y')) }),
      'changed-test': mapping(changedTest, { testHash: 'outdated' }),
      emptied: mapping(mutant('emptied', 'tests/a.test.mjs'), { tests: [] }),
    };
    const stale = await findStaleMutants([fresh, moved, edited, changedTest, missing], mappings, root);
    assert.deepEqual(stale.map((m) => m.id), ['moved', 'edited', 'changed-test', 'missing']);
    assert.deepEqual((await findStaleMutants([mutant('emptied', 'tests/a.test.mjs')], mappings, root)).map((m) => m.id), ['emptied']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given a partial calibration, When merged, Then fresh selectors win, removed mutants are dropped and a mutant left without any selector is an error', () => {
  const mutants = [{ id: 'kept' }, { id: 'recalibrated' }];
  const previous = { kept: { tests: ['old-kept'] }, recalibrated: { tests: ['old'] }, removed: { tests: ['gone'] } };
  // A merge that throws must fail on an assertion (a thrown error would be an infrastructure error of the mutation gate).
  const attempt = (...args) => { try { return mergeCalibration(...args); } catch (error) { return { threw: error.message }; } };
  const merged = attempt(mutants, previous, { recalibrated: { tests: ['new'] } });
  assert.deepEqual(merged, { kept: { tests: ['old-kept'] }, recalibrated: { tests: ['new'] } });
  assert.deepEqual(Object.keys(merged), ['kept', 'recalibrated']);
  // Existing entries keep the catalog's order, whatever the order of the mutants; new ones follow.
  const reordered = attempt([{ id: 'new-mutant' }, ...mutants.slice().reverse()], previous, { 'new-mutant': { tests: ['n'] } });
  assert.deepEqual(Object.keys(reordered), ['kept', 'recalibrated', 'new-mutant']);
  assert.throws(() => mergeCalibration([...mutants, { id: 'new-mutant' }], previous, {}), /No selector for new-mutant/);
  // A partial calibration keeps what was proven and leaves the rest without a selector, so the gate still refuses the incomplete catalog.
  const partial = attempt([...mutants, { id: 'new-mutant' }], previous, { recalibrated: { tests: ['new'] } }, { complete: false });
  assert.deepEqual(partial, { kept: { tests: ['old-kept'] }, recalibrated: { tests: ['new'] } });
});
