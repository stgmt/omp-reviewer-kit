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

const callSite = (filePath, params, line = 1) => ({
  path: filePath,
  language: 'javascript',
  name: null,
  params: [...params].sort(),
  lineStart: line,
  lineEnd: line,
  role: 'call-site',
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
  // Three parameters and four declarations: a group the cost signal would otherwise deliver, so
  // only the "nothing in the change" rule can keep it out.
  const signatures = Array.from({ length: 4 }, (_, index) => definition(`src/other${index}.mjs`, ['alpha', 'beta', 'gamma'], index + 1));
  assert.deepEqual(group({ signatures, changedPaths: ['src/changed.mjs'] }).groups, []);
});

test('Given a truncated scan, When grouped, Then the group carries supportComplete false so support reads as a lower bound', () => {
  const signatures = Array.from({ length: 4 }, (_, index) => definition(`src/f${index}.mjs`, ['alpha', 'beta', 'gamma'], index + 1));
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

test('Given a group declared by two functions and used by their callers, When grouped, Then it is delivered as a candidate', () => {
  const signatures = [
    definition('src/a.mjs', ['sessionId', 'runRoot', 'attemptId'], 10),
    definition('src/b.mjs', ['sessionId', 'runRoot', 'attemptId'], 20),
    callSite('src/c.mjs', ['sessionId', 'runRoot', 'attemptId'], 30),
    callSite('src/d.mjs', ['sessionId', 'runRoot', 'attemptId'], 40),
  ];
  const result = group({ signatures, changedPaths: ['src/a.mjs'] });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].params, ['attemptId', 'runRoot', 'sessionId']);
  assert.equal(result.belowSignal.length, 0);
});

test('Given a group whose every occurrence is a call, When grouped, Then it is kept out as a dependency option bag, not delivered', () => {
  const signatures = Array.from({ length: 5 }, (_, index) => callSite(`src/f${index}.mjs`, ['force', 'recursive'], index + 1));
  const result = group({ signatures, changedPaths: ['src/f0.mjs'] });
  assert.deepEqual(result.groups, []);
  assert.equal(result.belowSignal.length, 1);
  assert.equal(result.belowSignal[0].ground, 'foreign-signature');
  assert.equal(result.belowSignalByReason['foreign-signature'], 1);
  assert.match(result.belowSignal[0].at, /^src\//);
});

test('Given a group declared by exactly one function and called from many places, When grouped, Then it is a signature, not a repetition', () => {
  const signatures = [
    definition('src/options.mjs', ['dir', 'force', 'recursive'], 5),
    ...Array.from({ length: 4 }, (_, index) => callSite(`src/u${index}.mjs`, ['dir', 'force', 'recursive'], index + 10)),
  ];
  const result = group({ signatures, changedPaths: ['src/options.mjs'] });
  assert.deepEqual(result.groups, []);
  assert.equal(result.belowSignal[0].ground, 'single-definition');
  assert.equal(result.belowSignalByReason['single-definition'], 1);
});

test('Given a pair of parameters repeated across two functions, When grouped, Then it is an ambient pair and is not delivered', () => {
  const signatures = [
    definition('src/a.mjs', ['cwd', 'env'], 3),
    definition('src/b.mjs', ['cwd', 'env'], 7),
    callSite('src/c.mjs', ['cwd', 'env'], 9),
    callSite('src/d.mjs', ['cwd', 'env'], 11),
  ];
  const result = group({ signatures, changedPaths: ['src/a.mjs'] });
  assert.deepEqual(result.groups, []);
  assert.equal(result.belowSignal[0].ground, 'parameter-pair');
});

test('Given candidates filtered by all three grounds, When grouped, Then every ground is counted so nothing vanishes silently', () => {
  const signatures = [
    ...Array.from({ length: 4 }, (_, index) => callSite(`src/x${index}.mjs`, ['alpha', 'beta'], index + 1)),
    definition('src/one.mjs', ['gamma', 'delta', 'epsilon'], 20),
    ...Array.from({ length: 3 }, (_, index) => callSite(`src/y${index}.mjs`, ['gamma', 'delta', 'epsilon'], index + 21)),
    definition('src/pair-a.mjs', ['zeta', 'eta'], 30),
    definition('src/pair-b.mjs', ['zeta', 'eta'], 31),
    callSite('src/pair-c.mjs', ['zeta', 'eta'], 32),
    callSite('src/pair-d.mjs', ['zeta', 'eta'], 33),
  ];
  const result = group({ signatures, changedPaths: ['src/x0.mjs', 'src/one.mjs', 'src/pair-a.mjs'] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.belowSignalByReason, { 'foreign-signature': 1, 'single-definition': 1, 'parameter-pair': 1 });
  assert.equal(result.belowSignal.length, 3);
});
