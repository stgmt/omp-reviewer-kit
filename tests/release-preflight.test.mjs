// Given/When/Then over the release preflight: the facts that are knowable before a review runs.
// Every case uses injected reads or a temporary catalog, so nothing reads the network or the owner's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERSION_SOURCES,
  checkAnchors,
  checkFrozen,
  checkSelectors,
  checkVersions,
  runPreflight,
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

test('Given a diff that a review is still changing, When a recalibration is requested, Then it is refused in place of a gate run', async () => {
  const spawned = [];
  const lines = [];
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    log: line => lines.push(line),
    readFile: documents('1.2.3'),
    mutants: [],
    status: () => Promise.resolve(' M src/a.mjs\n'),
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  assert.equal(code, 1, 'the preflight fails instead of proving selectors on a moving diff');
  assert.equal(spawned.some(line => line.includes('run-mutation-tests.mjs')), false, 'no mutation gate ran');
  assert.match(lines.join('\n'), /not frozen, recalibration refused/);
});

test('Given a frozen diff and a stale selector, When a recalibration is requested, Then the gate runs once and the catalog is checked again', async () => {
  const mutant = { id: 'one', file: 'src/a.mjs', testFile: 'tests/a.test.mjs', original: 'a', replacement: 'b' };
  const staleCatalog = JSON.stringify({ schema: 'mutation-selectors@1', mappings: { one: { tests: ['x'] } } });
  const spawned = [];
  const lines = [];
  let catalogReads = 0;
  let staleChecks = 0;
  const readFile = async (file) => {
    if (file === 'scripts/mutation-selectors.json') return catalogReads++ === 0 ? staleCatalog : staleCatalog;
    if (file === mutant.file) return mutant.original;
    return documents('1.2.3')(file);
  };
  const code = await runPreflight({
    argv: ['--recalibrate', '--skip-tests'],
    log: line => lines.push(line),
    readFile,
    mutants: [mutant],
    status: () => Promise.resolve(''),
    findStale: async () => { staleChecks += 1; return staleChecks === 1 ? [mutant] : []; },
    runCommand: async (command, args) => { spawned.push([command, ...args].join(' ')); return 0; },
  });
  const gateRuns = spawned.filter(line => line.includes('run-mutation-tests.mjs'));
  assert.equal(gateRuns.length, 1, 'exactly one gate run proves the catalog');
  assert.match(lines.join('\n'), /recalibration - selectors re-proved/);
  assert.equal(typeof code, 'number');
});
