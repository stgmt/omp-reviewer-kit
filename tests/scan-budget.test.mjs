// The bounded file discovery: past the file ceiling the walk keeps going only long enough to report
// what it did not read, and it retains at most the number of records it was allowed. An unbounded
// excess list holds a whole tree in memory for a report nobody reads.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectExecutableFiles } from '../src/native/maintainability/extract.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

async function treeOf(count) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scan-budget-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(path.join(root, 'src', `unit-${index}.mjs`), `export const value${index} = ${index};\n`, 'utf8');
  }
  return root;
}

test('Given more files than the ceiling, When the walk retains two skipped records, Then exactly two are kept and the walk is marked truncated', async () => {
  const root = await treeOf(10);
  try {
    const collected = await collectExecutableFiles({
      rootDir: root,
      config: { maxScanFiles: 3, maxFileBytes: 524288 },
      classify: () => 'executable',
      maxSkipped: 2,
    });
    assert.equal(collected.paths.length, 3, 'the ceiling is honoured');
    assert.equal(collected.skipped.length, 2, 'only the allowed number of excess records is retained');
    assert.equal(collected.truncated, true, 'the walk says it stopped reporting');
    assert.deepEqual(collected.skipped.map(entry => entry.reason), ['max-scan-files', 'max-scan-files']);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an unbounded excess list, When the walk is asked, Then every over-ceiling path is reported', async () => {
  const root = await treeOf(6);
  try {
    const collected = await collectExecutableFiles({
      rootDir: root,
      config: { maxScanFiles: 2, maxFileBytes: 524288 },
      classify: () => 'executable',
    });
    assert.equal(collected.paths.length, 2);
    assert.equal(collected.skipped.length, 4, 'without a cap the walk reports every path it did not read');
    assert.equal(collected.truncated, false);
  } finally {
    await rm(root, REMOVE);
  }
});
