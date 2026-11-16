// Given/When/Then over the analysis status, the coverage flag and the unparsed files. Real files in
// a temporary tree; the parser import is the only injected seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeTree } from '../src/native/maintainability/analyze.mjs';
import { resolveConfig } from '../src/native/maintainability/config.mjs';

async function tree(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'maintainability-status-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return root;
}

const fourSharing = (name, prefix = '') => [
  `export function ${prefix}${name}(sessionId, runRoot, attemptId) {`,
  '  return sessionId + runRoot + attemptId;',
  '}',
  '',
].join('\n');

const otherSet = (name) => [
  `export function ${name}(frameWidth, frameHeight, frameSeed) {`,
  '  return frameWidth + frameHeight + frameSeed;',
  '}',
  '',
].join('\n');

const analysisOf = (root, changedPaths, extra = {}) => analyzeTree({
  rootDir: root,
  changedPaths,
  diffHash: 'b'.repeat(64),
  config: resolveConfig(),
  policy: 'block',
  ...extra,
});

test('Given four sites that pass the same three values, When analysed, Then the status is analyzed with one group', async () => {
  const root = await tree({
    'src/a.mjs': [fourSharing('one', 'a'), fourSharing('two', 'b')].join('\n'),
    'src/b.mjs': [fourSharing('three', 'c'), fourSharing('four', 'd')].join('\n'),
  });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs']);
    assert.equal(analysis.status, 'analyzed');
    assert.equal(analysis.groups.length, 1);
    assert.equal(analysis.groups[0].support, 4);
    assert.equal(analysis.coverage, 'full');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a single function, When analysed, Then the status is no-candidates and not unsupported', async () => {
  const root = await tree({ 'src/a.mjs': fourSharing('alone') });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs']);
    assert.equal(analysis.status, 'no-candidates');
    assert.deepEqual(analysis.groups, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a change that touches only a language without an adapter, When analysed, Then the status is unsupported and the file is named', async () => {
  const root = await tree({ 'src/deploy.sh': '#!/bin/sh\necho deploy\n' });
  try {
    const { analysis } = await analysisOf(root, ['src/deploy.sh']);
    assert.equal(analysis.status, 'unsupported');
    assert.deepEqual(analysis.unparsedFiles, [{ path: 'src/deploy.sh', reason: 'unsupported-syntax' }]);
    assert.equal(analysis.coverage, 'full', 'an unanalysable language is excluded, not a partial analysis');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a parser that cannot load, When analysed, Then the status is failed and the failure is named', async () => {
  const root = await tree({ 'src/a.mjs': fourSharing('one') });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs'], {
      loadParser: async () => {
        throw new Error('parser cannot load');
      },
    });
    assert.equal(analysis.status, 'failed');
    assert.equal(analysis.coverage, 'partial');
    assert.equal(analysis.failures[0].reason, 'unavailable-parser');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a supported file with a syntax error, When analysed, Then it is unparsed, coverage is partial and the status is not failed', async () => {
  const root = await tree({
    'src/a.mjs': `${fourSharing('one')}export function broken(\n`,
  });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs']);
    assert.equal(analysis.status, 'no-candidates');
    assert.equal(analysis.coverage, 'partial');
    assert.deepEqual(analysis.unparsedFiles, [{ path: 'src/a.mjs', reason: 'syntax' }]);
    assert.deepEqual(analysis.failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a file over the byte limit, When analysed, Then it is too-large, coverage is partial and nothing was parsed from it', async () => {
  const root = await tree({ 'src/big.mjs': `${fourSharing('one')}${'// pad\n'.repeat(40)}` });
  try {
    const { analysis } = await analysisOf(root, ['src/big.mjs'], { config: resolveConfig({ maxFileBytes: 60 }) });
    assert.deepEqual(analysis.unparsedFiles, [{ path: 'src/big.mjs', reason: 'too-large' }]);
    assert.equal(analysis.coverage, 'partial');
    assert.equal(analysis.scan.filesRead, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a change with no executable file, When analysed, Then the analysis is skipped with its reason instead of pretending to be empty', async () => {
  const root = await tree({ 'docs/readme.md': '# notes\n' });
  try {
    const result = await analysisOf(root, ['docs/readme.md']);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-executable-change');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a changed path the snapshot does not contain, When analysed, Then it is not invented as an unparsed file', async () => {
  const root = await tree({ 'src/a.mjs': fourSharing('one') });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs', 'src/deleted-later.mjs']);
    assert.equal(analysis.status, 'no-candidates');
    assert.equal(analysis.coverage, 'full');
    assert.deepEqual(analysis.unparsedFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given more groups than the ceiling, When analysed, Then the dropped groups are counted and the coverage is partial', async () => {
  const root = await tree({
    'src/a.mjs': [fourSharing('one', 'a'), fourSharing('two', 'b'), otherSet('three'), otherSet('four')].join('\n'),
    'src/b.mjs': [fourSharing('five', 'c'), fourSharing('six', 'd'), otherSet('seven'), otherSet('eight')].join('\n'),
  });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs'], { config: resolveConfig({ maxGroups: 1 }) });
    assert.equal(analysis.groups.length, 1);
    assert.equal(analysis.droppedGroups, 1);
    assert.equal(analysis.coverage, 'partial');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given candidates inside the ceiling, When analysed, Then nothing is reported as dropped', async () => {
  const root = await tree({
    'src/a.mjs': [fourSharing('one', 'a'), fourSharing('two', 'b')].join('\n'),
    'src/b.mjs': [fourSharing('three', 'c'), fourSharing('four', 'd')].join('\n'),
  });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs']);
    assert.equal(analysis.droppedGroups, 0);
    assert.equal(analysis.coverage, 'full');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a maximal group the cost signal keeps out, When analysed, Then the artifact states the ground and the count instead of reading as nothing there', async () => {
  // Two functions declaring the same pair, plus two call sites: a maximal group that reaches the
  // delivery filter and fails it as an ambient pair.
  const root = await tree({
    'src/a.mjs': 'export function one(cwd, env) {\n  return cwd + env;\n}\n\nexport function two(cwd, env) {\n  return cwd + env;\n}\n',
    'src/b.mjs': 'export const three = (x) => x;\nthree({ cwd: 1, env: 2 });\nthree({ cwd: 3, env: 4 });\n',
  });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs']);
    assert.equal(analysis.groups.length, 0);
    assert.equal(analysis.status, 'no-candidates');
    assert.equal(analysis.belowSignal.count, 1);
    assert.equal(analysis.belowSignal.byReason['parameter-pair'], 1);
    assert.equal(analysis.belowSignal.examples.length, 1);
    assert.deepEqual(analysis.belowSignal.examples[0].params, ['cwd', 'env']);
    // The kept-out population is analysed, not unanalysed: coverage stays full.
    assert.equal(analysis.coverage, 'full');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given more kept-out groups than the sample bound, When analysed, Then the count is exact and only the examples are capped', async () => {
  // Twelve single-declaration groups: each one is kept out as `single-definition`.
  const declarations = [];
  const callers = [];
  for (let index = 0; index < 12; index += 1) {
    const params = `p${index}a, p${index}b, p${index}c`;
    declarations.push(`export function f${index}(${params}) {\n  return ${params.replace(/, /g, ' + ')};\n}`);
    // Three object-literal call sites per declaration: the group reaches the support threshold with a
    // single declaration, so only the cost signal can keep it out.
    for (let call = 0; call < 3; call += 1) {
      callers.push(`f${index}({ p${index}a: 1, p${index}b: 2, p${index}c: 3 });`);
    }
  }
  const root = await tree({ 'src/a.mjs': `${declarations.join('\n\n')}\n`, 'src/calls.mjs': `${callers.join('\n')}\n` });
  try {
    const { analysis } = await analysisOf(root, ['src/a.mjs']);
    assert.equal(analysis.belowSignal.count, 12);
    assert.equal(analysis.belowSignal.byReason['single-definition'], 12);
    assert.equal(analysis.belowSignal.examples.length, 10, 'the list is a sample, the count is exact');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
