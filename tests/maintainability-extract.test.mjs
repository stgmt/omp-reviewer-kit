// Given/When/Then over deterministic signature extraction: two adapters, explicit unparsed files,
// and the scan limits. Real files in a temporary tree; the fallback parser import is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractSignatures } from '../src/native/maintainability/extract.mjs';
import { resolveConfig } from '../src/native/maintainability/config.mjs';

async function tree(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'maintainability-extract-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return root;
}

const config = resolveConfig();
const pythonPresent = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;

test('Given a JavaScript file, When extracted, Then the definition, the forwarder and the call-site are told apart with exact lines', async () => {
  const root = await tree({
    'src/a.mjs': [
      'export function handle(sessionId, runRoot, attemptId) {',
      '  return inner(sessionId, runRoot, attemptId);',
      '}',
      'function inner(sessionId, runRoot, attemptId) {',
      '  return run(sessionId, runRoot, attemptId);',
      '}',
      'function run(sessionId, runRoot, attemptId) {',
      '  return sessionId + runRoot + attemptId;',
      '}',
      'export const outer = (sessionId, runRoot, attemptId) => inner(sessionId, runRoot, attemptId);',
      'export function mount(def) {',
      '  return start(attemptId, runRoot, sessionId);',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['src/a.mjs'], config });
    assert.equal(result.status, 'ok');
    const handle = result.signatures.find(entry => entry.name === 'handle');
    assert.deepEqual(handle.params, ['attemptId', 'runRoot', 'sessionId']);
    assert.equal(handle.role, 'forwarder');
    assert.equal(handle.lineStart, 1);
    assert.equal(result.signatures.find(entry => entry.name === 'run').role, 'definition');
    const forwarders = result.signatures.filter(entry => entry.role === 'forwarder').map(entry => entry.name).sort();
    assert.deepEqual(forwarders, ['handle', 'inner', 'outer']);
    const callSites = result.signatures.filter(entry => entry.role === 'call-site');
    assert.ok(callSites.length >= 1, 'the call inside run() is a call-site');
    assert.ok(callSites.every(entry => entry.params.length === 3));
    assert.deepEqual(result.unparsedFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a destructured parameter, When extracted, Then no signature is invented for that function', async () => {
  const root = await tree({
    'a.mjs': 'export function weird({ a, b }, c) {\n  return a + b + c;\n}\n',
  });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['a.mjs'], config });
    assert.equal(result.signatures.some(entry => entry.name === 'weird'), false);
    assert.equal(result.status, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a file with a syntax error, When extracted, Then it is unparsed with a reason and does not become an empty success', async () => {
  const root = await tree({ 'broken.mjs': 'export function (\n' });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['broken.mjs'], config });
    assert.deepEqual(result.unparsedFiles, [{ path: 'broken.mjs', reason: 'syntax' }]);
    assert.equal(result.languages.find(entry => entry.language === 'javascript').filesFailed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the same tree twice, When extracted twice, Then the signatures are byte-identical', async () => {
  const root = await tree({
    'b.mjs': 'export function a(x, y) { return g(x, y); }\nfunction g(x, y) { return x + y; }\n',
    'a.mjs': 'export function b(p, q, r) { return h(p, q, r); }\nfunction h(p, q, r) { return p; }\n',
  });
  try {
    const paths = ['b.mjs', 'a.mjs'];
    const first = await extractSignatures({ rootDir: root, paths, config });
    const second = await extractSignatures({ rootDir: root, paths: [...paths].reverse(), config });
    assert.deepEqual(first.signatures, second.signatures);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a file over the byte limit, When extracted, Then it is reported too large and never parsed', async () => {
  const root = await tree({ 'big.mjs': `export function f(a, b) { return a + b; }\n${'// padded\n'.repeat(50)}` });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['big.mjs'], config: resolveConfig({ maxFileBytes: 40 }) });
    assert.deepEqual(result.unparsedFiles, [{ path: 'big.mjs', reason: 'too-large' }]);
    assert.equal(result.filesRead, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given an exhausted scan deadline, When extracted, Then the scan is truncated instead of silently complete', async () => {
  const root = await tree({ 'a.mjs': 'export function f(a, b) { return a + b; }\n' });
  try {
    let tick = 0;
    const result = await extractSignatures({
      rootDir: root,
      paths: ['a.mjs'],
      config: resolveConfig({ maxScanMs: 1 }),
      now: () => {
        tick += 1;
        return tick === 1 ? 0 : 100;
      },
    });
    assert.equal(result.truncated, true);
    assert.equal(result.filesSkipped, 1);
    assert.deepEqual(result.signatures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a broken parser import, When extracted, Then every JS file is unparsed and the failure is reported', async () => {
  const root = await tree({ 'a.mjs': 'export function f(a, b) { return a + b; }\n' });
  try {
    const result = await extractSignatures({
      rootDir: root,
      paths: ['a.mjs'],
      config,
      loadParser: async () => {
        throw new Error('parser missing');
      },
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.unparsedFiles, [{ path: 'a.mjs', reason: 'unavailable-parser' }]);
    assert.equal(result.failures[0].reason, 'unavailable-parser');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a missing Python interpreter, When extracted, Then python paths are unparsed with no-interpreter and the status fails', { skip: !pythonPresent && 'python is required for this case' }, async () => {
  const root = await tree({ 'a.py': 'def f(a, b):\n    return a + b\n' });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['a.py'], config, pythonBin: 'definitely-not-a-python-binary' });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.unparsedFiles, [{ path: 'a.py', reason: 'no-interpreter' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a Python file, When extracted through the standard interpreter, Then its definition and forwarder carry exact lines', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  const root = await tree({
    'a.py': ['def handle(session_id, run_root, attempt_id):', '    return inner(session_id, run_root, attempt_id)', '', 'def inner(session_id, run_root, attempt_id):', '    return session_id', ''].join('\n'),
  });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['a.py'], config });
    const handle = result.signatures.find(entry => entry.name === 'handle');
    assert.deepEqual(handle.params, ['attempt_id', 'run_root', 'session_id']);
    assert.equal(handle.role, 'forwarder');
    assert.equal(handle.lineStart, 1);
    assert.equal(result.signatures.find(entry => entry.name === 'inner').role, 'definition');
    assert.equal(result.languages.find(entry => entry.language === 'python').filesParsed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
