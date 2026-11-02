// Given/When/Then over the mutation catalog itself: every curated mutant must point at text its target
// file really contains exactly once, and every recorded selector must still name a test that exists in
// the file it claims. A mistyped anchor or a renamed deciding test is otherwise discovered only when
// the gate (or the release preflight that runs it) fails on bytes that already look committed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MUTANTS } from '../scripts/run-mutation-tests.mjs';
import { mutantIdentity, testFileHash } from '../scripts/mutation-runner.mjs';

const catalog = JSON.parse(await readFile('scripts/mutation-selectors.json', 'utf8'));
const fileCache = new Map();
const sourceOf = async (file) => {
  if (!fileCache.has(file)) fileCache.set(file, (await readFile(file, 'utf8')).replace(/\r\n/g, '\n'));
  return fileCache.get(file);
};

test('Given the catalog, When every anchor is matched against its target file, Then each matches exactly once', async () => {
  const broken = [];
  for (const mutant of MUTANTS) {
    const source = await sourceOf(mutant.file);
    const count = source.split(mutant.original.replace(/\r\n/g, '\n')).length - 1;
    if (count !== 1) broken.push(`${mutant.id}: anchor matches ${count} times in ${mutant.file}`);
  }
  assert.deepEqual(broken, []);
});

test('Given the catalog, When mutant ids are collected, Then they are unique and every one is described', () => {
  const ids = MUTANTS.map((mutant) => mutant.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate mutant id');
  for (const mutant of MUTANTS) {
    assert.equal(typeof mutant.description, 'string');
    assert.ok(mutant.description.length > 0, `${mutant.id} has no description`);
    assert.notEqual(mutant.original, mutant.replacement, `${mutant.id} changes nothing`);
  }
});

test('Given the selector catalog, When it is compared with the mutants, Then every mutant has a current selector', async () => {
  const problems = [];
  for (const mutant of MUTANTS) {
    const mapping = catalog.mappings[mutant.id];
    // A selector that does not exist yet is not drift: the gate refuses an incomplete catalog before it
    // runs a mutant (run-mutation-tests.mjs) and the release preflight reports the same through
    // findStaleMutants, which is where a missing entry has to be fixed. This test guards the entries
    // that do exist, whose staleness would otherwise surface only at gate or release time.
    if (!mapping) continue;
    if (mapping.testFile !== mutant.testFile) problems.push(`${mutant.id}: selector names ${mapping.testFile}, mutant names ${mutant.testFile}`);
    if (!Array.isArray(mapping.tests) || mapping.tests.length === 0) problems.push(`${mutant.id}: selector names no test`);
    if (mapping.mutantHash !== mutantIdentity(mutant)) problems.push(`${mutant.id}: selector was proven against other mutant bytes`);
    // The hash is the proof that the named tests still are the tests the selector was proven on: a
    // renamed, deleted or rewritten deciding test changes the file bytes, so the gate recalibrates.
    // Comparing titles against the source text is not a substitute, because a title is built at run
    // time (interpolation, describe prefixes) and does not appear literally in the file.
    const testText = await sourceOf(mutant.testFile);
    if (mapping.testHash !== testFileHash(testText)) problems.push(`${mutant.id}: deciding test file changed since calibration`);
  }
  assert.deepEqual(problems, []);
});

test('Given the selector catalog, When it is read, Then it claims no mutant the catalog does not hold', () => {
  const known = new Set(MUTANTS.map((mutant) => mutant.id));
  const unknown = Object.keys(catalog.mappings).filter((id) => !known.has(id));
  assert.deepEqual(unknown, [], 'a selector for a mutant that no longer exists');
  assert.equal(catalog.schema, 'mutation-selectors@1');
  for (const mapping of Object.values(catalog.mappings)) {
    assert.ok(typeof mapping.testFile === 'string' && mapping.testFile.startsWith('tests/'), 'a selector must name a test file');
    assert.equal(path.extname(mapping.testFile), '.mjs');
  }
});
