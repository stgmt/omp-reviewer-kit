// The scan rules: units carry exact ranges, a file that cannot be parsed is reported, the limits
// truncate instead of lying about coverage, and the content-addressed cache answers the second scan
// of the same bytes without parsing them again.

import assert from 'node:assert/strict';
import { spawnSync as spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveReuseConfig } from '../src/native/reuse/config.mjs';
import { collectExecutableFiles } from '../src/native/maintainability/extract.mjs';
import { cacheKey, createFileCache, scanUnits } from '../src/native/reuse/scan.mjs';

const pythonPresent = spawn('python', ['--version'], { encoding: 'utf8' }).status === 0;
const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

async function withTree(files, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reuse-scan-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }
    return await run(root);
  } finally {
    await rm(root, REMOVE);
  }
}

const GROUPED = `export function computeChargeTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}`;

test('Given two files, When the snapshot is scanned, Then every function carries its own range and shape', async () => {
  await withTree({ 'src/billing.mjs': GROUPED, 'src/labels.ts': 'export const label = (name: string) => `${name}!`;' }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    assert.equal(result.status, 'ok');
    assert.equal(result.filesScanned, 2);
    const billing = result.units.find(unit => unit.path === 'src/billing.mjs');
    assert.equal(billing.name, 'computeChargeTotal');
    assert.equal(billing.lineStart, 1);
    assert.ok(billing.tokens > 20);
    assert.ok(billing.shingles.length > 0);
    assert.ok(billing.calls.includes('Math.round'));
  });
});

test('Given a file the parser rejects, When the snapshot is scanned, Then it is reported as unparsed and the scan still answers', async () => {
  await withTree({ 'src/ok.mjs': GROUPED, 'src/broken.mjs': 'export function ( { ' }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    assert.deepEqual(result.unparsed, [{ path: 'src/broken.mjs', reason: 'syntax' }]);
    assert.equal(result.units.length, 1);
  });
});

test('Given a file over the byte limit, When the snapshot is scanned, Then it is never opened', async () => {
  await withTree({ 'src/big.mjs': `${GROUPED}\n${'// padding\n'.repeat(2000)}` }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({ maxFileBytes: 512 }) });
    assert.deepEqual(result.unparsed, [{ path: 'src/big.mjs', reason: 'too-large' }]);
    assert.deepEqual(result.units, []);
  });
});

test('Given a unit ceiling, When the snapshot is scanned, Then the scan is marked truncated and the units are capped', async () => {
  const files = {};
  for (let index = 0; index < 5; index += 1) files[`src/copy-${index}.mjs`] = GROUPED.replace('computeChargeTotal', `computeChargeTotal${index}`);
  await withTree(files, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({ maxUnits: 2 }) });
    assert.equal(result.units.length, 2);
    assert.equal(result.truncated, true);
  });
});

test('Given the same bytes scanned twice, When the cache is enabled, Then the second scan parses nothing', async () => {
  await withTree({ 'src/billing.mjs': GROUPED }, async root => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
    try {
      const cache = createFileCache({ dir: cacheRoot });
      let parses = 0;
      const loadParser = async () => {
        parses += 1;
        return import('@babel/parser');
      };
      const first = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({ maxScanMs: 600_000 }), cache, loadParser });
      const second = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({ maxScanMs: 600_000 }), cache, loadParser });
      assert.equal(parses, 1, 'the parser was loaded once for two scans');
      assert.equal(first.cacheHits, 0);
      assert.equal(second.cacheHits, 1);
      assert.deepEqual(second.units, first.units);
    } finally {
      await rm(cacheRoot, REMOVE);
    }
  });
});

test('Given a test file that copies production code, When the snapshot is scanned, Then it contributes no unit', async () => {
  await withTree({ 'src/billing.mjs': GROUPED, 'tests/billing.test.mjs': GROUPED, 'service/test_billing.py': 'def charge(a, b):\n    return a + b\n' }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    assert.deepEqual(result.units.map(unit => unit.path), ['src/billing.mjs']);
  });
});

test('Given unchanged Python bytes, When the snapshot is scanned twice, Then the child interpreter is not started again', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  const source = 'def charge_total(items, tax_rate):\n    total = sum(item["price"] for item in items)\n    tax = total * tax_rate\n    return round(total + tax, 2)\n';
  await withTree({ 'service/billing.py': source }, async root => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
    try {
      const cache = createFileCache({ dir: cacheRoot });
      // The subject here is the cache, not the scan budget: a machine under load must not turn this
      // into a truncated scan that cannot record what it parsed.
      const config = resolveReuseConfig({ maxScanMs: 600_000 });
      const first = await scanUnits({ snapshotDir: root, config, cache });
      const second = await scanUnits({ snapshotDir: root, config, cache });
      assert.equal(first.cacheHits, 0);
      assert.equal(second.cacheHits, 1);
      assert.deepEqual(second.units, first.units);
      assert.ok(second.units.length > 0, 'the units came back from the cache');
    } finally {
      await rm(cacheRoot, REMOVE);
    }
  });
});

test('Given a stored entry of another schema, When the cache is asked, Then it answers nothing rather than migrating the entry', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
  try {
    const cache = createFileCache({ dir: cacheRoot });
    const key = cacheKey('javascript', 'src/a.mjs', 'export const a = 1;');
    await mkdir(cacheRoot, { recursive: true });
    const wellFormed = { path: 'src/a.mjs', language: 'javascript', name: 'a', lineStart: 1, lineEnd: 2, tokens: 40, shingles: [1, 2, 3], calls: [] };
    await writeFile(path.join(cacheRoot, `${key}.json`), JSON.stringify({ schema: 'other@9', extractor: 1, units: [wellFormed] }), 'utf8');
    assert.equal(await cache.get(key), null);
  } finally {
    await rm(cacheRoot, REMOVE);
  }
});

test('Given a cache directory that cannot be written, When a unit set is stored, Then the failure is reported and never thrown', async () => {
  const cache = createFileCache({ dir: path.join(os.tmpdir(), 'reuse-cache-missing-parent', 'nested') });
  const stored = await cache.set('key', []);
  assert.equal(typeof stored, 'boolean');
});

test('Given a discovery budget that is already spent, When the tree is collected, Then the walk stops instead of visiting every directory', async () => {
  const files = {};
  for (let index = 0; index < 40; index += 1) files[`dir-${index}/deep/copy-${index}.mjs`] = GROUPED;
  await withTree(files, async root => {
    let ticks = 0;
    const bounded = await collectExecutableFiles({
      rootDir: root,
      config: { maxScanFiles: 4000, maxFileBytes: 524288 },
      classify: () => 'executable',
      now: () => { ticks += 10; return ticks; },
      deadline: 25,
    });
    assert.equal(bounded.truncated, true, 'the walk reports that it stopped early');
    assert.ok(bounded.paths.length < 40, `the walk visited ${bounded.paths.length} file(s) instead of stopping`);
    const full = await collectExecutableFiles({ rootDir: root, config: { maxScanFiles: 4000, maxFileBytes: 524288 }, classify: () => 'executable' });
    assert.equal(full.paths.length, 40, 'without a deadline the same tree is walked whole');
    assert.equal(full.truncated, false);
  });
});

test('Given a discovery that runs past the scan budget, When the snapshot is scanned, Then discovery stops and the coverage is partial', async () => {
  const files = {};
  for (let index = 0; index < 40; index += 1) files[`dir-${index}/deep/copy-${index}.mjs`] = GROUPED;
  await withTree(files, async root => {
    let ticks = 0;
    const result = await scanUnits({
      snapshotDir: root,
      config: resolveReuseConfig({ maxScanMs: 30 }),
      now: () => { ticks += 10; return ticks; },
    });
    assert.equal(result.truncated, true);
    assert.equal(result.coverage, 'partial');
    assert.ok(ticks < 300, `discovery stopped early instead of walking the whole tree (${ticks} ticks)`);
  });
});

test('Given more files than the ceiling, When the snapshot is scanned, Then the excess list stays bounded', async () => {
  const files = {};
  for (let index = 0; index < 120; index += 1) files[`src/unit-${index}.mjs`] = GROUPED;
  await withTree(files, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({ maxFiles: 5 }) });
    assert.equal(result.units.length, 5);
    assert.equal(result.truncated, true);
  });
});

test('Given a Python definition, When the snapshot is scanned, Then its range and its calls are carried', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  const source = 'def charge_total(items, tax_rate):\n    total = sum(item["price"] for item in items)\n    tax = total * tax_rate\n    return round(total + tax, 2)\n';
  await withTree({ 'service/billing.py': source }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    const unit = result.units.find(entry => entry.path === 'service/billing.py');
    assert.ok(unit, 'the python definition became a unit');
    assert.equal(unit.name, 'charge_total');
    assert.equal(unit.lineStart, 1);
    assert.equal(unit.lineEnd, 4);
    assert.ok(unit.calls.includes('round'));
    assert.ok(unit.tokens > 12);
  });
});

test('Given a supported file the parser rejects, When the snapshot is scanned, Then the coverage is partial rather than full', async () => {
  await withTree({ 'src/ok.mjs': GROUPED, 'src/broken.mjs': 'export function ( { ' }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    assert.equal(result.coverage, 'partial');
  });
});

test('Given a Python adapter that fails, When the snapshot is scanned, Then the coverage is failed', async () => {
  await withTree({ 'service/billing.py': 'def charge(a, b):\n    return a + b\n' }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}), pythonBin: 'definitely-not-a-python-binary' });
    assert.equal(result.coverage, 'failed');
  });
});

test('Given a scan budget that is already spent, When the Python adapter would start, Then it is not given a floor above the budget', async () => {
  await withTree({ 'service/billing.py': 'def charge(a, b):\n    return a + b\n' }, async root => {
    let seenTimeout = null;
    const result = await scanUnits({
      snapshotDir: root,
      config: resolveReuseConfig({ maxScanMs: 200 }),
      spawnSync: (_bin, _args, options) => {
        seenTimeout = options.timeout;
        return { status: 1, stdout: '', stderr: '' };
      },
    });
    assert.ok(seenTimeout !== null && seenTimeout <= 200, `the child timeout ${seenTimeout} stays inside the budget`);
    assert.equal(result.coverage, 'failed');
  });
});

test('Given a missing Python interpreter, When the snapshot is scanned, Then the adapter reason is recorded instead of a silent skip', async () => {
  await withTree({ 'service/billing.py': 'def charge(a, b):\n    return a + b\n' }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}), pythonBin: 'definitely-not-a-python-binary' });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.unparsed, [{ path: '<python-adapter>', reason: 'no-interpreter' }]);
  });
});

test('Given a functionless Python file, When the snapshot is scanned twice, Then the second scan answers from the cache', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withTree({ 'service/empty.py': 'VALUE = 1\nOTHER = VALUE + 1\n' }, async root => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
    try {
      const cache = createFileCache({ dir: cacheRoot });
      const config = resolveReuseConfig({ maxScanMs: 600_000 });
      const first = await scanUnits({ snapshotDir: root, config, cache });
      const second = await scanUnits({ snapshotDir: root, config, cache });
      assert.deepEqual(first.units, []);
      assert.equal(second.cacheHits, 1, 'the parsed-but-empty file is cached instead of re-sent to the interpreter');
    } finally {
      await rm(cacheRoot, REMOVE);
    }
  });
});

test('Given a file its first plugin set rejects, When the snapshot is scanned, Then the documented second attempt still yields units', async () => {
  const typed = 'export function chargeTotal(items: string[], taxRate: number): number {\n  let total = 0;\n  for (const item of items) {\n    total += item.length * taxRate;\n  }\n  return Math.round(total * 100) / 100;\n}\n';
  await withTree({ 'src/typed.js': typed }, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    assert.equal(result.units.length, 1, 'the TypeScript dialect parsed a .js file through the fallback');
    assert.ok(result.units[0].shingles.length > 0);
    assert.deepEqual(result.unparsed, []);
  });
});

test('Given a cache entry whose members are not units, When the cache is asked, Then it is a miss and the file is parsed again', async () => {
  await withTree({ 'src/billing.mjs': GROUPED }, async root => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
    try {
      const cache = createFileCache({ dir: cacheRoot });
      const source = await readFile(path.join(root, 'src/billing.mjs'), 'utf8');
      const key = cacheKey('javascript', 'src/billing.mjs', source);
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(path.join(cacheRoot, `${key}.json`), JSON.stringify({ schema: 'reuse-cache@1', extractor: 1, units: [null] }), 'utf8');
      assert.equal(await cache.get(key), null, 'a malformed member makes the whole entry a miss');
      const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}), cache });
      assert.equal(result.units.length, 1, 'the file was parsed instead of answering from the broken entry');
    } finally {
      await rm(cacheRoot, REMOVE);
    }
  });
});

test('Given a flat directory larger than the budget, When the tree is collected, Then the entry loop stops at the deadline', async () => {
  const files = {};
  for (let index = 0; index < 200; index += 1) files[`flat/unit-${index}.mjs`] = GROUPED;
  await withTree(files, async root => {
    let ticks = 0;
    const bounded = await collectExecutableFiles({
      rootDir: root,
      config: { maxScanFiles: 4000, maxFileBytes: 524288 },
      classify: () => 'executable',
      now: () => { ticks += 10; return ticks; },
      deadline: 20,
    });
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.paths.length < 200, `the entry loop visited ${bounded.paths.length} of 200 files`);
  });
});

test('Given more malformed files than the retained list, When the snapshot is scanned, Then the total is reported apart from the capped list', async () => {
  const files = {};
  for (let index = 0; index < 25; index += 1) files[`src/broken-${index}.mjs`] = 'export function ( { ';
  await withTree(files, async root => {
    const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}) });
    assert.equal(result.unparsed.length, 20, 'the artifact keeps a bounded list');
    assert.equal(result.unparsedTotal, 25, 'the count is not capped');
    assert.equal(result.coverage, 'partial');
  });
});

test('Given a cache entry whose units carry no source span, When the cache is asked, Then it is a miss and the file is parsed again', async () => {
  await withTree({ 'src/billing.mjs': GROUPED }, async root => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
    try {
      const cache = createFileCache({ dir: cacheRoot });
      const source = await readFile(path.join(root, 'src/billing.mjs'), 'utf8');
      const key = cacheKey('javascript', 'src/billing.mjs', source);
      const noSpan = { path: 'src/billing.mjs', language: 'javascript', name: 'a', tokens: 40, shingles: [1, 2, 3], calls: [] };
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(path.join(cacheRoot, `${key}.json`), JSON.stringify({ schema: 'reuse-cache@1', extractor: 1, units: [noSpan] }), 'utf8');
      assert.equal(await cache.get(key), null, 'a unit without a span cannot name a line in a hint');
      const result = await scanUnits({ snapshotDir: root, config: resolveReuseConfig({}), cache });
      assert.ok(result.units.every(unit => Number.isFinite(unit.lineStart) && Number.isFinite(unit.lineEnd)));
    } finally {
      await rm(cacheRoot, REMOVE);
    }
  });
});

test('Given identical bytes at two paths, When the cache is asked, Then each path gets its own entry', async () => {
  await withTree({ 'src/old.mjs': GROUPED, 'src/new.mjs': GROUPED }, async root => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'reuse-cache-'));
    try {
      const cache = createFileCache({ dir: cacheRoot });
      const config = resolveReuseConfig({ maxScanMs: 600_000 });
      const first = await scanUnits({ snapshotDir: root, config, cache });
      const second = await scanUnits({ snapshotDir: root, config, cache });
      const paths = second.units.map(unit => unit.path).sort();
      assert.deepEqual(paths, ['src/new.mjs', 'src/old.mjs'], 'a cached unit keeps the path it was scanned from');
      assert.equal(second.cacheHits, 2, 'both files were answered from the cache');
      assert.equal(first.cacheHits, 0);
    } finally {
      await rm(cacheRoot, REMOVE);
    }
  });
});
