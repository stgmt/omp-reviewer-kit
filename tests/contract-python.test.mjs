// Given/When/Then over the Python half of the producer/consumer reconciliation: the stage calls the
// writer, hands the record to the reader, and reports what happened. A real snapshot and a real
// interpreter; no model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runContractAnalysis } from '../src/native/contract/analyze.mjs';

const pythonPresent = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;

async function withSnapshot(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'contract-python-'));
  try {
    await mkdir(path.join(root, '.review'), { recursive: true });
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

const MISMATCH = [
  'def write_user(name, version=1):',
  '    return {"name": name, "version": version}',
  '',
  'def read_user(record):',
  '    if "display_name" not in record:',
  '        raise ValueError("display_name is required")',
  '    return record',
  '',
].join('\n');

const MATCH = [
  'def write_row(name):',
  '    return {"display_name": name}',
  '',
  'def read_row(record):',
  '    return record["display_name"]',
  '',
].join('\n');

test('Given a Python writer whose own reader rejects the record, When the stage runs, Then the contract is violated with the error', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({ 'users.py': MISMATCH }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['users.py'] });
    assert.equal(result.status, 'contract-violated');
    const pair = result.pairs.find(entry => entry.writer === 'write_user');
    assert.equal(pair.reader, 'read_user');
    assert.equal(pair.outcome, 'reader-rejects-written-record');
    assert.match(pair.error, /ValueError: display_name is required/);
    assert.equal(pair.arguments.length, 1, 'the defaulted slot is left to the writer');
  });
});

test('Given a Python pair that agrees on the record, When the stage runs, Then it round-trips and reports no error', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({ 'rows.py': MATCH }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['rows.py'] });
    assert.equal(result.status, 'ok');
    const pair = result.pairs.find(entry => entry.writer === 'write_row');
    assert.equal(pair.outcome, 'round-trip-ok');
    assert.equal(pair.error, null);
  });
});

test('Given a Python writer with variadic parameters, When the stage runs, Then the pair is unproven, never probed', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({
    'varargs.py': 'def write_item(*args):\n    return list(args)\n\ndef read_item(record):\n    return record\n',
  }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['varargs.py'] });
    assert.equal(result.status, 'partial');
    assert.ok(result.unproven.some(item => /parameter shape/.test(item)));
    assert.deepEqual(result.pairs, []);
  });
});

test('Given a Python file that does not parse, When the stage runs, Then it is unparsed and the scan continues', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({ 'broken.py': 'def broken(:\n  pass\n' }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['broken.py'] });
    assert.ok(result.unparsedFiles.some(item => /broken\.py: syntax/.test(item)));
  });
});

test('Given a reader in another module that imports the writer, When the stage runs, Then the pair is made and settled', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({
    'reel/manifest.py': 'def write_manifest(name):\n    return {"name": name}\n',
    'reel/repair.py': [
      'from reel.manifest import write_manifest',
      '',
      'def read_manifest(record):',
      '    if "timeline" not in record:',
      '        raise KeyError("timeline")',
      '    return record',
      '',
    ].join('\n'),
  }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['reel/manifest.py', 'reel/repair.py'] });
    assert.equal(result.status, 'contract-violated');
    const pair = result.pairs.find(entry => entry.writer === 'write_manifest');
    assert.equal(pair.reader, 'read_manifest');
    assert.equal(pair.crossModule, true);
    assert.match(pair.error, /KeyError: 'timeline'/);
  });
});

test('Given a bare import that resolves to a different module than the paired writer, When the stage runs, Then no pair is settled', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({
    'manifest.py': 'def write_manifest(name):\n    return {"legacy": name}\n',
    'reel/manifest.py': 'def write_manifest(name):\n    return {"name": name}\n',
    'reel/repair.py': 'from manifest import write_manifest\n\ndef read_manifest(record):\n    return record["legacy"]\n',
  }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['reel/manifest.py', 'reel/repair.py'] });
    const pair = result.pairs.find(entry => entry.writer === 'write_manifest' && entry.crossModule === true);
    assert.ok(pair, 'the static edge is a candidate');
    assert.equal(pair.outcome, 'module-mismatch');
    assert.equal(result.status, 'partial');
    assert.ok(result.unproven.some(item => item.startsWith('reel/manifest.py write_manifest: no reader')));
  });
});

test('Given two modules exporting the same writer name, When only one is settled across modules, Then the other keeps its unsettled note', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({
    'a/manifest.py': 'def write_manifest(name):\n    return {"name": name}\n',
    'b/manifest.py': 'def write_manifest(name):\n    return {"name": name}\n',
    'b/repair.py': 'from a.manifest import write_manifest\n\ndef read_manifest(record):\n    return record["name"]\n',
  }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['a/manifest.py', 'b/manifest.py', 'b/repair.py'] });
    assert.ok(result.unproven.some(item => item.startsWith('b/manifest.py write_manifest: no reader')), 'the unsettled writer keeps its note');
    assert.ok(!result.unproven.some(item => item.startsWith('a/manifest.py write_manifest: no reader')), 'the settled writer loses it');
  });
});

test('Given two modules that share a record family but no import edge, When the stage runs, Then no pair is invented', { skip: !pythonPresent && 'python is not on PATH' }, async () => {
  await withSnapshot({
    'a.py': 'def write_item(name):\n    return {"name": name}\n',
    'b.py': 'def read_item(record):\n    raise ValueError("never called")\n',
  }, async root => {
    const result = await runContractAnalysis(root, {}, { changedPaths: ['a.py', 'b.py'] });
    assert.deepEqual(result.pairs, []);
    assert.equal(result.status, 'partial', 'a writer without a reader in its own module is reported as unsettled');
    assert.ok(result.unproven.some(item => /no reader of the same record family/.test(item)));
  });
});
