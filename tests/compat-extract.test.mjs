// Given/When/Then over the version census extractor: what is produced, consumed and listed, and
// what the scan honestly reports as unread. Pure: no OMP, no model, no Git.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectJavaScript, extractCompat, familyOf, isVersionLiteral } from '../src/native/compat/extract.mjs';
import { resolveCompatConfig } from '../src/native/compat/config.mjs';
import { parseJavaScript, JS_EXTENSIONS } from '../src/native/scan/js-parse.mjs';

const pythonPresent = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;

async function withTree(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'compat-extract-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

async function collect(source, relative = 'src/a.js') {
  const parser = await import('@babel/parser');
  const ast = parseJavaScript({ relative, source, plugins: JS_EXTENSIONS.get('.js'), parser });
  assert.ok(ast, 'the fixture must parse');
  return collectJavaScript(relative, ast);
}

test('Given a module that writes, reads and lists versions, When collected, Then every site keeps its line', async () => {
  const source = [
    "const SCHEMA_V5 = 'product-manifest/v5';",
    "const SCHEMA_V8 = 'product-manifest/v8';",
    'const SCHEMA_BY_KIND = { reels: SCHEMA_V5, splice: SCHEMA_V8 };',
    "const SUPPORTED_VERSIONS = ['product-manifest/v5', SCHEMA_V8];",
    'export function build(kind) {',
    "  return { schema: kind === 'splice' ? SCHEMA_V8 : SCHEMA_V5 };",
    '}',
    'export function repair(manifest) {',
    '  if (manifest.schema === SCHEMA_V8) return manifest.timeline["strategy"];',
    '  return null;',
    '}',
  ].join('\n');
  const record = await collect(source);
  const produced = record.produced.map(site => `${site.version}@${site.line}`).sort();
  assert.deepEqual(produced, ['product-manifest/v5@6', 'product-manifest/v8@6']);
  const listed = record.listed.map(site => `${site.version}@${site.table}`).sort();
  assert.deepEqual(listed, [
    'product-manifest/v5@SCHEMA_BY_KIND',
    'product-manifest/v5@SUPPORTED_VERSIONS',
    'product-manifest/v8@SCHEMA_BY_KIND',
    'product-manifest/v8@SUPPORTED_VERSIONS',
  ]);
  const consumed = record.consumed.map(site => `${site.version}@${site.line}`).sort();
  assert.deepEqual(consumed, ['product-manifest/v8@9']);
  assert.equal(record.consumed[0].constant, 'SCHEMA_V8');
});

test('Given a supported list tested with includes, When collected, Then every accepted version is consumed', async () => {
  const source = [
    "const ACCEPTED = ['legacy-format/v1', 'legacy-format/v2'];",
    'export function repair(manifest) {',
    '  return ACCEPTED.includes(manifest.schema);',
    '}',
    'export function inline(manifest) {',
    "  return ['legacy-format/v3'].includes(manifest.schema);",
    '}',
  ].join('\n');
  const record = await collect(source);
  assert.deepEqual(record.consumed.map(site => site.version).sort(), ['legacy-format/v3'], 'the inline list is consumed at the call site');
  assert.ok(record.consumed.every(site => site.guard === 'membership:includes'));
  assert.deepEqual(record.lists, [{ name: 'ACCEPTED', versions: ['legacy-format/v1', 'legacy-format/v2'] }]);
  assert.deepEqual(record.pending, [{ kind: 'consumed', name: 'ACCEPTED', line: 3, guard: 'membership:includes', list: true }]);
});

test('Given a switch on the version field, When collected, Then every case literal is consumed', async () => {
  const source = "export function pick(manifest) { switch (manifest.schema) { case 'product-manifest/v5': return 1; case 'product-manifest/v8': return 2; default: return 0; } }\n";
  const record = await collect(source);
  assert.deepEqual(record.consumed.map(site => site.version).sort(), ['product-manifest/v5', 'product-manifest/v8']);
  assert.ok(record.consumed.every(site => site.guard === 'switch'));
});

test('Given an oversized Python file, When extracted, Then it is unparsed once and never parsed', async () => {
  await withTree({ 'big.py': 'SCHEMA = "product-manifest/v5"\n' }, async root => {
    const result = await extractCompat({ rootDir: root, paths: ['big.py'], config: resolveCompatConfig({ maxFileBytes: 8 }) });
    assert.deepEqual(result.unparsed, [{ path: 'big.py', reason: 'oversized' }]);
    assert.equal(result.files.length, 0);
  });
});

test('Given a version imported from another changed module, When the analysis runs, Then the name resolves to that version', async () => {
  const { buildAnalysis } = await import('../src/native/compat/analyze.mjs');
  const analysis = buildAnalysis({
    diffHash: 'a'.repeat(64),
    policy: 'advisory',
    config: resolveCompatConfig(),
    changed: 2,
    extracted: {
      files: [
        { path: 'src/manifest.py', language: 'python', produced: [], consumed: [], listed: [], reads: [], pending: [], constants: [{ name: 'SCHEMA_V8', version: 'product-manifest/v8' }] },
        { path: 'src/repair.py', language: 'python', produced: [], consumed: [], listed: [], reads: [], pending: [{ kind: 'consumed', name: 'SCHEMA_V8', line: 9, guard: 'schema == SCHEMA_V8' }], constants: [] },
      ],
      unparsed: [],
      failures: [],
      elsewhere: [],
      elsewhereTruncated: false,
      scanned: 2,
      truncated: false,
      elapsedMs: 1,
    },
  });
  assert.deepEqual(analysis.deadVersions.map(entry => entry.version), ['product-manifest/v8']);
  assert.deepEqual(analysis.deadBranches, [{ file: 'src/repair.py', line: 9, version: 'product-manifest/v8', guard: 'schema == SCHEMA_V8', constant: 'SCHEMA_V8' }]);
});

test('Given a Python producer, reader and table, When extracted through the interpreter, Then the sites carry exact lines', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  const source = [
    'SCHEMA_V5 = "product-manifest/v5"',
    'SCHEMA_V8 = "product-manifest/v8"',
    'SCHEMA_BY_KIND = {"splice": SCHEMA_V5}',
    'SUPPORTED_VERSIONS = ["product-manifest/v5", SCHEMA_V8]',
    'def build(kind):',
    '    return {"schema": SCHEMA_V8 if kind == "splice" else SCHEMA_V5, "timeline": {}}',
    'def repair(manifest):',
    '    if manifest["schema"] == SCHEMA_V8:',
    '        return manifest["timeline"]["strategy"]',
  ].join('\n');
  await withTree({ 'reel/manifest.py': source }, async root => {
    const result = await extractCompat({ rootDir: root, paths: ['reel/manifest.py'], config: resolveCompatConfig() });
    const record = result.files[0];
    assert.equal(record.language, 'python');
    assert.deepEqual(record.produced.map(site => site.version).sort(), ['product-manifest/v5', 'product-manifest/v8']);
    assert.deepEqual(record.consumed.map(site => site.version), ['product-manifest/v8']);
    assert.equal(record.consumed[0].line, 8);
    assert.ok(record.listed.some(site => site.version === 'product-manifest/v5' && site.table === 'SCHEMA_BY_KIND'));
    assert.ok(record.listed.some(site => site.version === 'product-manifest/v8' && site.table === 'SUPPORTED_VERSIONS'));
  });
});

test('Given a Python file that does not parse, When extracted, Then it is unparsed with a syntax reason and the scan continues', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withTree({ 'a.py': 'def broken(:\n  pass\n', 'b.py': 'SCHEMA_V5 = "product-manifest/v5"\n' }, async root => {
    const result = await extractCompat({ rootDir: root, paths: ['a.py', 'b.py'], config: resolveCompatConfig() });
    assert.deepEqual(result.unparsed, [{ path: 'a.py', reason: 'syntax' }]);
    assert.equal(result.files.length, 1);
  });
});

test('Given no Python interpreter, When extracted, Then every Python path is unparsed with no-interpreter', async () => {
  await withTree({ 'a.py': 'SCHEMA_V5 = "product-manifest/v5"\n' }, async root => {
    const result = await extractCompat({
      rootDir: root,
      paths: ['a.py'],
      config: resolveCompatConfig(),
      spawnSync: () => ({ error: Object.assign(new Error('spawnSync python ENOENT'), { code: 'ENOENT' }) }),
    });
    assert.deepEqual(result.unparsed, [{ path: 'a.py', reason: 'no-interpreter' }]);
    assert.equal(result.files.length, 0);
  });
});

test('Given a file above the size cap, When extracted, Then it is unparsed as oversized', async () => {
  await withTree({ 'a.js': `const X = '${'x'.repeat(200)}';\n` }, async root => {
    const result = await extractCompat({ rootDir: root, paths: ['a.js'], config: resolveCompatConfig({ maxFileBytes: 64 }) });
    assert.deepEqual(result.unparsed, [{ path: 'a.js', reason: 'oversized' }]);
  });
});

test('Given a parser that cannot load, When extracted, Then the failure is reported and the file is unparsed', async () => {
  await withTree({ 'a.js': 'export const x = 1;\n' }, async root => {
    const result = await extractCompat({
      rootDir: root,
      paths: ['a.js'],
      config: resolveCompatConfig(),
      loadParser: async () => { throw new Error('parser missing'); },
    });
    assert.deepEqual(result.failures.map(failure => failure.reason), ['parser-unavailable']);
    assert.deepEqual(result.unparsed, [{ path: 'a.js', reason: 'parser-unavailable' }]);
  });
});

test('Given an unchanged module that still writes a version, When the snapshot is scanned, Then the literal is named outside the change', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withTree({
    'src/repair.py': 'def repair(manifest):\n    return manifest["schema"] == "product-manifest/v8"\n',
    'src/legacy.py': 'SCHEMA = "product-manifest/v8"\n',
  }, async root => {
    const result = await extractCompat({ rootDir: root, paths: ['src/repair.py'], config: resolveCompatConfig(), pythonBin: 'python' });
    assert.deepEqual(result.elsewhere, [{ version: 'product-manifest/v8', path: 'src/legacy.py', line: 1 }]);
  });
});

test('Given an unchanged module that writes a version in a template literal, When the snapshot is scanned, Then the literal is still found', async () => {
  await withTree({
    'src/repair.js': "export function repair(manifest) { return manifest.schema === 'product-manifest/v8'; }\n",
    'src/legacy.js': 'export const SCHEMA = `product-manifest/v8`;\n',
  }, async root => {
    const result = await extractCompat({ rootDir: root, paths: ['src/repair.js'], config: resolveCompatConfig() });
    assert.deepEqual(result.elsewhere, [{ version: 'product-manifest/v8', path: 'src/legacy.js', line: 1 }]);
  });
});

test('Given a version literal and a family, Then the helpers agree on what they accept', () => {
  assert.equal(isVersionLiteral('product-manifest/v8'), true);
  assert.equal(isVersionLiteral('product-manifest'), false);
  assert.equal(isVersionLiteral('product-manifest/8'), false);
  assert.equal(familyOf('rendered-video-critic-evidence/v7'), 'rendered-video-critic-evidence');
});
