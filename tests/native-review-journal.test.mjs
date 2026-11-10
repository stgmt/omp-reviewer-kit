// A review answered by the journal: the same index tree returns the stored verdict without running
// the model, and any change to the staged tree misses. Real git in a temporary repository; the task
// runner is a fake that records whether it was called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runNativeReview } from '../src/native/native-review.mjs';
import { readJournal, writeJournal } from '../src/infra/review-journal-store.mjs';

const KIT_ROOT = path.resolve(import.meta.dirname, '..');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-journal-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@example.com']);
  git(dir, ['config', 'user.name', 'Probe']);
  await writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function fakeTask() {
  const calls = [];
  const runTask = async () => {
    calls.push(1);
    return {
      reviewer: {
        exitCode: 0,
        extractedToolData: {
          yield: [{ status: 'success', data: 'REVIEW_RESULT=PASS' }],
          task: [],
        },
      },
      stages: [],
      sessionFile: null,
    };
  };
  return { runTask, calls };
}

const contractStub = async () => ({ status: 'no-pairs', pairs: [], unparsedFiles: [], unproven: [], policy: 'advisory' });

test('Given a stored verdict for the same index tree, When the review runs, Then the model is not called', async () => {
  const repo = await tempRepo();
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'review-journal-hit-'));
  try {
    await writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
    git(repo, ['add', 'b.txt']);

    const first = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: fakeTask().runTask,
      runContract: contractStub,
    });
    assert.equal(first.journal.hit, false);
    assert.ok(first.journal.key, 'the staged state must have a key');

    // The stored verdict is what the next identical tree gets, whatever it says.
    const stored = await readJournal(journalRoot, first.journal.key);
    assert.ok(stored, 'a finished review must be journaled');
    await writeJournal(journalRoot, first.journal.key, {
      ...stored,
      verdict: { pass: true, verdict: 'PASS', reasons: [] },
      text: 'REVIEW_RESULT=PASS',
      provenance: { role: 'task', model: 'fake/model' },
    });

    const task = fakeTask();
    const reused = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: task.runTask,
      runContract: contractStub,
    });

    assert.equal(task.calls.length, 0, 'a journal hit must not run the model');
    assert.equal(reused.journal.hit, true);
    assert.equal(reused.journal.key, first.journal.key);
    assert.equal(reused.verdict.pass, true);
    assert.equal(reused.verdict.verdict, 'PASS');
    assert.equal(reused.text, 'REVIEW_RESULT=PASS');
    assert.equal(reused.provenance.model, 'fake/model');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('Given a changed index tree, When the review runs, Then the stored verdict does not apply and the model runs', async () => {
  const repo = await tempRepo();
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'review-journal-miss-'));
  try {
    await writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
    git(repo, ['add', 'b.txt']);
    const task = fakeTask();
    const first = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: task.runTask,
      runContract: contractStub,
    });
    assert.equal(first.journal.hit, false);
    assert.equal(task.calls.length, 1);

    await writeFile(path.join(repo, 'c.txt'), 'three\n', 'utf8');
    git(repo, ['add', 'c.txt']);
    const second = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: task.runTask,
      runContract: contractStub,
    });
    assert.equal(second.journal.hit, false);
    assert.equal(task.calls.length, 2, 'a new index tree is a new review');
    assert.notEqual(first.journal.key, second.journal.key);

    const stored = await readJournal(journalRoot, second.journal.key);
    assert.ok(stored, 'the finished review is journaled for the next identical tree');
    assert.equal(stored.state, 'done');
    assert.equal(stored.ignoredStagedPaths.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});
