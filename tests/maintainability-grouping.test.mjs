// Given/When/Then over deterministic grouping: maximal groups, the test-class and generated-file
// exclusions, snapshot-wide support, and the truncation flag. Pure: signatures are constructed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupClumps, isGeneratedPath } from '../src/native/maintainability/group.mjs';
import { resolveConfig } from '../src/native/maintainability/config.mjs';

const config = resolveConfig();
const definition = (filePath, params, line = 1) => ({
  path: filePath,
  language: 'javascript',
  name: `f${line}`,
  params: [...params].sort(),
  lineStart: line,
  lineEnd: line,
  role: 'definition',
});

const group = ({ signatures, changedPaths, classOf = () => 'executable', supportComplete = true }) => groupClumps({
  signatures,
  classOf,
  changedPaths,
  config,
  supportComplete,
});

test('Given a group that is a subset of a larger group with the same support, When grouped, Then only the larger group is reported', () => {
  const signatures = [
    definition('src/a.mjs', ['a', 'b', 'c'], 1),
    definition('src/b.mjs', ['a', 'b', 'c'], 2),
    definition('src/c.mjs', ['a', 'b', 'c'], 3),
    definition('src/d.mjs', ['a', 'b', 'c'], 4),
  ];
  const result = group({ signatures, changedPaths: ['src/a.mjs'] });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].params, ['a', 'b', 'c']);
  assert.equal(result.groups[0].support, 4);
});

test('Given sites below the support threshold, When grouped, Then no group is reported', () => {
  const signatures = [
    definition('src/a.mjs', ['a', 'b']),
    definition('src/b.mjs', ['a', 'b'], 3),
    definition('src/c.mjs', ['a', 'b'], 5),
  ];
  assert.deepEqual(group({ signatures, changedPaths: ['src/a.mjs'] }).groups, []);
});

test('Given the same parameters in a test file, When grouped, Then the test file raises no support and the exclusion is recorded', () => {
  const signatures = [
    definition('src/a.mjs', ['a', 'b']),
    definition('src/b.mjs', ['a', 'b'], 3),
    definition('src/c.mjs', ['a', 'b'], 5),
    definition('tests/a.test.mjs', ['a', 'b'], 7),
  ];
  const result = group({
    signatures,
    changedPaths: ['src/a.mjs'],
    classOf: filePath => (filePath.startsWith('tests/') ? 'test' : 'executable'),
  });
  assert.deepEqual(result.groups, [], 'three source sites stay below the threshold of four');
  assert.deepEqual(result.excluded, [{ path: 'tests/a.test.mjs', ground: 'test-class' }]);
});

test('Given sixteen sites and a change that touches two of them, When grouped, Then support is sixteen and the staged touch count is two', () => {
  const signatures = Array.from({ length: 16 }, (_, index) => definition(`src/f${index}.mjs`, ['sessionId', 'runRoot', 'attemptId'], index + 1));
  const result = group({ signatures, changedPaths: ['src/f0.mjs', 'src/f1.mjs'] });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].support, 16);
  assert.equal(result.groups[0].stagedTouchCount, 2);
  assert.equal(result.groups[0].occurrences.filter(occurrence => occurrence.inStagedDiff).length, 2);
});

test('Given a group that appears only outside the change, When grouped, Then it is not a candidate for this change', () => {
  const signatures = Array.from({ length: 4 }, (_, index) => definition(`src/other${index}.mjs`, ['a', 'b'], index + 1));
  assert.deepEqual(group({ signatures, changedPaths: ['src/changed.mjs'] }).groups, []);
});

test('Given a truncated scan, When grouped, Then the group carries supportComplete false so support reads as a lower bound', () => {
  const signatures = Array.from({ length: 4 }, (_, index) => definition(`src/f${index}.mjs`, ['a', 'b'], index + 1));
  const result = group({ signatures, changedPaths: ['src/f0.mjs'], supportComplete: false });
  assert.equal(result.groups[0].supportComplete, false);
});

test('Given a signature with more parameters than the cap, When grouped, Then it is excluded with its ground instead of exploding the subsets', () => {
  const signatures = [
    definition('src/a.mjs', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']),
    definition('src/b.mjs', ['a', 'b']),
  ];
  const result = group({ signatures, changedPaths: ['src/a.mjs'] });
  assert.deepEqual(result.excluded, [{ path: 'src/a.mjs', ground: 'oversized-signature' }]);
});

test('Given build output, When checked, Then it is a generated path and never becomes a candidate', () => {
  for (const filePath of ['dist/app.js', 'src/build/step.mjs', 'vendor/x.mjs', 'src/app.min.js', 'out/a.bundle.js']) {
    assert.equal(isGeneratedPath(filePath), true, filePath);
  }
  for (const filePath of ['src/app.mjs', 'scripts/build.mjs', 'src/outbox.mjs']) {
    assert.equal(isGeneratedPath(filePath), false, filePath);
  }
});

test('Given a change touching only generated code, When grouped, Then the generated site is excluded with its ground', () => {
  const signatures = [
    definition('dist/app.js', ['a', 'b']),
    definition('src/a.mjs', ['a', 'b']),
    definition('src/b.mjs', ['a', 'b'], 3),
    definition('src/c.mjs', ['a', 'b'], 5),
  ];
  const result = group({ signatures, changedPaths: ['dist/app.js', 'src/a.mjs'] });
  assert.deepEqual(result.excluded, [{ path: 'dist/app.js', ground: 'generated' }]);
  assert.deepEqual(result.groups, [], 'the remaining three sites stay below the threshold');
});
