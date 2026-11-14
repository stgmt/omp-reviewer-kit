// Given/When/Then over the version census artifact: what counts as dead, what is only unproduced by
// the change, and how the caps report themselves. Pure: no OMP, no model, no Git.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAnalysis, compareVersion, runCompatAnalysis } from '../src/native/compat/analyze.mjs';

const pythonPresent = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;
import { resolveCompatConfig } from '../src/native/compat/config.mjs';

async function withTree(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'compat-analysis-'));
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

const context = (dir, changedPaths) => ({ snapshot: { dir, changedPaths, diffHash: 'a'.repeat(64) } });

function extracted(overrides = {}) {
  return {
    files: [],
    unparsed: [],
    failures: [],
    elsewhere: [],
    elsewhereTruncated: false,
    scanned: 0,
    truncated: false,
    elapsedMs: 1,
    ...overrides,
  };
}

test('Given the census policy is off, When the analysis runs, Then nothing is scanned and the reason is policy-off', async () => {
  const result = await runCompatAnalysis({ context: context('/nonexistent', ['src/a.js']), env: { OMP_REVIEW_KIT_COMPAT: 'off' } });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'policy-off');
});

test('Given a diff without executable code, When the analysis runs, Then it is skipped as no-code-change', async () => {
  const result = await runCompatAnalysis({ context: context('/nonexistent', ['README.md']), env: {} });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-code-change');
});

test('Given a reader of a version no changed module produces, When the analysis runs, Then the version is dead and its branch is named', async () => {
  await withTree({
    'src/manifest.js': "export function build(kind) { return { schema: 'product-manifest/v5' }; }\n",
    'src/repair.js': "export function repair(manifest) { return manifest.schema === 'product-manifest/v8' ? 1 : 0; }\n",
  }, async root => {
    const result = await runCompatAnalysis({ context: context(root, ['src/manifest.js', 'src/repair.js']), env: {} });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.analysis.deadVersions.map(entry => entry.version), ['product-manifest/v8']);
    assert.deepEqual(result.analysis.deadBranches.map(branch => `${branch.file}:${branch.line}`), ['src/repair.js:1']);
    assert.equal(result.analysis.coverage, 'full');
    const artifact = JSON.parse(await readFile(path.join(root, '.review', 'compat.json'), 'utf8'));
    assert.equal(artifact.schema, 'compat@1');
    assert.deepEqual(artifact.deadVersions.map(entry => entry.version), ['product-manifest/v8']);
  });
});

test('Given the literal still exists in an unchanged module, When the analysis runs, Then the version is unproduced by this change, not dead', async () => {
  await withTree({
    'src/repair.js': "export function repair(manifest) { return manifest.schema === 'product-manifest/v8'; }\n",
    'src/legacy.js': "export const LEGACY = 'product-manifest/v8';\n",
  }, async root => {
    const result = await runCompatAnalysis({ context: context(root, ['src/repair.js']), env: {} });
    assert.deepEqual(result.analysis.deadVersions, []);
    assert.deepEqual(result.analysis.unproducedVersions.map(entry => entry.version), ['product-manifest/v8']);
    assert.deepEqual(result.analysis.unproducedVersions[0].elsewhere, [{ version: 'product-manifest/v8', path: 'src/legacy.js', line: 1 }]);
  });
});

test('Given more snapshot files than the walk ceiling, When the analysis runs, Then the elsewhere pass reports truncation instead of walking the tree', async () => {
  await withTree({
    'src/repair.js': "export function repair(manifest) { return manifest.schema === 'product-manifest/v8'; }\n",
    'src/a.js': "export const A = 'other-format/v1';\n",
    'src/b.js': "export const B = 'other-format/v1';\n",
  }, async root => {
    const result = await runCompatAnalysis({
      context: context(root, ['src/repair.js']),
      env: {},
      config: resolveCompatConfig({ maxScanFiles: 1 }),
    });
    assert.equal(result.analysis.scan.truncated, true);
    assert.equal(result.analysis.coverage, 'partial');
    assert.deepEqual(result.analysis.deadVersions, [], 'a cut walk never certifies a version as dead');
    assert.ok(result.analysis.unproducedVersions.some(entry => entry.reason === 'snapshot-scan-truncated'));
  });
});

test('Given a supported list tested with includes, When the analysis runs, Then every member of the list is consumed', async () => {
  await withTree({
    'check.js': "const ACCEPTED = ['product-manifest/v5', 'product-manifest/v8'];\nexport function check(manifest) { return ACCEPTED.includes(manifest.schema); }\n",
  }, async root => {
    const result = await runCompatAnalysis({ context: context(root, ['check.js']), env: {} });
    const family = result.analysis.families.find(entry => entry.family === 'product-manifest');
    assert.ok(family, 'the consumed versions must form a family');
    const consumed = family.versions.flatMap(version => version.consumed.map(() => version.version));
    assert.deepEqual(consumed.sort(), ['product-manifest/v5', 'product-manifest/v8']);
  });
});

test('Given the extractor throws, When the analysis runs, Then it returns and stores a failed envelope', async () => {
  await withTree({ 'src/a.js': 'export const x = 1;\n' }, async root => {
    const result = await runCompatAnalysis({
      context: context(root, ['src/a.js']),
      env: {},
      now: () => { throw new Error('clock failed'); },
    });
    assert.equal(result.reason, 'analysis-failed');
    assert.equal(result.analysis.status, 'failed');
    assert.equal(result.analysis.coverage, 'failed');
    const artifact = JSON.parse(await readFile(path.join(root, '.review', 'compat.json'), 'utf8'));
    assert.equal(artifact.status, 'failed');
    assert.match(artifact.failures[0].message, /clock failed/);
  });
});

test('Given more sites than the cap where a producer sorts after its consumer, When the analysis runs, Then no version is certified dead', async () => {
  await withTree({
    'a.js': "export function use(m) { return m.schema === 'p/v8' || m.schema === 'p/v9' || m.schema === 'p/v10'; }\n",
    'b.js': "export function build() { return { schema: 'p/v9' }; }\n",
  }, async root => {
    const result = await runCompatAnalysis({
      context: context(root, ['a.js', 'b.js']),
      env: {},
      config: resolveCompatConfig({ maxSites: 3 }),
    });
    assert.equal(result.analysis.scan.truncated, true);
    assert.deepEqual(result.analysis.deadVersions, [], 'a dropped producer is not a dead version');
    assert.ok(result.analysis.unproducedVersions.some(entry => entry.reason === 'site-scan-truncated'));
  });
});

test('Given a Python membership test against a named list, When the analysis runs, Then every member is consumed', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withTree({
    'check.py': 'SUPPORTED = ["product-manifest/v5", "product-manifest/v8"]\n\ndef check(manifest):\n    return manifest["schema"] in SUPPORTED\n',
  }, async root => {
    const result = await runCompatAnalysis({ context: context(root, ['check.py']), env: {} });
    const family = result.analysis.families.find(entry => entry.family === 'product-manifest');
    const consumed = family.versions.flatMap(version => version.consumed.map(() => version.version));
    assert.deepEqual(consumed.sort(), ['product-manifest/v5', 'product-manifest/v8']);
  });
});

test('Given more sites than the cap, When the analysis runs, Then the scan reports truncation and partial coverage', () => {
  const files = [{
    path: 'src/a.js',
    language: 'javascript',
    produced: [],
    consumed: Array.from({ length: 5 }, (_, index) => ({ version: 'a/v8', line: index + 1, guard: 'compare', constant: null })),
    listed: [],
    pending: [],
    constants: [],
  }];
  const analysis = buildAnalysis({ diffHash: 'a'.repeat(64), policy: 'advisory', config: resolveCompatConfig({ maxSites: 3 }), changed: 1, extracted: extracted({ files }) });
  assert.equal(analysis.scan.sites, 3);
  assert.equal(analysis.scan.truncated, true);
  assert.equal(analysis.coverage, 'partial');
});

test('Given more families than the cap, When the analysis runs, Then the dropped families are counted, never hidden', () => {
  const files = ['a', 'b', 'c'].map(name => ({
    path: `src/${name}.js`,
    language: 'javascript',
    produced: [{ version: `${name}-format/v1`, line: 1, field: 'schema' }],
    consumed: [],
    listed: [],
    pending: [],
    constants: [],
  }));
  const analysis = buildAnalysis({ diffHash: 'a'.repeat(64), policy: 'advisory', config: resolveCompatConfig({ maxFamilies: 2 }), changed: 3, extracted: extracted({ files }) });
  assert.equal(analysis.families.length, 2);
  assert.equal(analysis.scan.droppedFamilies, 1);
  assert.equal(analysis.coverage, 'partial');
});

test('Given an unparsed file, When the analysis runs, Then coverage is partial and the file is named', () => {
  const analysis = buildAnalysis({
    diffHash: 'a'.repeat(64),
    policy: 'advisory',
    config: resolveCompatConfig(),
    changed: 2,
    extracted: extracted({ unparsed: [{ path: 'src/a.py', reason: 'syntax' }], scanned: 2 }),
  });
  assert.equal(analysis.coverage, 'partial');
  assert.equal(analysis.scan.unparsedTotal, 1);
  assert.equal(analysis.status, 'ok');
});

test('Given versions v2 and v10, Then the census orders them numerically', () => {
  assert.deepEqual(['a/v10', 'a/v2', 'a/v1'].sort(compareVersion), ['a/v1', 'a/v2', 'a/v10']);
});
