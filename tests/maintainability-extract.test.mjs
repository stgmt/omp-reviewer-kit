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

test('Given an object-pattern parameter, When extracted, Then its property keys are the named values', async () => {
  const root = await tree({
    'a.mjs': 'export function weird({ a, b }, c) {\n  return a + b + c;\n}\n',
  });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['a.mjs'], config });
    const weird = result.signatures.find(entry => entry.name === 'weird');
    assert.ok(weird, 'a destructured parameter still names the signature');
    assert.deepEqual(weird.params, ['a', 'b', 'c']);
    assert.equal(weird.role, 'definition');
    assert.equal(result.status, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a call site passing an object literal with a member expression beside it, When extracted, Then the written keys and identifiers are counted', async () => {
  const root = await tree({
    'a.mjs': 'export function run(request) {\n  return charge({ userId: request.userId, tenantId: request.tenantId }, request.amount);\n}\n',
  });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['a.mjs'], config });
    const sites = result.signatures.filter(entry => entry.role === 'call-site');
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].params, ['tenantId', 'userId']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a call site spreading its argument, When extracted, Then no signature is invented for it', async () => {
  const root = await tree({
    'a.mjs': 'export function run(request) {\n  return charge(...request.context);\n}\n',
  });
  try {
    const result = await extractSignatures({ rootDir: root, paths: ['a.mjs'], config });
    assert.equal(result.signatures.some(entry => entry.role === 'call-site'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the Python adapter exceeds the scan budget, When extracted, Then the scan is partial instead of failed', async () => {
  const root = await tree({ 'a.py': 'def f(a, b):\n    return a + b\n' });
  try {
    const result = await extractSignatures({
      rootDir: root,
      paths: ['a.py'],
      config,
      spawnSync: () => ({ error: Object.assign(new Error('spawnSync python ETIMEDOUT'), { code: 'ETIMEDOUT' }) }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.truncated, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.unparsedFiles, [{ path: '<python-adapter>', reason: 'analysis-budget-exhausted' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the Python adapter is killed without a timeout, When extracted, Then the analysis fails instead of claiming a budget exhaustion', async () => {
  const root = await tree({ 'a.py': 'def f(a, b):\n    return a + b\n' });
  try {
    const result = await extractSignatures({
      rootDir: root,
      paths: ['a.py'],
      config,
      spawnSync: () => ({ signal: 'SIGTERM', status: null }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.truncated, false);
    assert.deepEqual(result.failures, [{ path: null, reason: 'failed', message: 'python adapter stopped by SIGTERM' }]);
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

async function extractOne(name, source, paths = [name]) {
  const root = await tree({ [name]: source });
  try {
    return await extractSignatures({ rootDir: root, paths, config });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Given a defaulted object pattern and a rest parameter, When extracted, Then the wrapper is unwrapped instead of hiding the signature', async () => {
  const defaulted = await extractOne('a.mjs', 'export function f({ userId, tenantId } = {}) {\n  return userId + tenantId;\n}\n');
  const f = defaulted.signatures.find(entry => entry.name === 'f');
  assert.ok(f, 'a defaulted object pattern still names the signature');
  assert.deepEqual(f.params, ['tenantId', 'userId']);

  const rest = await extractOne('b.mjs', 'export function g(userId, tenantId, ...extra) {\n  return userId + tenantId + extra.length;\n}\n');
  const g = rest.signatures.find(entry => entry.name === 'g');
  assert.ok(g, 'a rest parameter still names the signature');
  assert.deepEqual(g.params, ['extra', 'tenantId', 'userId']);
});

test('Given a TypeScript parameter property, When extracted, Then its name is part of the signature', async () => {
  const result = await extractOne('a.ts', 'export class A {\n  constructor(public userId: string, public tenantId: string) {}\n}\n');
  const constructor = result.signatures.find(entry => entry.role === 'definition');
  assert.ok(constructor, 'a parameter property still names the signature');
  assert.deepEqual(constructor.params, ['tenantId', 'userId']);
});

test('Given a string-literal object-pattern key, When extracted, Then the written key is the name', async () => {
  const result = await extractOne('a.mjs', "export function f({ 'user-id': value, tenantId }) {\n  return value + tenantId;\n}\n");
  const f = result.signatures.find(entry => entry.name === 'f');
  assert.ok(f, 'a string-literal key still names the signature');
  assert.deepEqual(f.params, ['tenantId', 'user-id']);
});

test('Given an object pattern with a rest property, When extracted, Then the ordinary keys remain', async () => {
  const result = await extractOne('a.mjs', 'export function f({ userId, tenantId, ...extra }) {\n  return userId + tenantId + Object.keys(extra).length;\n}\n');
  const f = result.signatures.find(entry => entry.name === 'f');
  assert.ok(f, 'an object-rest property does not invalidate the signature');
  assert.deepEqual(f.params, ['tenantId', 'userId']);
});

test('Given a computed or numeric object-pattern key, When extracted, Then no signature is invented', async () => {
  const computed = await extractOne('a.mjs', 'export function f({ [field]: value, tenantId }) {\n  return value + tenantId;\n}\n');
  assert.equal(computed.signatures.some(entry => entry.name === 'f'), false);
  const numeric = await extractOne('b.mjs', 'export function g({ 1: value, tenantId }) {\n  return value + tenantId;\n}\n');
  assert.equal(numeric.signatures.some(entry => entry.name === 'g'), false);
});

test('Given a computed or method object-literal property, When extracted, Then no call-site signature is invented', async () => {
  const computed = await extractOne('a.mjs', 'export function run(field, value, tenantId, userId) {\n  return send({ [field]: value, tenantId: value }, userId);\n}\n');
  assert.equal(computed.signatures.some(entry => entry.role === 'call-site'), false);
  const method = await extractOne('b.mjs', 'export function run(value, tenantId, requestId) {\n  return send({ userId() {}, tenantId: value }, requestId);\n}\n');
  assert.equal(method.signatures.some(entry => entry.role === 'call-site'), false);
});

test('Given a call site repeating the same name, When extracted, Then the name appears once', async () => {
  const result = await extractOne('a.mjs', 'export function run(userId) {\n  return charge(userId, userId);\n}\n');
  const sites = result.signatures.filter(entry => entry.role === 'call-site');
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].params, ['userId']);
});
