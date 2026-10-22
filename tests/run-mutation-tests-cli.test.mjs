import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mutantIdentity, runAsScript, runCli, testFileHash } from '../scripts/mutation-runner.mjs';

const TEST_BODY = "import test from 'node:test';\ntest('x', () => {});\n";
const mutant = (id) => ({ id, file: 'src/x.mjs', testFile: `tests/${id}.test.mjs`, original: `a-${id}`, replacement: `b-${id}`, description: id });
const mapping = (item, testHash = testFileHash(TEST_BODY)) => ({ testFile: item.testFile, tests: ['proven'], ancestors: [], mutantHash: mutantIdentity(item), testHash });

// Three mutants with a proven selector each; `stale` lists those whose recorded test file hash is outdated.
async function fixture(stale = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-mutation-cli-'));
  const mutants = ['m1', 'm2', 'm3'].map(mutant);
  await mkdir(path.join(root, 'tests'));
  for (const item of mutants) await writeFile(path.join(root, item.testFile), TEST_BODY);
  const selectorPath = path.join(root, 'selectors.json');
  const mappings = Object.fromEntries(mutants.map((item) => [item.id, mapping(item, stale.includes(item.id) ? 'outdated' : undefined)]));
  await writeFile(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings }, null, 2) + '\n');
  const resultPath = path.join(root, 'result.json');
  return { root, mutants, selectorPath, resultPath, mappings, env: { OMP_MUTATION_RESULT: resultPath, OMP_MUTATION_WORKERS: '2' } };
}

// A gate that records what it was asked to prove; the mutants in `survive` are not killed.
function fakeGate(survive = []) {
  const calls = [];
  const gate = async (mutants, options) => {
    calls.push({ ids: mutants.map((item) => item.id), calibrate: options.calibrate, selectors: options.selectors, workers: options.workers, signal: options.signal });
    const results = mutants.map((item) => ({ id: item.id, outcome: survive.includes(item.id) ? 'survived' : 'killed' }));
    const mappings = Object.fromEntries(mutants.filter((item) => !survive.includes(item.id)).map((item) => [item.id, { ...mapping(item), tests: ['fresh'] }]));
    for (const record of results) await options.onResult(record, mappings[record.id], 'fingerprint');
    return { fingerprint: 'fingerprint', calibrated: options.calibrate, mappings, results, durationMs: 7, passed: results.every((item) => item.outcome === 'killed') };
  };
  return Object.assign(gate, { calls });
}

// Failures are returned, not thrown: a rejected promise must fail the test on an assertion, not on an infrastructure error.
async function run(setup, argv, gate) {
  const lines = [];
  const outcome = await runCli({ mutants: setup.mutants, argv, env: setup.env, cwd: setup.root, selectorPath: setup.selectorPath, gate, log: (line) => lines.push(line) })
    .then((exitCode) => ({ exitCode }), (error) => ({ error }));
  assert.equal(outcome.error, undefined, `runCli rejected: ${outcome.error?.message}`);
  return { exitCode: outcome.exitCode, lines, text: lines.join('\n') };
}

const readMappings = async (setup) => JSON.parse(await readFile(setup.selectorPath, 'utf8')).mappings;
const cleanup = (setup) => rm(setup.root, { recursive: true, force: true });

test('Given one outdated selector, When --calibrate-stale runs, Then that mutant is calibrated first, then every selector is proven, and the exit code is the full gate verdict', async () => {
  const setup = await fixture(['m2']);
  try {
    const gate = fakeGate();
    await writeFile(`${setup.resultPath}.jsonl`, 'left over from an earlier run\n');
    const { exitCode, text } = await run(setup, ['--calibrate-stale'], gate);
    assert.equal(exitCode, 0, 'exit 0 only because the full gate passed after the calibration');
    assert.deepEqual(gate.calls.map((call) => [call.ids, call.calibrate]), [[['m2'], true], [['m1', 'm2', 'm3'], false]]);
    assert.deepEqual(Object.keys(gate.calls[1].selectors), ['m1', 'm2', 'm3']);
    assert.deepEqual(gate.calls[1].selectors.m2.tests, ['fresh'], 'the full gate uses the selector that was just calibrated');
    assert.match(text, /Selector catalog: 1 of 3 mutants need calibration\./);
    assert.match(text, /Stale-selector calibration finished: 1\/1 stale mutants killed/);
    assert.match(text, /Proving every selector now: the exit code of --calibrate-stale is the verdict of the full gate\./);
    assert.match(text, /Mutation gate result: 3\/3 killed/);
    assert.match(text, /Mutation gate PASSED: 100% of curated safety mutants killed\./);
    const mappings = await readMappings(setup);
    assert.deepEqual(Object.keys(mappings), ['m1', 'm2', 'm3'], 'entries keep their place');
    assert.deepEqual(mappings.m1, setup.mappings.m1);
    assert.deepEqual(mappings.m3, setup.mappings.m3);
    assert.deepEqual(mappings.m2.tests, ['fresh']);
    const result = JSON.parse(await readFile(setup.resultPath, 'utf8'));
    assert.equal(result.subset, undefined, 'the final result file covers the whole catalog');
    assert.equal(result.results.length, 3);
    // Every failure below is an assertion: a SyntaxError or TypeError from parsing would read as an infrastructure error of the mutation gate.
    const lines = (await readFile(`${setup.resultPath}.jsonl`, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'one line per mutant of the full gate; earlier content is gone');
    const records = lines.map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => [record.id, record.outcome, record.fingerprint, record.mapping?.tests]), [['m1', 'killed', 'fingerprint', ['fresh']], ['m2', 'killed', 'fingerprint', ['fresh']], ['m3', 'killed', 'fingerprint', ['fresh']]]);
  } finally { await cleanup(setup); }
});

test('Given every selector is current, When --calibrate-stale runs, Then nothing is calibrated but the full gate still runs and decides the exit code', async () => {
  const setup = await fixture();
  try {
    const before = await readFile(setup.selectorPath, 'utf8');
    const gate = fakeGate();
    const { exitCode, text } = await run(setup, ['--calibrate-stale'], gate);
    assert.equal(exitCode, 0);
    assert.deepEqual(gate.calls.map((call) => [call.ids, call.calibrate]), [[['m1', 'm2', 'm3'], false]], 'no stale mutant is calibrated; the full gate runs');
    assert.match(text, /Selector catalog: 0 of 3 mutants need calibration\./);
    assert.match(text, /Selector catalog is current: no selector needed calibration\./);
    assert.match(text, /Mutation gate PASSED: 100% of curated safety mutants killed\./);
    assert.doesNotMatch(text, /stale-selector calibration/);
    assert.equal(await readFile(setup.selectorPath, 'utf8'), before);
    assert.equal(JSON.parse(await readFile(setup.resultPath, 'utf8')).subset, undefined, 'the result file covers the whole catalog');
  } finally { await cleanup(setup); }
});

test('Given the stale subset is proven, When another selector fails in the full gate, Then --calibrate-stale exits 1, says so and keeps what it calibrated', async () => {
  const setup = await fixture(['m2']);
  try {
    const gate = fakeGate(['m3']);
    const { exitCode, text } = await run(setup, ['--calibrate-stale'], gate);
    assert.equal(exitCode, 1, 'a subset that passed must not turn a failing gate into success');
    assert.deepEqual(gate.calls.map((call) => [call.ids, call.calibrate]), [[['m2'], true], [['m1', 'm2', 'm3'], false]]);
    assert.match(text, /Stale-selector calibration finished: 1\/1 stale mutants killed/);
    assert.match(text, /Mutation gate result: 2\/3 killed/);
    assert.match(text, /Mutation gate FAILED: unresolved mutation evidence\./);
    assert.doesNotMatch(text, /Mutation gate PASSED/);
    const mappings = await readMappings(setup);
    assert.deepEqual(mappings.m2.tests, ['fresh'], 'the calibrated selector is kept');
    assert.deepEqual(mappings.m3, setup.mappings.m3);
    assert.equal(JSON.parse(await readFile(setup.resultPath, 'utf8')).subset, undefined);
  } finally { await cleanup(setup); }
});

test('Given stale mutants survive, When --calibrate-stale runs, Then it fails, keeps the proven selectors and leaves the survivors stale', async () => {
  const setup = await fixture(['m1', 'm2']);
  try {
    // m2 has an outdated selector, m4 is new and has none: neither may end up with an invented selector.
    const added = mutant('m4');
    await writeFile(path.join(setup.root, added.testFile), TEST_BODY);
    setup.mutants.push(added);
    const gate = fakeGate(['m2', 'm4']);
    const { exitCode, text } = await run(setup, ['--calibrate-stale'], gate);
    assert.equal(exitCode, 1, 'a stale mutant that survives fails the run');
    assert.deepEqual(gate.calls.map((call) => [call.ids, call.calibrate]), [[['m1', 'm2', 'm4'], true]], 'the full gate does not run after a failed calibration');
    assert.match(text, /Selector catalog: 3 of 4 mutants need calibration\./);
    assert.match(text, /Stale-selector calibration FAILED: 1\/3 stale mutants killed/);
    assert.doesNotMatch(text, /Mutation gate PASSED|Proving every selector now/);
    assert.deepEqual(JSON.parse(await readFile(setup.resultPath, 'utf8')).subset, { mutants: 3, catalog: 4 }, 'the result file says it covers only the subset that failed');
    const mappings = await readMappings(setup);
    assert.deepEqual(Object.keys(mappings), ['m1', 'm2', 'm3'], 'the survivor without a selector gets none');
    assert.deepEqual(mappings.m1.tests, ['fresh'], 'the proven selector is persisted');
    assert.deepEqual(mappings.m2, setup.mappings.m2, 'the survivor keeps its outdated entry, so the next run repeats it');
    assert.deepEqual(mappings.m3, setup.mappings.m3);
  } finally { await cleanup(setup); }
});

test('Given a complete catalog, When the ordinary gate passes, Then it reports a full pass and leaves the selectors untouched', async () => {
  const setup = await fixture();
  try {
    const before = await readFile(setup.selectorPath, 'utf8');
    const gate = fakeGate();
    const { exitCode, text } = await run(setup, [], gate);
    assert.equal(exitCode, 0);
    assert.deepEqual(gate.calls.map((call) => [call.ids, call.calibrate]), [[['m1', 'm2', 'm3'], false]]);
    assert.deepEqual(Object.keys(gate.calls[0].selectors), ['m1', 'm2', 'm3'], 'the recorded selectors are handed to the gate');
    assert.match(text, /Mutation gate result: 3\/3 killed/);
    assert.match(text, /Mutation gate PASSED: 100% of curated safety mutants killed\./);
    assert.equal(await readFile(setup.selectorPath, 'utf8'), before, 'an ordinary run never rewrites the catalog');
    assert.equal(JSON.parse(await readFile(setup.resultPath, 'utf8')).subset, undefined, 'a full run is not marked as a subset');
  } finally { await cleanup(setup); }
});

test('Given a survivor, When the ordinary gate runs, Then it fails with a non-zero exit and says so', async () => {
  const setup = await fixture();
  try {
    const { exitCode, text } = await run(setup, [], fakeGate(['m3']));
    assert.equal(exitCode, 1);
    assert.match(text, /Mutation gate result: 2\/3 killed/);
    assert.match(text, /Mutation gate FAILED: unresolved mutation evidence\./);
    assert.doesNotMatch(text, /Mutation gate PASSED/);
  } finally { await cleanup(setup); }
});

test('Given a catalog that misses a mutant, When the ordinary gate starts, Then it is refused before any mutant runs', async () => {
  const setup = await fixture();
  try {
    const gate = fakeGate();
    const partial = { schema: 'mutation-selectors@1', mappings: { m1: setup.mappings.m1 } };
    await writeFile(setup.selectorPath, JSON.stringify(partial));
    const outcome = await runCli({ mutants: setup.mutants, argv: [], env: setup.env, cwd: setup.root, selectorPath: setup.selectorPath, gate, log: () => {} })
      .then((exitCode) => ({ exitCode }), (error) => ({ error }));
    assert.match(outcome.error?.message ?? 'accepted', /Incomplete selector catalog; run --calibrate/);
    assert.deepEqual(gate.calls, []);
  } finally { await cleanup(setup); }
});

test('Given a full --calibrate, When it passes it writes the fresh selectors and when a mutant survives it leaves the catalog alone', async () => {
  const setup = await fixture();
  try {
    const before = await readFile(setup.selectorPath, 'utf8');
    const failed = await run(setup, ['--calibrate'], fakeGate(['m2']));
    assert.equal(failed.exitCode, 1);
    assert.equal(await readFile(setup.selectorPath, 'utf8'), before, 'a failed full calibration writes nothing');
    const gate = fakeGate();
    const passed = await run(setup, ['--calibrate'], gate);
    assert.equal(passed.exitCode, 0);
    assert.equal(gate.calls[0].calibrate, true);
    assert.deepEqual(Object.values(await readMappings(setup)).map((entry) => entry.tests), [['fresh'], ['fresh'], ['fresh']]);
  } finally { await cleanup(setup); }
});

test('Given an unreadable selector catalog, When --calibrate-stale runs, Then it is refused before any mutant runs', async () => {
  const setup = await fixture();
  try {
    for (const body of [{ schema: 'other@1', mappings: {} }, { schema: 'mutation-selectors@1' }]) {
      await writeFile(setup.selectorPath, JSON.stringify(body));
      const gate = fakeGate();
      const outcome = await runCli({ mutants: setup.mutants, argv: ['--calibrate-stale'], env: setup.env, cwd: setup.root, selectorPath: setup.selectorPath, gate, log: () => {} })
        .then((exitCode) => ({ exitCode }), (error) => ({ error }));
      assert.match(outcome.error?.message ?? 'accepted', /Unreadable selector catalog; run --calibrate/);
      assert.deepEqual(gate.calls, []);
      assert.equal(await readFile(setup.selectorPath, 'utf8'), JSON.stringify(body), 'the catalog is not rewritten');
    }
  } finally { await cleanup(setup); }
});

test('Given selectors of mutants that left the catalog, When nothing is stale, Then the rewrite drops them and keeps the rest unchanged', async () => {
  const setup = await fixture();
  try {
    const withGone = { schema: 'mutation-selectors@1', mappings: { gone: mapping(mutant('gone')), ...setup.mappings } };
    await writeFile(setup.selectorPath, JSON.stringify(withGone, null, 2) + '\n');
    const gate = fakeGate();
    const { exitCode } = await run(setup, ['--calibrate-stale'], gate);
    assert.equal(exitCode, 0);
    assert.deepEqual(gate.calls.map((call) => [call.ids, call.calibrate]), [[['m1', 'm2', 'm3'], false]]);
    assert.deepEqual(Object.keys(gate.calls[0].selectors), ['m1', 'm2', 'm3'], 'the selector of the mutant that left is not handed to the gate');
    assert.equal(await readFile(setup.selectorPath, 'utf8'), JSON.stringify({ schema: 'mutation-selectors@1', mappings: setup.mappings }, null, 2) + '\n');
  } finally { await cleanup(setup); }
});

test('Given OMP_MUTATION_WORKERS, When the gate starts, Then the worker count reaches the gate and the banner, and defaults to four', async () => {
  const setup = await fixture();
  try {
    const gate = fakeGate();
    const configured = await run(setup, [], gate);
    assert.equal(gate.calls[0].workers, 2);
    assert.match(configured.text, /Starting safety mutation gate: 3 curated mutants, 2 workers, verified focused selectors\.\.\./);
    const env = { ...setup.env };
    delete env.OMP_MUTATION_WORKERS;
    const defaulted = await run({ ...setup, env }, [], gate);
    assert.equal(gate.calls[1].workers, 4);
    assert.match(defaulted.text, /3 curated mutants, 4 workers, verified/);
    const calibrating = await run(setup, ['--calibrate'], gate);
    assert.match(calibrating.text, /2 workers, full\/focused calibration\.\.\./);
    const many = await run({ ...setup, env: { ...setup.env, OMP_MUTATION_WORKERS: '7' } }, [], gate);
    assert.equal(gate.calls[3].workers, 7);
    assert.match(many.text, /7 workers/);
  } finally { await cleanup(setup); }
});

test('Given an interrupt during the gate, When it arrives, Then the gate is aborted and the signal handlers are removed afterwards', async () => {
  const setup = await fixture();
  try {
    const known = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    const seen = [];
    const gate = async (mutants, options) => {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const mine = process.listeners(signal).filter((listener) => !known[signal].includes(listener));
        seen.push([signal, mine.length, options.signal.aborted]);
        if (signal === 'SIGINT') { mine[0](); seen.push(['aborted', options.signal.aborted]); }
      }
      return { passed: false, results: mutants.map((item) => ({ id: item.id, outcome: 'timeout' })), mappings: {}, durationMs: 1 };
    };
    const { exitCode } = await run(setup, [], gate);
    assert.equal(exitCode, 1);
    assert.deepEqual(seen, [['SIGINT', 1, false], ['aborted', true], ['SIGTERM', 1, true]]);
    // Counts, not the listeners: functions cannot cross the test runner's process boundary inside an assertion error.
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], [known.SIGINT.length, known.SIGTERM.length], 'no handler is left behind');
  } finally { await cleanup(setup); }
});

test('Given no selector path, When the ordinary gate starts, Then it reads the catalog next to the script', async () => {
  const setup = await fixture();
  try {
    // Whatever the catalog next to the script holds now: this test must not depend on it being complete.
    const recorded = JSON.parse(await readFile(new URL('../scripts/mutation-selectors.json', import.meta.url), 'utf8')).mappings;
    const mutants = Object.keys(recorded).map((id) => ({ id, file: 'src/x.mjs', testFile: 'tests/x.test.mjs', original: 'a', replacement: 'b' }));
    const gate = fakeGate();
    const outcome = await runCli({ mutants, argv: [], env: setup.env, cwd: setup.root, gate, log: () => {} })
      .then((exitCode) => ({ exitCode }), (error) => ({ error }));
    assert.equal(outcome.error, undefined, `runCli rejected: ${outcome.error?.message}`);
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(gate.calls[0].selectors, recorded);
    assert.equal(gate.calls[0].ids.length, mutants.length);
  } finally { await cleanup(setup); }
});

test('Given the script entry, When the Node version, the run or the exit code say so, Then the exit code and the report follow', async () => {
  const exits = [];
  const reports = [];
  const entry = (options) => runAsScript({ mutants: ['catalog'], setExitCode: (code) => exits.push(code), report: (...args) => reports.push(args.join(' ')), ...options });
  const asked = [];
  await entry({ nodeVersion: '22.1.0', run: async (options) => { asked.push(options); return 0; } });
  await entry({ nodeVersion: '24.0.0', run: async () => 1 });
  assert.deepEqual(asked, [{ mutants: ['catalog'] }], 'the catalog reaches the command line');
  assert.deepEqual(exits, [0, 1]);
  assert.deepEqual(reports, []);
  await entry({ nodeVersion: '20.11.0', run: async () => { asked.push('ran'); return 0; } });
  assert.equal(asked.includes('ran'), false, 'an old Node never starts the gate');
  assert.deepEqual(exits, [0, 1, 1]);
  assert.match(reports[0], /Fatal mutation gate error: Precise mutation gate requires Node 22 or newer/);
  await entry({ nodeVersion: '22.0.0', run: async () => { throw new Error('catalog unreadable'); } });
  assert.deepEqual(exits, [0, 1, 1, 1]);
  assert.match(reports[1], /Fatal mutation gate error: catalog unreadable/);
});

test('Given the script is run directly, When it cannot read a test file, Then it reports a fatal error, exits non-zero and leaves the catalog alone', async () => {
  const setup = await fixture();
  try {
    const script = fileURLToPath(new URL('../scripts/run-mutation-tests.mjs', import.meta.url));
    const catalog = fileURLToPath(new URL('../scripts/mutation-selectors.json', import.meta.url));
    const before = await readFile(catalog, 'utf8');
    // The working directory holds none of the catalog's test files: the stale lookup fails before any mutant could run.
    const result = spawnSync(process.execPath, [script, '--calibrate-stale'], { cwd: setup.root, env: { ...process.env, ...setup.env }, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Fatal mutation gate error: /);
    assert.match(result.stderr, Number(process.versions.node.split('.')[0]) >= 22 ? /ENOENT/ : /requires Node 22 or newer/);
    assert.doesNotMatch(result.stdout, /Mutation gate PASSED|Selector catalog is current/);
    assert.equal(await readFile(catalog, 'utf8'), before, 'the catalog is untouched');
  } finally { await cleanup(setup); }
});

test('Given the script module is imported without an entry file, When nothing runs it, Then it only exports the catalog', async () => {
  const setup = await fixture();
  try {
    const script = pathToFileURL(fileURLToPath(new URL('../scripts/run-mutation-tests.mjs', import.meta.url))).href;
    // `node -e` has no entry file. If the guard ran the gate anyway, it would run in this empty directory and fail on the missing test files.
    const code = `process.argv[2] = '--calibrate-stale'; const imported = await import(${JSON.stringify(script)}); console.log(JSON.stringify(Object.keys(imported)));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: setup.root, env: { ...process.env, ...setup.env }, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '["MUTANTS"]');
    assert.equal(result.stderr, '');
  } finally { await cleanup(setup); }
});
