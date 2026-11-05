// Given/When/Then over the release preflight: the facts that are knowable before a review runs.
// Every case uses injected reads or a temporary catalog, so nothing reads the network or the owner's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  MUTANT_CATALOG_FILE,
  VERSION_SOURCES,
  checkAnchors,
  checkFrozen,
  checkSelectors,
  checkVersions,
  runPreflight,
  gateFingerprint,
} from '../scripts/release-preflight.mjs';
import { mutantIdentity, testFileHash } from '../scripts/mutation-runner.mjs';
import { createCertificate, gateRun } from '../src/domain/mutation-certificate.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// A preflight that ever reaches the real store must still land in a throwaway folder: this is what
// keeps a bypassing implementation from pruning the owner's certificates during a test run.
process.env.OMP_REVIEW_KIT_MUTATION_CERT_DIR = await mkdtemp(path.join(tmpdir(), 'review-kit-preflight-test-'));
import { treeFingerprint } from '../scripts/release-preflight.mjs';

/** An in-memory certificate store: no preflight test reads or writes the owner's home folder. */
const memoryStore = (initial = new Map()) => ({
  readCert: async digest => initial.get(digest) ?? null,
  writeCert: async certificate => { initial.set(certificate.run.digest, certificate); return `memory:${certificate.run.digest}`; },
  entries: () => [...initial.entries()],
});

const documents = (version, overrides = {}) => {
  const files = new Map([
    ['package.json', JSON.stringify({ version, omp: { version } })],
    ['.omp-plugin/marketplace.json', JSON.stringify({ plugins: [{ version }] })],
    ['.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ version }] })],
    ['claude-plugin/.claude-plugin/plugin.json', JSON.stringify({ version })],
    ['.codex-plugin/plugin.json', JSON.stringify({ version })],
    ['.agents/plugins/marketplace.json', JSON.stringify({ plugins: [{ version }] })],
    ['CHANGELOG.md', `# Changelog\n\n## [${version}] - 2026-11-01\n`],
  ]);
  for (const [file, content] of Object.entries(overrides)) files.set(file, content);
  return file => {
    if (!files.has(file)) throw new Error(`no such file: ${file}`);
    return Promise.resolve(files.get(file));
  };
};

test('Given every version source and the changelog agree, When the versions are checked, Then the release version is named', async () => {
  const result = await checkVersions({ readFile: documents('1.2.3') });
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.3');
  assert.equal(VERSION_SOURCES.length, 7, 'package version twice, both marketplaces, the Claude manifest and the two Codex manifests');
});

test('Given one catalog still names the previous release, When the versions are checked, Then the disagreement names the files', async () => {
  const result = await checkVersions({
    readFile: documents('1.2.3', { '.omp-plugin/marketplace.json': JSON.stringify({ plugins: [{ version: '1.2.2' }] }) }),
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /version sources disagree/);
  assert.match(result.problems.join('\n'), /\.omp-plugin\/marketplace\.json plugins\.0\.version=1\.2\.2/);
});

test('Given a bumped package without a dated changelog heading, When the versions are checked, Then the changelog is reported', async () => {
  const result = await checkVersions({ readFile: documents('1.2.3', { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n' }) });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /no dated "## \[1\.2\.3\]" heading/);
});

test('Given a mutant whose anchor moved and one whose anchor repeats, When the anchors are checked, Then both are named with their match count', async () => {
  const mutants = [
    { id: 'moved', file: 'src/a.mjs', original: 'const kept = 1;' },
    { id: 'repeated', file: 'src/b.mjs', original: 'return 1;' },
  ];
  const sources = { 'src/a.mjs': 'const renamed = 1;', 'src/b.mjs': 'return 1;\nreturn 1;' };
  const result = await checkAnchors(mutants, { readFile: file => Promise.resolve(sources[file]) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.broken, [
    { id: 'moved', file: 'src/a.mjs', matches: 0 },
    { id: 'repeated', file: 'src/b.mjs', matches: 2 },
  ]);
});

test('Given a deciding test edited after calibration, When the selectors are checked, Then that mutant is stale without running any test', async () => {
  const mutants = [{ id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' }];
  const source = { 'tests/a.test.mjs': 'test("x", () => {});\n' };
  const result = await checkSelectors({
    mutants,
    selectors: { one: { testFile: 'tests/a.test.mjs', tests: ['x'], mutantHash: 'not-the-identity', testHash: 'not-the-bytes' } },
    root: 'E:/nowhere',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.stale, ['one']);
});

test('Given the release is staged and only tooling wrote the rest, When the diff is checked, Then it is frozen enough for a gate run', () => {
  assert.equal(checkFrozen({ status: 'M  src/a.mjs\nA  src/b.mjs\n' }).ok, true, 'the staged release is the diff under review');
  assert.equal(checkFrozen({ status: ' M scripts/mutation-selectors.json\n' }).ok, true, 'the gate owns its catalog');
  assert.equal(checkFrozen({ status: 'M  scripts/mutation-selectors.json\n' }).ok, true);
  assert.equal(checkFrozen({ status: ' M src/a.mjs\n' }).ok, false, 'a finding is still being written');
  assert.equal(checkFrozen({ status: '?? src/new.mjs\n' }).ok, false, 'an untracked file is work in progress');
  assert.deepEqual(checkFrozen({ status: ' M src/a.mjs\n' }).pending, [' M src/a.mjs']);
});

test('Given only report files are pending, When the diff is checked for a frozen state, Then the reports do not keep it open', () => {
  assert.equal(checkFrozen({ status: '?? audit-reports/some.log\n M src/a.mjs\n' }).ok, false);
  assert.deepEqual(checkFrozen({ status: '?? audit-reports/some.log\n' }).pending, []);
  assert.equal(checkFrozen({ status: '?? audit-reports/some.log\n' }).ok, true);
});

test('Given bytes that move while the gate runs, When a recalibration is requested, Then the verdict certifies nothing and says so', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const lines = [];
  let gateRan = false;
  const trees = ['first', 'second'];
  let treeCalls = 0;
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...memoryStore(),
    pruneCert: async () => 0,
    pruneCert: async () => 0,
    treeHash: async () => trees[Math.min(treeCalls++, trees.length - 1)],
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async (file) => (file === mutant.file ? 'a' : file === mutant.testFile ? (gateRan ? 'edited during the run' : 'test("x", () => {});') : file === 'scripts/mutation-selectors.json' ? JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } }) : documents('1.2.3')(file)),
    status: () => Promise.resolve(''),
    findStale: async () => [],
    runCommand: async () => { gateRan = true; return 0; },
  });
  assert.equal(code, 1, 'a gate run whose bytes moved certifies nothing, so the preflight fails');
  assert.match(lines.join('\n'), /the gate run changed the certified bytes/);
});

test('Given a finding is still being written, When a recalibration is requested, Then the gate never starts', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const lines = [];
  const spawned = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...memoryStore(),
    pruneCert: async () => 0,
    pruneCert: async () => 0,
    treeHash: async () => 'frozen-tree',
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async (file) => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } }) : documents('1.2.3')(file)),
    status: () => Promise.resolve(' M src/a.mjs\n'),
    findStale: async () => [],
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  assert.equal(code, 1, 'recalibration without a frozen tree is refused even without --require-frozen');
  assert.deepEqual(spawned.filter(line => line.includes('run-mutation-tests.mjs')), []);
  assert.match(lines.join('\n'), /not frozen, so nothing was calibrated or committed/);
});

test('Given a frozen diff and a stale selector, When a recalibration is requested, Then the gate runs once and the catalog is checked again', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const spawned = [];
  const lines = [];
  let staleChecks = 0;
  const store = memoryStore();
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...store,
    pruneCert: async () => 0,
    treeHash: async () => 'frozen-tree',
    log: line => lines.push(line),
    mutants: [mutant],
    status: () => Promise.resolve(''),
    readFile: async (file) => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.24.1')(file)),
    findStale: async () => { staleChecks += 1; return staleChecks === 1 ? [mutant] : []; },
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  const gateRuns = spawned.filter(line => line.includes('run-mutation-tests.mjs'));
  assert.equal(gateRuns.length, 1, 'exactly one gate run proves the catalog');
  assert.match(lines.join('\n'), /recalibration - selectors re-proved/);
  assert.equal(code, 0);
});

test('Given overlapping mutants, When the fingerprint is taken, Then only the deduplicated path set and the mutant definitions matter', async () => {
  const mutantA = { id: 'a', file: 'src/a.mjs', testFile: 'tests/shared.test.mjs', original: 'x', replacement: 'y' };
  const mutantB = { id: 'b', file: 'src/b.mjs', testFile: 'tests/shared.test.mjs', original: 'p', replacement: 'q' };
  const sources = { 'src/a.mjs': 'a', 'src/b.mjs': 'b', 'tests/shared.test.mjs': 'test("x", () => {});' };
  const read = async file => sources[file];

  const ordered = await gateFingerprint({ mutants: [mutantA, mutantB], readFile: read });
  const reversed = await gateFingerprint({ mutants: [mutantB, mutantA], readFile: read });
  assert.equal(ordered, reversed, 'the catalog order does not change the digest');

  const once = await gateFingerprint({ mutants: [mutantA], readFile: read });
  const twice = await gateFingerprint({ mutants: [mutantA, mutantA], readFile: read });
  assert.equal(once, twice, 'a repeated mutant does not change the digest');

  const renamed = await gateFingerprint({ mutants: [{ ...mutantA, file: 'src/a-copy.mjs' }], readFile: async file => sources[file] ?? 'a' });
  assert.notEqual(once, renamed, 'another path with identical bytes is another input');

  sources['src/a.mjs'] = 'changed';
  const edited = await gateFingerprint({ mutants: [mutantA], readFile: read });
  assert.notEqual(once, edited, 'changed target bytes change the digest');

  // The gate process loads the catalog from disk: those bytes are certified as well.
  const catalogBytes = { value: 'export const MUTANTS = [];' };
  const readWithCatalog = async (file) => (file === MUTANT_CATALOG_FILE ? catalogBytes.value : sources[file] ?? (file === 'tests/shared.test.mjs' ? sources['tests/shared.test.mjs'] : ''));
  const beforeCatalog = await gateFingerprint({ mutants: [mutantA], readFile: readWithCatalog });
  catalogBytes.value = 'export const MUTANTS = [{ id: "new" }];';
  const afterCatalog = await gateFingerprint({ mutants: [mutantA], readFile: readWithCatalog });
  assert.notEqual(beforeCatalog, afterCatalog, 'an edit to the mutant catalog source changes the digest');

  // Same paths, same bytes, different curated definition: only the definition can tell them apart.
  const editedDefinition = { ...mutantA, original: 'x-changed' };
  const plain = await gateFingerprint({ mutants: [mutantA], readFile: read });
  const retargeted = await gateFingerprint({ mutants: [editedDefinition], readFile: read });
  assert.notEqual(plain, retargeted, 'an edited mutant definition changes the digest');
});

test('Given a diff that must not move, When a recalibration is requested while it is pending, Then the preflight stops before the gate', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const spawned = [];
  const lines = [];
  const code = await runPreflight({
    argv: ['--require-frozen', '--recalibrate', '--skip-tests'],
    ...memoryStore(),
    pruneCert: async () => 0,
    treeHash: async () => 'frozen-tree',
    log: line => lines.push(line),
    readFile: async (file) => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } }) : documents('0.24.1')(file)),
    mutants: [mutant],
    findStale: async () => [mutant],
    status: () => Promise.resolve(' M src/a.mjs\n'),
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  assert.equal(code, 1);
  assert.equal(spawned.some(line => line.includes('run-mutation-tests.mjs')), false, 'no gate run started');
  assert.match(lines.join('\n'), /not frozen, so nothing was calibrated/);
});

test('Given a certificate from the previous run of the same bytes, When a recalibration is requested, Then the gate does not run again', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const read = async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file));
  const digest = await treeFingerprint({ mutants: [mutant], readFile: read, treeHash: 'frozen-tree' });
  const store = memoryStore(new Map([[digest, createCertificate(gateRun({ digest, mutants: 1, durationMs: 210_000 }), { createdAt: '2026-11-02T00:00:00.000Z' })]]));
  const spawned = [];
  const lines = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...store,
    pruneCert: async () => 0,
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: read,
    status: () => Promise.resolve(''),
    treeHash: async () => 'frozen-tree',
    findStale: async () => [],
    now: () => Date.parse('2026-11-02T00:05:00.000Z'),
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawned.filter(line => line.includes('run-mutation-tests.mjs')), [], 'no gate run on certified bytes');
  assert.match(lines.join('\n'), /mutation certificate - 1\/1 mutants proved in 210s, 5 min old/);
});

test('Given a certificate stored for other bytes, When a recalibration is requested, Then the gate runs and the new proof is stored', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const read = async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file));
  const otherDigest = await treeFingerprint({ mutants: [mutant], readFile: read, treeHash: 'other-tree' });
  const store = memoryStore(new Map([[otherDigest, createCertificate(gateRun({ digest: otherDigest, mutants: 1, durationMs: 1000 }))]]));
  const spawned = [];
  const lines = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...store,
    pruneCert: async () => 0,
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: read,
    status: () => Promise.resolve(''),
    treeHash: async () => 'frozen-tree',
    findStale: async () => [],
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  assert.equal(code, 0);
  assert.equal(spawned.filter(line => line.includes('run-mutation-tests.mjs')).length, 1, 'one gate run proves the new bytes');
  const digest = await treeFingerprint({ mutants: [mutant], readFile: read, treeHash: 'frozen-tree' });
  assert.equal((await store.readCert(digest))?.run.mutants, 1, 'the run stored its proof for these bytes');
  assert.match(lines.join('\n'), /stored for these bytes/);
});

test('Given a gate run that passed, When the certificate cannot be written, Then the preflight still passes and says the run repeats', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const lines = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    log: line => lines.push(line),
    mutants: [mutant],
    readCert: async () => null,
    writeCert: async () => { throw new Error('disk full'); },
    readFile: async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file)),
    status: () => Promise.resolve(''),
    treeHash: async () => 'frozen-tree',
    findStale: async () => [],
    runCommand: async () => 0,
  });
  assert.equal(code, 0, 'a failed write never fails the release');
  assert.match(lines.join('\n'), /the proof was not stored \(disk full\)/);
});

test('Given any recalibration, When the preflight finishes, Then the review-round warning is in the output an agent reads', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const lines = [];
  await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...memoryStore(),
    pruneCert: async () => 0,
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file)),
    status: () => Promise.resolve(''),
    treeHash: async () => 'frozen-tree',
    findStale: async () => [],
    runCommand: async () => 0,
  });
  assert.match(lines.join('\n'), /A review round in progress is not a reason to recalibrate/);
});

test('Given the same gate inputs and another tree, When the digest is taken, Then an unrelated edit outside the mutant files still invalidates the proof', async () => {
  const mutant = { id: 'a', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'x', replacement: 'y' };
  const read = async () => 'bytes';
  const one = await treeFingerprint({ mutants: [mutant], readFile: read, treeHash: 'tree-1' });
  const two = await treeFingerprint({ mutants: [mutant], readFile: read, treeHash: 'tree-2' });
  assert.notEqual(one, two, 'a deciding test imports modules that are not mutant targets');
});

test('Given a gate that recalibrates and rewrites its own catalog, When the bytes are compared, Then the catalog write is not mistaken for a moving review', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  let catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const lines = [];
  const store = memoryStore();
  const emitted = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...store,
    pruneCert: async () => 0,
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file)),
    status: () => Promise.resolve(''),
    treeHash: async () => 'frozen-tree',
    findStale: async () => [],
    runCommand: async () => {
      // The gate rewrites its selector catalog as a side effect of recalibration.
      catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'], recalibrated: true } } });
      return 0;
    },
  });
  assert.equal(code, 0, 'the gate owns its catalog: writing it does not certify nothing');
  assert.match(lines.join('\n'), /gate snapshot - the bytes did not move during the gate run/);
  const stored = store.entries();
  assert.equal(stored.length, 1, 'one certificate was stored');
  assert.equal(stored[0][1].run.mutants, 1);
  const withOldCatalog = await treeFingerprint({ mutants: [mutant], readFile: async file => (file === 'scripts/mutation-selectors.json' ? '{"one":["x"]}' : file === mutant.testFile ? 'test("x", () => {});' : 'a'), treeHash: 'frozen-tree' });
  assert.notEqual(stored[0][0], withOldCatalog, 'the stored proof uses the catalog the run ended with');
  assert.deepEqual(emitted, []);
});

test('Given the same tree and another selector catalog, When the digest is taken, Then a repointed selector is another proof input', async () => {
  const mutant = { id: 'a', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'x', replacement: 'y' };
  const read = async file => (file === 'scripts/mutation-selectors.json' ? '{"one":["weak test"]}' : 'bytes');
  const weak = await treeFingerprint({ mutants: [mutant], readFile: read, treeHash: 'same-tree' });
  const strongRead = async file => (file === 'scripts/mutation-selectors.json' ? '{"one":["the deciding test"]}' : 'bytes');
  const strong = await treeFingerprint({ mutants: [mutant], readFile: strongRead, treeHash: 'same-tree' });
  assert.notEqual(weak, strong, 'a selector map names the deciding tests, so it is certified too');
});

test('Given the tree cannot be hashed before the run, When a recalibration is requested, Then no gate runs and nothing is certified', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const spawned = [];
  const lines = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...memoryStore(),
    pruneCert: async () => 0,
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file)),
    status: () => Promise.resolve(''),
    treeHash: async () => null,
    findStale: async () => [],
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  assert.equal(code, 1, 'an unprovable tree is a failure, not a silent pass');
  assert.deepEqual(spawned.filter(line => line.includes('run-mutation-tests.mjs')), []);
  assert.match(lines.join('\n'), /the working tree could not be hashed, so no gate run can be certified/);
});

test('Given the tree cannot be hashed after the run, When the gate passed, Then the verdict is not tied to the current bytes', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const trees = ['before', null];
  let calls = 0;
  const lines = [];
  const store = memoryStore();
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    ...store,
    pruneCert: async () => 0,
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file)),
    status: () => Promise.resolve(''),
    treeHash: async () => trees[Math.min(calls++, trees.length - 1)],
    findStale: async () => [],
    runCommand: async () => 0,
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /the tree could not be hashed after the gate run/);
  assert.deepEqual(store.entries(), [], 'no certificate is stored for an unprovable tree');
});

test('Given a gate run that passed, When the preflight is asked to recalibrate, Then the proof is written first, pruned once, and a failing prune never fails the release', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const lines = [];
  const order = [];
  let prunes = 0;
  const store = memoryStore();
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    readCert: store.readCert,
    writeCert: async certificate => { order.push('write'); return store.writeCert(certificate); },
    pruneCert: async () => { prunes += 1; order.push('prune'); throw new Error('locked folder'); },
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async file => (file === mutant.file ? 'a' : file === mutant.testFile ? 'test("x", () => {});' : file === 'scripts/mutation-selectors.json' ? catalog : documents('0.25.3')(file)),
    status: () => Promise.resolve(''),
    treeHash: async () => 'frozen-tree',
    findStale: async () => [],
    runCommand: async () => 0,
  });
  assert.equal(code, 0, 'a failing prune is cleanup, not a verdict');
  assert.deepEqual(order, ['write', 'prune'], 'the proof is stored before the folder is pruned');
  assert.equal(prunes, 1, 'the injected pruner is the one the release uses');
  assert.match(lines.join('\n'), /mutation certificate - .*stored for these bytes/);
});
