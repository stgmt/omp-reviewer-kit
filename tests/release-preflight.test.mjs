// Given/When/Then over the release preflight: the facts that are knowable before a review runs.
// Every case uses injected reads or a temporary catalog, so nothing reads the network or the owner's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

const documents = (version, overrides = {}) => {
  const files = new Map([
    ['package.json', JSON.stringify({ version, omp: { version } })],
    ['.omp-plugin/marketplace.json', JSON.stringify({ plugins: [{ version }] })],
    ['.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ version }] })],
    ['claude-plugin/.claude-plugin/plugin.json', JSON.stringify({ version })],
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
  assert.equal(VERSION_SOURCES.length, 5, 'package version, plugin version, two catalogs and the Claude manifest');
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

test('Given only report files are pending, When the diff is checked for a frozen state, Then the reports do not keep it open', () => {
  assert.equal(checkFrozen({ status: '?? audit-reports/some.log\n M src/a.mjs\n' }).ok, false);
  assert.deepEqual(checkFrozen({ status: '?? audit-reports/some.log\n' }).pending, []);
  assert.equal(checkFrozen({ status: '?? audit-reports/some.log\n' }).ok, true);
});

test('Given a working tree that a review is still changing, When a recalibration is requested, Then the preflight names the pending paths and still refuses to certify a moving run', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const lines = [];
  let gateRan = false;
  let staleChecks = 0;
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    log: line => lines.push(line),
    mutants: [mutant],
    readFile: async (file) => (file === mutant.file ? 'a' : file === mutant.testFile ? (gateRan ? 'edited during the run' : 'test("x", () => {});') : file === 'scripts/mutation-selectors.json' ? JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } }) : documents('1.2.3')(file)),
    status: () => Promise.resolve(' M src/a.mjs\n'),
    findStale: async () => (staleChecks++ === 0 ? [mutant] : []),
    runCommand: async () => { gateRan = true; return 0; },
  });
  assert.equal(code, 1, 'a gate run whose bytes moved certifies nothing, so the preflight fails');
  assert.match(lines.join('\n'), /pending change\(s\) - run the gate only after the review's last finding/);
  assert.match(lines.join('\n'), /the gate run changed the certified bytes/);
});

test('Given a frozen diff and a stale selector, When a recalibration is requested, Then the gate runs once and the catalog is checked again', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const catalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const spawned = [];
  const lines = [];
  let staleChecks = 0;
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
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
