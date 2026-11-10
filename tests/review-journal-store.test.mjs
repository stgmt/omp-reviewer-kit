// The journal on disk: atomic writes, foreign files ignored, retention that never removes the newest
// review. Real file system in a temporary directory, no mocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  journalDir,
  journalRootDir,
  pruneJournals,
  readJournal,
  readStageEntry,
  stageFileName,
  writeJournal,
  writeStageEntry,
} from '../src/infra/review-journal-store.mjs';

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), 'review-journal-'));
}

test('Given a journal record, When it is written and read back, Then it is the same document', async () => {
  const root = await tempRoot();
  try {
    const record = { schema: 'review-journal@1', key: 'k1', state: 'done', verdict: { pass: true, verdict: 'PASS', reasons: [] } };
    const file = await writeJournal(root, 'k1', record);
    assert.ok(file && file.endsWith('journal.json'));
    assert.deepEqual(await readJournal(root, 'k1'), record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given no journal for a key, When it is read, Then the answer is null rather than an error', async () => {
  const root = await tempRoot();
  try {
    assert.equal(await readJournal(root, 'missing'), null);
    assert.equal(await readStageEntry(root, 'missing', 'review-context-scout'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a stage entry, When it is written and read back, Then the lane in its id survives the file name', async () => {
  const root = await tempRoot();
  try {
    const entry = { schema: 'review-stage@1', key: 'k1', stageId: 'review-risk-hunter:correctness', lane: 'correctness', exitCode: 0 };
    await writeStageEntry(root, 'k1', 'review-risk-hunter:correctness', entry);
    const file = path.join(journalDir(root, 'k1'), 'stages', stageFileName('review-risk-hunter:correctness'));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), entry);
    assert.deepEqual(await readStageEntry(root, 'k1', 'review-risk-hunter:correctness'), entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a corrupt journal file, When it is read, Then the answer is null and the review is not blocked', async () => {
  const root = await tempRoot();
  try {
    await mkdir(journalDir(root, 'k1'), { recursive: true });
    await writeFile(path.join(journalDir(root, 'k1'), 'journal.json'), '{not json', 'utf8');
    assert.equal(await readJournal(root, 'k1'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given more journals than the retention keeps, When pruning runs, Then the newest stay and the rest go', async () => {
  const root = await tempRoot();
  try {
    const now = Date.now();
    for (let index = 0; index < 4; index += 1) {
      const key = `k${index}`;
      await writeJournal(root, key, { schema: 'review-journal@1', key, state: 'done', verdict: { pass: true, verdict: 'PASS', reasons: [] } });
      const stamp = (now - (4 - index) * 60_000) / 1000;
      await utimes(journalDir(root, key), stamp, stamp);
    }
    const removed = await pruneJournals(root, { keep: 2, maxAgeDays: 30, now: () => now });
    assert.equal(removed, 2);
    assert.notEqual(await readJournal(root, 'k3'), null, 'the newest review is never pruned');
    assert.equal(await readJournal(root, 'k0'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given an unrelated directory under the journal root, When pruning runs, Then it is never deleted', async () => {
  const root = await tempRoot();
  try {
    const foreign = path.join(root, 'owner-notes');
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, 'keep.txt'), 'do not delete me\n', 'utf8');
    const now = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const key = `k${index}`;
      await writeJournal(root, key, { schema: 'review-journal@1', key, state: 'done', verdict: { pass: true, verdict: 'PASS', reasons: [] } });
      const stamp = (now - (3 - index) * 60_000) / 1000;
      await utimes(journalDir(root, key), stamp, stamp);
    }
    const removed = await pruneJournals(root, { keep: 1, maxAgeDays: 30, now: () => now });
    assert.equal(removed, 2);
    assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'do not delete me\n');
    assert.notEqual(await readJournal(root, 'k2'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a configured directory, When the root is resolved, Then the environment wins over the home default', () => {
  assert.equal(journalRootDir({ env: { OMP_REVIEW_KIT_JOURNAL_DIR: 'E:/tmp/journals' }, home: 'C:/home' }), 'E:/tmp/journals');
  assert.equal(journalRootDir({ env: {}, home: 'C:/home' }), path.join('C:/home', '.omp', 'review-kit-journal'));
});
