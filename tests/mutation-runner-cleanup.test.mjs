import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureTree, FULL_SUITE_TIMEOUT_MS, mutantIdentity, REMOVE_OPTIONS, removeTree, restoreTree, runCli, runMutationGate, runTest, testFileHash } from '../scripts/mutation-runner.mjs';

const TEST_BODY = "import test from 'node:test';\ntest('x', () => {});\n";
const mutant = (id) => ({ id, file: 'src/x.mjs', testFile: `tests/${id}.test.mjs`, original: `a-${id}`, replacement: `b-${id}`, description: id });

// The gate copies these entries into every worker, so a fixture carries all of them (they mirror DIRECTORIES_TO_COPY and FILES_TO_COPY).
const FIXTURE_DIRS = ['src', 'scripts', 'agents', 'skills', 'tests', 'templates', '.omp-plugin', '.omp/review-kit', '.claude-plugin', 'claude-plugin', '.github', '.specs/native-task-review'];
const FIXTURE_FILES = ['package.json', 'README.md', 'AGENTS.md', 'ROADMAP.md', 'CHANGELOG.md'];
const gateFixture = async (files) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-gate-fixture-'));
  for (const dir of FIXTURE_DIRS) await mkdir(path.join(root, dir), { recursive: true });
  for (const name of FIXTURE_FILES) await writeFile(path.join(root, name), name === 'package.json' ? '{}\n' : '');
  for (const [relative, text] of Object.entries(files)) await writeFile(path.join(root, relative), text);
  return root;
};
const gateMutant = (id, file, original, replacement) => ({ id, file, testFile: 'tests/m.test.mjs', original, replacement, description: id });
const GATE_TEST_BODY = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/x.mjs';\ntest('keeps the value', () => { assert.equal(value, 'a'); });\n";
// Passes through to the real runTest and records every call the gate makes.
const recordingRunner = (calls) => (root, testFile, names, options) => {
  calls.push({ names, timeoutMs: options.timeoutMs });
  return runTest(root, testFile, names, options);
};

const waitFor = async (predicate, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The condition did not hold in time');
};

test('Given the removal of a tree, When it is asked for, Then it retries the removal instead of failing on the first busy file', async () => {
  assert.equal(REMOVE_OPTIONS.recursive, true);
  assert.ok(REMOVE_OPTIONS.maxRetries > 0, 'the removal must retry');
  assert.ok(REMOVE_OPTIONS.retryDelay > 0, 'the removal must wait between attempts');
  const root = await mkdtemp(path.join(tmpdir(), 'rk-remove-tree-'));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'file.txt'), 'x');
    await removeTree(root);
    assert.equal(existsSync(root), false, 'the tree is gone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a directory a live process still holds, When the gate removes it, Then the removal waits for the handle instead of failing the gate', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-remove-held-'));
  const held = path.join(root, 'held');
  const ready = path.join(root, 'ready');
  await mkdir(held);
  try {
    // The child holds the directory as its working directory: Windows refuses to delete it while the process lives.
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'x'); await new Promise((resolve) => setTimeout(resolve, 1500));`],
    { cwd: held, stdio: 'ignore', windowsHide: true });
    await waitFor(() => existsSync(ready));
    await assert.rejects(rm(held, { recursive: true, force: true }), (error) => ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code), 'the plain removal fails on the held directory');
    await removeTree(held);
    assert.equal(existsSync(held), false, 'the removal succeeded once the holder was gone');
    child.kill('SIGKILL');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a calibration that dies after proving a selector, When --calibrate-stale runs, Then the catalog already holds the selector it proved', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-mutation-durable-'));
  const mutants = ['m1', 'm2'].map(mutant);
  try {
    await mkdir(path.join(root, 'tests'));
    for (const item of mutants) await writeFile(path.join(root, item.testFile), TEST_BODY);
    const hashOf = async (item) => testFileHash(await readFile(path.join(root, item.testFile), 'utf8'));
    const selectorPath = path.join(root, 'selectors.json');
    const mappings = Object.fromEntries(await Promise.all(mutants.map(async (item) => [item.id,
      { testFile: item.testFile, tests: ['old'], ancestors: [], mutantHash: mutantIdentity(item), testHash: await hashOf(item) }])));
    await writeFile(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings }, null, 2) + '\n');
    // The deciding test of m2 changed: its recorded selector is stale and needs calibration.
    await writeFile(path.join(root, mutants[1].testFile), `${TEST_BODY}// the deciding test changed\n`);
    const env = { OMP_MUTATION_RESULT: path.join(root, 'result.json'), OMP_MUTATION_WORKERS: '1' };
    const gate = async (targets, options) => {
      await options.onResult({ id: targets[0].id, outcome: 'killed' },
        { testFile: targets[0].testFile, tests: ['fresh'], ancestors: [], mutantHash: mutantIdentity(targets[0]), testHash: await hashOf(targets[0]) }, 'fingerprint');
      throw new Error('the calibration died before it finished');
    };
    await assert.rejects(runCli({ mutants, argv: ['--calibrate-stale'], env, cwd: root, selectorPath, gate, log: () => {} }), /the calibration died/);
    const catalog = JSON.parse(await readFile(selectorPath, 'utf8'));
    assert.deepEqual(catalog.mappings.m2.tests, ['fresh'], 'the proven selector survived the crash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given two proofs that finish together, When the calibration writes the catalog, Then both selectors land in an intact catalog', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-mutation-concurrent-'));
  const mutants = ['m1', 'm2'].map(mutant);
  try {
    await mkdir(path.join(root, 'tests'));
    for (const item of mutants) await writeFile(path.join(root, item.testFile), TEST_BODY);
    const selectorPath = path.join(root, 'selectors.json');
    await writeFile(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings: {} }, null, 2) + '\n');
    // Each proof rewrites the whole catalog, so the two writes must land in call order.
    const longNames = (id) => Array.from({ length: 1500 }, (_, index) => `${id} case ${index} ${'x'.repeat(40)}`);
    const gate = async (targets, options) => {
      await Promise.all(targets.map((item) => options.onResult({ id: item.id, outcome: 'killed' },
        { testFile: item.testFile, tests: longNames(item.id), ancestors: [], mutantHash: mutantIdentity(item), testHash: testFileHash(TEST_BODY) }, 'fingerprint')));
      throw new Error('stop after the concurrent proofs');
    };
    // The first catalog write is held back, so the second write would land first if the writes were not queued;
    // the earlier, shorter snapshot would then overwrite the complete one.
    let writes = 0;
    const writeFileImpl = async (file, text) => {
      writes += 1;
      if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 300));
      return writeFile(file, text);
    };
    await assert.rejects(runCli({ mutants, argv: ['--calibrate-stale'], env: { OMP_MUTATION_RESULT: path.join(root, 'result.json') }, cwd: root, selectorPath, gate, log: () => {}, writeFileImpl }), /stop after the concurrent proofs/);
    const catalog = JSON.parse(await readFile(selectorPath, 'utf8'));
    for (const item of mutants) assert.deepEqual(catalog.mappings[item.id].tests, longNames(item.id), `${item.id} keeps its full selector`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a calibration whose stale selector is missing for a new mutant, When the calibration dies, Then the catalog keeps the proven selector and gains no entry for the unproven mutant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-mutation-incomplete-'));
  const mutants = ['m1', 'm2'].map(mutant);
  try {
    await mkdir(path.join(root, 'tests'));
    for (const item of mutants) await writeFile(path.join(root, item.testFile), TEST_BODY);
    const selectorPath = path.join(root, 'selectors.json');
    await writeFile(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings: {
      m1: { testFile: mutants[0].testFile, tests: ['old'], ancestors: [], mutantHash: 'stale', testHash: 'stale' } } }, null, 2) + '\n');
    const gate = async (targets, options) => {
      await options.onResult({ id: 'm1', outcome: 'killed' },
        { testFile: mutants[0].testFile, tests: ['fresh'], ancestors: [], mutantHash: mutantIdentity(mutants[0]), testHash: testFileHash(TEST_BODY) }, 'fingerprint');
      throw new Error('the calibration died before it finished');
    };
    await assert.rejects(runCli({ mutants, argv: ['--calibrate-stale'], env: { OMP_MUTATION_RESULT: path.join(root, 'result.json') }, cwd: root, selectorPath, gate, log: () => {} }), /the calibration died/);
    const catalog = JSON.parse(await readFile(selectorPath, 'utf8'));
    assert.deepEqual(catalog.mappings.m1.tests, ['fresh'], 'the proven selector is kept');
    assert.equal(catalog.mappings.m2, undefined, 'the unproven mutant gains no selector');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a test run with a passing file, When it finishes, Then its scratch directory is removed', async () => {
  const root = await gateFixture({ 'tests/pass.test.mjs': TEST_BODY });
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'rk-state-'));
  try {
    const result = await runTest(root, 'tests/pass.test.mjs', [], { stateRoot });
    assert.equal(result.status, 0);
    assert.deepEqual(await readdir(stateRoot), [], 'no scratch directory is left behind');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('Given a test run that exceeds its limit, When the child is terminated, Then its scratch directory is still removed', async () => {
  const root = await gateFixture({ 'tests/sleep.test.mjs': "import test from 'node:test';\ntest('sleeps', () => new Promise((resolve) => setTimeout(resolve, 60000)));\n" });
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'rk-state-'));
  try {
    const result = await runTest(root, 'tests/sleep.test.mjs', [], { stateRoot, timeoutMs: 500 });
    assert.equal(result.timedOut, true);
    assert.deepEqual(await readdir(stateRoot), [], 'no scratch directory is left behind');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('Given Node older than 22, When a nested selector is requested, Then the run refuses it and leaves no scratch directory', async () => {
  const root = await gateFixture({ 'tests/m.test.mjs': TEST_BODY });
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'rk-state-'));
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    Object.defineProperty(process.versions, 'node', { ...original, value: '20.19.0' });
    const result = await runTest(root, 'tests/m.test.mjs', ['x'], { stateRoot, ancestors: ['describe'] });
    assert.equal(result.status, 1);
    assert.equal(result.error, 'Precise nested mutation selectors require Node 22 or newer');
    assert.deepEqual(await readdir(stateRoot), [], 'no scratch directory is left behind');
  } finally {
    Object.defineProperty(process.versions, 'node', original);
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('Given a gate run, When it finishes, Then its worker pool directory is removed from the temporary directory', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'rk-pool-temp-'));
  const keys = ['TMPDIR', 'TEMP', 'TMP'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutants = [gateMutant('m1', 'src/x.mjs', "'a'", "'b'")];
  try {
    for (const key of keys) process.env[key] = scratch;
    const result = await runMutationGate(mutants, { root, workers: 1, log: () => {}, selectors: { m1: { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: [], mutantHash: mutantIdentity(mutants[0]), testHash: testFileHash(GATE_TEST_BODY) } } });
    assert.equal(result.results[0].outcome, 'killed');
    assert.deepEqual((await readdir(scratch)).filter((entry) => entry.startsWith('omp-mutation-pool-')), [], 'no worker pool is left behind');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Given the full-file limit, When it is read, Then it is 30 minutes and longer than the focused 120 seconds', () => {
  assert.equal(FULL_SUITE_TIMEOUT_MS, 1800000);
  assert.ok(FULL_SUITE_TIMEOUT_MS > 120000);
});

test('Given a calibration, When the baseline and the mutated reference run, Then both get the full-file limit and the focused run keeps the default', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/x.mjs';\ntest('keeps the value', () => { assert.equal(value, 'a'); });\n" });
  const calls = [];
  try {
    const result = await runMutationGate([gateMutant('m1', 'src/x.mjs', "'a'", "'b'")], { root, workers: 1, calibrate: true, log: () => {}, runTestImpl: recordingRunner(calls) });
    assert.equal(result.passed, true);
    // The baseline and the mutated reference are full-file runs; the focused runs that follow carry names and the default limit.
    assert.deepEqual(calls.slice(0, 2).map((call) => call.timeoutMs), [FULL_SUITE_TIMEOUT_MS, FULL_SUITE_TIMEOUT_MS]);
    assert.ok(calls.slice(2).length > 0 && calls.slice(2).every((call) => call.names.length > 0 && call.timeoutMs === undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a test file that fails on the pristine tree, When it is calibrated, Then no mutant is killed and the baseline is reported as not green', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/x.mjs';\ntest('keeps the value', () => { assert.equal(value, 'zzz'); });\n" });
  try {
    const result = await runMutationGate([gateMutant('m1', 'src/x.mjs', "'a'", "'b'")], { root, workers: 1, calibrate: true, log: () => {} });
    assert.equal(result.passed, false);
    assert.equal(result.results[0].outcome, 'infrastructure_error');
    assert.match(result.results[0].detail, /Full-suite baseline is not green/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given two mutants of one test file, When they are calibrated on two workers, Then the full-suite baseline runs once', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const first = 'a1';\nexport const second = 'a2';\n", 'tests/m.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { first, second } from '../src/x.mjs';\ntest('keeps the first value', () => { assert.equal(first, 'a1'); });\ntest('keeps the second value', () => { assert.equal(second, 'a2'); });\n" });
  const calls = [];
  try {
    const mutants = [gateMutant('m1', 'src/x.mjs', "'a1'", "'b1'"), gateMutant('m2', 'src/x.mjs', "'a2'", "'b2'")];
    const result = await runMutationGate(mutants, { root, workers: 2, calibrate: true, log: () => {}, runTestImpl: recordingRunner(calls) });
    assert.equal(result.passed, true);
    // One full-file baseline plus one full-file reference per mutant; the focused runs carry names.
    assert.equal(calls.filter((call) => call.names.length === 0).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a link in the copy with a different target, When the worker is reset, Then the link is restored to the pristine target', { skip: process.platform === 'win32' && 'symlink creation needs elevated Windows privileges' }, async () => {
  const pristine = await mkdtemp(path.join(tmpdir(), 'rk-restore-pristine-'));
  const copy = await mkdtemp(path.join(tmpdir(), 'rk-restore-copy-'));
  const dirCopy = await mkdtemp(path.join(tmpdir(), 'rk-restore-dir-'));
  try {
    await writeFile(path.join(pristine, 'a'), 'alpha');
    await symlink('a', path.join(pristine, 'l'));
    const baseline = await captureTree(pristine);
    await writeFile(path.join(copy, 'a'), 'alpha');
    await writeFile(path.join(copy, 'b'), 'beta');
    await symlink('b', path.join(copy, 'l'));
    await restoreTree(copy, baseline);
    assert.equal(await readlink(path.join(copy, 'l')), 'a');
    assert.deepEqual(await captureTree(copy), baseline);
    // A directory where the pristine tree has a link is replaced by the link.
    await writeFile(path.join(pristine, 'a'), 'alpha');
    await mkdir(path.join(dirCopy, 'l'));
    await writeFile(path.join(dirCopy, 'l', 'nested.txt'), 'stray');
    await writeFile(path.join(dirCopy, 'a'), 'alpha');
    await restoreTree(dirCopy, baseline);
    assert.equal(await readlink(path.join(dirCopy, 'l')), 'a');
    assert.deepEqual(await captureTree(dirCopy), baseline);
  } finally {
    await rm(pristine, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
    await rm(dirCopy, { recursive: true, force: true });
  }
});

test('Given a catalog write that fails, When the next proof is written, Then the next proof still lands and the failure reaches the caller', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-mutation-write-fail-'));
  const mutants = ['m1', 'm2'].map(mutant);
  try {
    await mkdir(path.join(root, 'tests'));
    for (const item of mutants) await writeFile(path.join(root, item.testFile), TEST_BODY);
    const selectorPath = path.join(root, 'selectors.json');
    await writeFile(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings: {} }, null, 2) + '\n');
    let writes = 0;
    const writeFileImpl = async (file, text) => {
      writes += 1;
      if (writes === 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return writeFile(file, text);
    };
    const gate = async (targets, options) => {
      const outcomes = await Promise.allSettled(targets.map((item) => options.onResult({ id: item.id, outcome: 'killed' },
        { testFile: item.testFile, tests: [item.id], ancestors: [], mutantHash: mutantIdentity(item), testHash: testFileHash(TEST_BODY) }, 'fingerprint')));
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      return { passed: true, mappings: {}, results: [], durationMs: 0 };
    };
    await assert.rejects(runCli({ mutants, argv: ['--calibrate-stale'], env: { OMP_MUTATION_RESULT: path.join(root, 'result.json') }, cwd: root, selectorPath, gate, log: () => {}, writeFileImpl }), /disk full/);
    const catalog = JSON.parse(await readFile(selectorPath, 'utf8'));
    assert.deepEqual(catalog.mappings.m1.tests, ['m1'], 'the first proof is in the catalog after the next write');
    assert.deepEqual(catalog.mappings.m2.tests, ['m2'], 'the second proof lands despite the failed write');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given two mutants of a suite that is red on the pristine tree, When they are calibrated on two workers, Then both fail as infrastructure errors after one baseline run', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const first = 'a1';\nexport const second = 'a2';\n", 'tests/m.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { first, second } from '../src/x.mjs';\ntest('keeps the first value', () => { assert.equal(first, 'zzz'); });\ntest('keeps the second value', () => { assert.equal(second, 'a2'); });\n" });
  const calls = [];
  try {
    const mutants = [gateMutant('m1', 'src/x.mjs', "'a1'", "'b1'"), gateMutant('m2', 'src/x.mjs', "'a2'", "'b2'")];
    const result = await runMutationGate(mutants, { root, workers: 2, calibrate: true, log: () => {}, runTestImpl: recordingRunner(calls) });
    assert.equal(result.passed, false);
    for (const item of result.results) {
      assert.equal(item.outcome, 'infrastructure_error');
      assert.match(item.detail, /Full-suite baseline is not green/);
    }
    assert.equal(result.mappings.m1, undefined);
    assert.equal(result.mappings.m2, undefined);
    assert.equal(calls.filter((call) => call.names.length === 0 && call.timeoutMs === FULL_SUITE_TIMEOUT_MS).length, 1, 'one full-file baseline run, shared by both workers');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a directory where the pristine tree has a file, When the worker is reset, Then the directory is removed and the file restored', async () => {
  const pristine = await mkdtemp(path.join(tmpdir(), 'rk-restore-file-'));
  const copy = await mkdtemp(path.join(tmpdir(), 'rk-restore-stray-'));
  try {
    await writeFile(path.join(pristine, 'x'), 'pristine');
    const baseline = await captureTree(pristine);
    await mkdir(path.join(copy, 'x'));
    await writeFile(path.join(copy, 'x', 'nested.txt'), 'stray');
    await restoreTree(copy, baseline);
    assert.equal(existsSync(path.join(copy, 'x', 'nested.txt')), false, 'the stray tree is gone');
    assert.deepEqual(await captureTree(copy), baseline);
  } finally {
    await rm(pristine, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
  }
});

// Scripted runs drive the calibration branches without a real suite. A full-file run returns the next scripted result;
// a focused run answers from its names, its ancestors, and whether the copy already holds the mutant ('b').
const scriptedRun = (overrides = {}) => ({ timedOut: false, error: undefined, signal: null, status: 0, events: [], stderr: '', requireSummary: false, durationMs: 1, ...overrides });
const passedTest = (name, ancestors = []) => ({ type: 'test:pass', name, ancestors, durationMs: 1 });
const failedAssertion = (name, ancestors = []) => ({ type: 'test:fail', name, ancestors, causeCode: 'ERR_ASSERTION', durationMs: 1 });
const GREEN_FULL = scriptedRun({ events: [passedTest('keeps the value')] });
const noFocusedRun = () => { throw new Error('a focused run must not start'); };
const scriptedRunner = ({ full, focused }) => {
  const calls = [];
  const runTestImpl = async (root, testFile, names, options) => {
    calls.push({ names, ancestors: options.ancestors });
    if (!names.length) return full.shift();
    return focused({ names, ancestors: options.ancestors, mutated: readFileSync(path.join(root, 'src', 'x.mjs'), 'utf8').includes("'b'") });
  };
  return { runTestImpl, calls };
};

test('Given a reference run that times out, When it is calibrated, Then the mutant times out with the run output and gets no selector', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const { runTestImpl, calls } = scriptedRunner({ full: [GREEN_FULL, scriptedRun({ timedOut: true, status: null, stderr: 'slow' })], focused: noFocusedRun });
  try {
    const result = await runMutationGate([gateMutant('m1', 'src/x.mjs', "'a'", "'b'")], { root, workers: 1, calibrate: true, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'timeout');
    assert.equal(result.results[0].detail, 'slow');
    assert.equal(result.mappings.m1, undefined, 'a timeout proves nothing');
    assert.equal(calls.length, 2, 'only the baseline and the reference run: no focused run follows a timeout');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a reference run without a status, When it is calibrated, Then the mutant is an infrastructure error and no focused run starts', async () => {
  for (const events of [[], [failedAssertion('keeps the value')]]) {
    const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
    const { runTestImpl, calls } = scriptedRunner({ full: [GREEN_FULL, scriptedRun({ status: null, events, stderr: 'crashed' })], focused: noFocusedRun });
    try {
      const result = await runMutationGate([gateMutant('m1', 'src/x.mjs', "'a'", "'b'")], { root, workers: 1, calibrate: true, log: () => {}, runTestImpl });
      assert.equal(result.results[0].outcome, 'infrastructure_error');
      assert.equal(result.results[0].detail, 'crashed');
      assert.equal(calls.length, 2, 'a run without a status proves no selector, even when it lists an assertion');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('Given a reference run that fails without an assertion, When it is calibrated, Then the mutant is an infrastructure error that names the failure and no focused run starts', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const moduleFailure = { type: 'test:fail', name: 'keeps the value', causeCode: 'ERR_MODULE_NOT_FOUND', durationMs: 1 };
  const { runTestImpl, calls } = scriptedRunner({ full: [GREEN_FULL, scriptedRun({ status: 1, events: [moduleFailure] })], focused: noFocusedRun });
  try {
    const result = await runMutationGate([gateMutant('m1', 'src/x.mjs', "'a'", "'b'")], { root, workers: 1, calibrate: true, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'infrastructure_error');
    assert.match(result.results[0].detail, /ERR_MODULE_NOT_FOUND/, 'the detail carries the failure that proved nothing');
    assert.equal(calls.length, 2, 'no deciding assertion, so no selector is tried');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a recorded selector whose top-level run passes but whose ancestor-scoped run fails, When it is calibrated, Then the reference finds fresh ancestors and the mutant is killed', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  const { runTestImpl, calls } = scriptedRunner({
    full: [GREEN_FULL, scriptedRun({ status: 1, events: [failedAssertion('keeps the value', ['fresh'])] })],
    focused: ({ names, ancestors, mutated }) => {
      if (!ancestors.length) return mutated ? scriptedRun({ status: 1, events: [failedAssertion(names[0], ['parent'])] }) : scriptedRun({ events: [passedTest(names[0], ['parent'])] });
      if (ancestors[0] === 'parent') return scriptedRun({ status: 1, events: [failedAssertion(names[0], ['parent'])] });
      return mutated ? scriptedRun({ status: 1, events: [failedAssertion(names[0], ancestors)] }) : scriptedRun({ events: [passedTest(names[0], ancestors)] });
    },
  });
  try {
    const selectors = { m1: { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: [], mutantHash: mutantIdentity(mutant), testHash: 'outdated' } };
    const result = await runMutationGate([mutant], { root, workers: 1, calibrate: true, selectors, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'killed', 'the failed hint falls back to the reference and the mutant is still killed');
    assert.deepEqual(result.mappings.m1, { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: ['fresh'], mutantHash: mutantIdentity(mutant), testHash: testFileHash(GATE_TEST_BODY) });
    assert.equal(calls.filter((call) => call.names.length === 0).length, 2, 'one baseline and one reference: the failed hint did not add a third full-file run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a fresh selector whose top-level run passes but whose ancestor-scoped run fails, When it is calibrated, Then the mutant gets no selector', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  const { runTestImpl } = scriptedRunner({
    full: [GREEN_FULL, scriptedRun({ status: 1, events: [failedAssertion('keeps the value')] })],
    focused: ({ names, ancestors, mutated }) => {
      if (ancestors[0] === 'parent') return scriptedRun({ status: 1, events: [failedAssertion(names[0], ['parent'])] });
      return mutated ? scriptedRun({ status: 1, events: [failedAssertion(names[0])] }) : scriptedRun({ events: [passedTest(names[0], ['parent'])] });
    },
  });
  try {
    const result = await runMutationGate([mutant], { root, workers: 1, calibrate: true, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'selector_invalid');
    assert.equal(result.mappings.m1, undefined, 'a precise run that does not pass proves no selector');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a recorded selector that no longer runs any test, When it is calibrated, Then the reference supplies the selector and the mutant is killed with one reference run', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  const { runTestImpl, calls } = scriptedRunner({
    full: [GREEN_FULL, scriptedRun({ status: 1, events: [failedAssertion('keeps the value')] })],
    focused: ({ names, mutated }) => {
      if (names[0] === 'stale name') return scriptedRun({ events: [] });
      return mutated ? scriptedRun({ status: 1, events: [failedAssertion(names[0])] }) : scriptedRun({ events: [passedTest(names[0])] });
    },
  });
  try {
    const selectors = { m1: { testFile: 'tests/m.test.mjs', tests: ['stale name'], ancestors: [], mutantHash: mutantIdentity(mutant), testHash: 'outdated' } };
    const result = await runMutationGate([mutant], { root, workers: 1, calibrate: true, selectors, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'killed');
    assert.deepEqual(result.mappings.m1.tests, ['keeps the value']);
    assert.deepEqual(calls[0].names, ['stale name'], 'the recorded selector was tried first');
    assert.equal(calls.filter((call) => call.names.length === 0).length, 2, 'the full-file baseline and exactly one reference run follow the hint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a deciding test under a describe block, When it is calibrated, Then the mapping keeps its ancestors and the ordinary gate kills with that mapping', async () => {
  const nested = "import test, { describe } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/x.mjs';\ndescribe('parent', () => {\n  test('keeps the value', () => { assert.equal(value, 'a'); });\n});\n";
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': nested });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  try {
    const calibration = await runMutationGate([mutant], { root, workers: 1, calibrate: true, log: () => {} });
    assert.equal(calibration.passed, true);
    assert.deepEqual(calibration.mappings.m1, { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: ['parent'], mutantHash: mutantIdentity(mutant), testHash: testFileHash(nested) });
    const ordinary = await runMutationGate([mutant], { root, workers: 1, selectors: calibration.mappings, log: () => {} });
    assert.equal(ordinary.results[0].outcome, 'killed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a catalog write that fails right after a proof, When the proof is recorded, Then its result line is still kept', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-mutation-line-kept-'));
  const item = mutant('m1');
  try {
    await mkdir(path.join(root, 'tests'));
    await writeFile(path.join(root, item.testFile), TEST_BODY);
    const selectorPath = path.join(root, 'selectors.json');
    await writeFile(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings: {} }, null, 2) + '\n');
    const resultPath = path.join(root, 'result.json');
    const writeFileImpl = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    const gate = async (targets, options) => {
      await options.onResult({ id: targets[0].id, outcome: 'killed' },
        { testFile: targets[0].testFile, tests: ['fresh'], ancestors: [], mutantHash: mutantIdentity(targets[0]), testHash: testFileHash(TEST_BODY) }, 'fingerprint');
      return { passed: true, mappings: {}, results: [], durationMs: 0 };
    };
    await assert.rejects(runCli({ mutants: [item], argv: ['--calibrate-stale'], env: { OMP_MUTATION_RESULT: resultPath }, cwd: root, selectorPath, gate, log: () => {}, writeFileImpl }), /disk full/);
    const lines = (await readFile(`${resultPath}.jsonl`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => [line.id, line.outcome]), [['m1', 'killed']], 'the proof is in the result file even though its catalog write failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a recorded selector whose deciding test changed, When the gate runs without calibration, Then the mutant is selector_invalid and no test runs', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  const selectors = { m1: { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: [], mutantHash: mutantIdentity(mutant), testHash: testFileHash('an older test body') } };
  const calls = [];
  // If the stale selector reached a run, this run would kill the mutant: the zero-call assertion below then fails.
  const runTestImpl = async (copy, testFile, names) => {
    calls.push(names);
    return scriptedRun({ status: 1, events: [failedAssertion('keeps the value')] });
  };
  try {
    const result = await runMutationGate([mutant], { root, workers: 1, selectors, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'selector_invalid');
    assert.match(result.results[0].detail, /recalibration required/);
    assert.equal(calls.length, 0, 'the stale selector never reaches a run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a recorded selector that names another test file, When the gate runs without calibration, Then the mutant is selector_invalid and no test runs', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  // The test hash is current, so only the test file name separates this selector from a valid one.
  const selectors = { m1: { testFile: 'tests/other.test.mjs', tests: ['keeps the value'], ancestors: [], mutantHash: mutantIdentity(mutant), testHash: testFileHash(GATE_TEST_BODY) } };
  const calls = [];
  const runTestImpl = async (copy, testFile, names) => {
    calls.push(names);
    return scriptedRun({ status: 1, events: [failedAssertion('keeps the value')] });
  };
  try {
    const result = await runMutationGate([mutant], { root, workers: 1, selectors, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'selector_invalid');
    assert.equal(calls.length, 0, 'a selector for another file never reaches a run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a recorded selector that fails on the pristine tree, When the ordinary gate runs, Then the mutant is selector_invalid with the pristine detail and one run', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  const selectors = { m1: { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: [], mutantHash: mutantIdentity(mutant), testHash: testFileHash(GATE_TEST_BODY) } };
  const calls = [];
  // The recorded name already fails on the pristine tree, so the failure proves nothing about the mutant.
  const runTestImpl = async (copy, testFile, names) => {
    calls.push(names);
    return scriptedRun({ status: 1, events: [failedAssertion('keeps the value')], stderr: 'pristine failure' });
  };
  try {
    const result = await runMutationGate([mutant], { root, workers: 1, selectors, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'selector_invalid');
    assert.equal(result.results[0].detail, 'pristine failure');
    assert.equal(result.mappings.m1, undefined, 'a failing baseline proves no selector');
    assert.equal(calls.length, 1, 'only the pristine baseline runs: the mutated copy is never run with the recorded name');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given two mutants of one nested test with the same recorded selector, When the ordinary gate runs on one worker, Then the second mutant reuses the scope proven for the first and is killed', async () => {
  const nested = "import test, { describe } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { first, second } from '../src/x.mjs';\ndescribe('parent', () => {\n  test('keeps the value', () => { assert.equal(first, 'a1'); assert.equal(second, 'a2'); });\n});\n";
  const root = await gateFixture({ 'src/x.mjs': "export const first = 'a1';\nexport const second = 'a2';\n", 'tests/m.test.mjs': nested });
  const mutants = [gateMutant('m1', 'src/x.mjs', "'a1'", "'b1'"), gateMutant('m2', 'src/x.mjs', "'a2'", "'b2'")];
  const selectors = Object.fromEntries(mutants.map((item) => [item.id, { testFile: 'tests/m.test.mjs', tests: ['keeps the value'], ancestors: [], mutantHash: mutantIdentity(item), testHash: testFileHash(nested) }]));
  const calls = [];
  const runTestImpl = (copy, testFile, names, options) => {
    calls.push({ names, ancestors: options.ancestors });
    return runTest(copy, testFile, names, options);
  };
  try {
    const result = await runMutationGate(mutants, { root, workers: 1, selectors, log: () => {}, runTestImpl });
    assert.deepEqual(result.results.map((record) => record.outcome), ['killed', 'killed']);
    assert.equal(calls.filter((call) => call.names.length && call.ancestors.length === 0).length, 1, 'only the first mutant runs the unscoped baseline; the second reuses its scope');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a recorded selector that still passes on the mutated copy, When it is calibrated, Then the reference supplies the selector and the mutant is killed', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  const { runTestImpl, calls } = scriptedRunner({
    full: [GREEN_FULL, scriptedRun({ status: 1, events: [failedAssertion('keeps the value')] })],
    focused: ({ names, mutated }) => {
      // The recorded name passes on the mutated copy too: that proves nothing, so the reference must decide.
      if (names[0] === 'hint name') return scriptedRun({ events: [passedTest('hint name')] });
      return mutated ? scriptedRun({ status: 1, events: [failedAssertion(names[0])] }) : scriptedRun({ events: [passedTest(names[0])] });
    },
  });
  try {
    const selectors = { m1: { testFile: 'tests/m.test.mjs', tests: ['hint name'], ancestors: [], mutantHash: mutantIdentity(mutant), testHash: 'outdated' } };
    const result = await runMutationGate([mutant], { root, workers: 1, calibrate: true, selectors, log: () => {}, runTestImpl });
    assert.equal(result.results[0].outcome, 'killed');
    assert.deepEqual(result.mappings.m1.tests, ['keeps the value'], 'the surviving hint never becomes the selector');
    assert.equal(calls.filter((call) => call.names.length === 0).length, 2, 'one baseline and one reference run follow the surviving hint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a test child that does not close after termination, When the gate runs, Then the worker is not reused and its pool directory is kept', async () => {
  const root = await gateFixture({ 'src/x.mjs': "export const value = 'a';\n", 'tests/m.test.mjs': GATE_TEST_BODY });
  const mutant = gateMutant('m1', 'src/x.mjs', "'a'", "'b'");
  let pool;
  const runTestImpl = async (copy, testFile, names, options) => {
    pool = options.stateRoot;
    throw Object.assign(new Error('Mutation child did not close after termination; worker must not be reused'), { unsafeWorker: true });
  };
  try {
    await assert.rejects(runMutationGate([mutant], { root, workers: 1, calibrate: true, log: () => {}, runTestImpl }), /did not close after termination/);
    assert.equal(existsSync(pool), true, 'a worker that may still hold handles keeps its pool directory for inspection');
  } finally {
    await rm(root, { recursive: true, force: true });
    if (pool) await rm(pool, { recursive: true, force: true });
  }
});
