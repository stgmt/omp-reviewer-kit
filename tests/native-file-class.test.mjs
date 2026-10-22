// Given/When/Then over the file classes that choose the review profile. Pure: path and mode only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedPaths, classifyFilePath, reviewProfileFor } from '../src/domain/file-class.mjs';

test('Given a dotless build name, When classified, Then it is executable, and a license name is not', () => {
  assert.equal(classifyFilePath('Makefile'), 'executable');
  assert.equal(classifyFilePath('LICENSE'), 'data');
});

test('Given a name with a trailing dot or space, When classified, Then the name Windows writes is classified', () => {
  assert.equal(classifyFilePath('run.js.'), 'executable');
  assert.equal(classifyFilePath('run.js '), 'executable');
});

test('Given an empty path, When classified, Then it is data', () => {
  assert.equal(classifyFilePath(''), 'data');
});

test('Given a data file staged with the executable mode, When classified, Then the mode makes it executable and the profile full', () => {
  const entries = classifyChangedPaths(['tools/run.dat'], () => false, new Map([['tools/run.dat', '100755']]));
  assert.deepEqual(entries, [{ path: 'tools/run.dat', fileClass: 'executable' }]);
  assert.equal(reviewProfileFor(entries), 'full');
});

test('Given the same data file staged without the executable mode, When classified, Then it stays data and the profile is spec-docs', () => {
  const entries = classifyChangedPaths(['tools/run.dat'], () => false, new Map([['tools/run.dat', '100644']]));
  assert.deepEqual(entries, [{ path: 'tools/run.dat', fileClass: 'data' }]);
  assert.equal(reviewProfileFor(entries), 'spec-docs');
});
