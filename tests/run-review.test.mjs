import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runReview } from '../scripts/run-review.mjs';

async function makeRoot(prefix = 'omp-review-kit-') {
  const reportRoot = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(reportRoot, 'project');
}

function fakeGit(root, diff, calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from(`${root}\n`);
    if (args[0] === 'diff') return Buffer.from(diff);
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

async function runAt(root, diff, ompResult, now = new Date('2026-09-04T12:00:00.000Z')) {
  let prompt = '';
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, diff),
    omp: (value) => {
      prompt = value;
      return ompResult;
    },
    now,
  });
  return { result, prompt, root };
}

async function runFixture(diff, ompResult) {
  return runAt(await makeRoot(), diff, ompResult);
}

test('allows a staged change only after reviewer-kit PASS', async () => {
  const { result, prompt, root } = await runFixture('diff', {
    status: 0,
    stdout: 'Used developer-architecture.\nREVIEW_RESULT=PASS\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 0);
  assert.match(prompt, /agent "reviewer-kit"/);
  assert.match(prompt, /reality-first-review/);
  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /REVIEW_RESULT=PASS/);
  assert.match(report, /developer-architecture/);
  assert.equal(result.reportPath.startsWith(path.join(root, 'audit-reports')), true);
});

test('blocks a staged change after reviewer-kit BLOCK', async () => {
  const { result } = await runFixture('bad diff', {
    status: 0,
    stdout: 'Finding P1.\nREVIEW_RESULT=BLOCK\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
});

test('rejects a malformed result marker', async () => {
  const { result } = await runFixture('diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=PASSED\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
});

test('does not let trailing prose override an exact BLOCK marker', async () => {
  const { result } = await runFixture('bad diff', {
    status: 0,
    stdout: 'Finding P1.\nREVIEW_RESULT=BLOCK\nNote: the next run should emit REVIEW_RESULT=PASS.\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
});

test('fails closed when multiple exact result markers are present', async () => {
  const { result } = await runFixture('bad diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=BLOCK\nREVIEW_RESULT=PASS\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
});

test('fails closed when OMP fails', async () => {
  const { result } = await runFixture('diff', {
    status: 1,
    stdout: '',
    stderr: 'omp unavailable',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
});

test('skips a commit with no staged change', async () => {
  let called = false;
  const root = 'C:/fixture/project';
  const result = await runReview({
    cwd: root,
    git: (args) => args[0] === 'rev-parse' ? Buffer.from(`${root}\n`) : Buffer.alloc(0),
    omp: () => { called = true; throw new Error('must not run'); },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('excludes unstaged working-tree changes from the reviewed hash', async () => {
  const root = await makeRoot('omp-review-kit-git-');
  const stagedDiff = 'staged diff only';
  const calls = [];
  let prompt = '';
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, stagedDiff, calls),
    omp: (value) => {
      prompt = value;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
  });
  const expectedHash = createHash('sha256').update(stagedDiff).digest('hex');

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[1], ['diff', '--cached', '--binary', '--no-ext-diff', '--']);
  assert.match(prompt, new RegExp(expectedHash));
  assert.match(await readFile(result.reportPath, 'utf8'), new RegExp(expectedHash));
});

test('does not overwrite an earlier report', async () => {
  const root = await makeRoot();
  const first = await runAt(root, 'diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=PASS\n',
    stderr: '',
  }, new Date('2026-09-04T12:00:00.000Z'));
  const second = await runAt(root, 'diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=BLOCK\n',
    stderr: '',
  }, new Date('2026-09-04T12:00:01.000Z'));

  assert.notEqual(first.result.reportPath, second.result.reportPath);
  assert.match(await readFile(first.result.reportPath, 'utf8'), /result: PASS/);
  assert.match(await readFile(second.result.reportPath, 'utf8'), /result: BLOCK/);
});
