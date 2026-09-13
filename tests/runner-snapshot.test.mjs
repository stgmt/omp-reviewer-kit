import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runReview } from '../scripts/run-review.mjs';

const TEST_ROLES = { smol: 'acme/smol-flash:high', task: 'acme/task-fast:high', slow: 'acme/slow-max:max' };
const testRoleResolver = () => TEST_ROLES;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function makePassReviewerFromSnapshot() {
  return async (prompt) => {
    const snapshotMatch = prompt.match(/snapshot directory is (.+?)\.\r?\n/);
    assert.ok(snapshotMatch, `prompt does not carry the staged snapshot directory: ${prompt}`);
    assert.match(prompt, /correctness and security risk lanes/);
    assert.match(prompt, /focused tests.*YAGNI|YAGNI.*focused tests/i);
    const snapshotDir = snapshotMatch[1];
    const aContent = await readFile(path.join(snapshotDir, 'a.txt'), 'utf8');
    assert.equal(aContent, 'v1', 'snapshot must contain staged a.txt content');
    assert.match(prompt, /\.review\/diff\.patch/, 'prompt must name the materialized diff file');
    const patch = await readFile(path.join(snapshotDir, '.review', 'diff.patch'), 'utf8');
    assert.match(patch, /a\.txt/, 'diff.patch must carry the staged diff content');
    const manifest = await readFile(path.join(snapshotDir, '.review', 'changed-files.txt'), 'utf8');
    assert.equal(manifest.trim(), 'a.txt');
    return { status: 0, stdout: 'REVIEW_RESULT=PASS', stderr: '' };
  };
}

test('runner passes the staged snapshot to the reviewer, not the worktree', async () => {
  // Given a repository where a.txt is staged as v1 while the worktree holds v1-edit
  const repoDir = await mkdtemp(path.join(tmpdir(), 'omp-runner-snap-'));
  try {
    git(['init'], repoDir);
    git(['config', 'user.name', 'Runner Snapshot'], repoDir);
    git(['config', 'user.email', 'runner-snapshot@test.local'], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'v1', 'utf8');
    git(['add', 'a.txt'], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'v1-edit', 'utf8');

    // When the hook runner executes the review against a reviewer that reads only the snapshot
    const result = await runReview({
      cwd: repoDir,
      omp: makePassReviewerFromSnapshot(),
      ompOptions: { roleResolver: testRoleResolver },
    });

    // Then the reviewer saw the staged v1 through the snapshot and allowed the commit
    assert.equal(result.skipped, false, 'a staged change must not be skipped');
    assert.equal(result.verdict, 'PASS', 'reviewer must read staged content from the snapshot, not the worktree');
    assert.equal(result.exitCode, 0);
    const reportContent = await readFile(result.reportPath, 'utf8');
    assert.match(reportContent, /### Verified-OK/);
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('runner applies OMP_REVIEW_KIT_EFFORT to the resolved model selector', async () => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'omp-runner-effort-'));
  const previous = process.env.OMP_REVIEW_KIT_EFFORT;
  process.env.OMP_REVIEW_KIT_EFFORT = 'low';
  try {
    git(['init'], repoDir);
    git(['config', 'user.name', 'Runner Effort'], repoDir);
    git(['config', 'user.email', 'runner-effort@test.local'], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'v1', 'utf8');
    git(['add', 'a.txt'], repoDir);

    let seenModel;
    const result = await runReview({
      cwd: repoDir,
      omp: async (text, root, timeoutMs, model) => {
        seenModel = model;
        return { status: 0, stdout: 'REVIEW_RESULT=PASS', stderr: '' };
      },
      ompOptions: { roleResolver: testRoleResolver },
    });

    assert.equal(result.verdict, 'PASS');
    assert.equal(seenModel, 'acme/smol-flash:low', 'effort override must rewrite the resolved selector suffix');
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_EFFORT;
    else process.env.OMP_REVIEW_KIT_EFFORT = previous;
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('runner fails closed when the staged snapshot cannot be built', async () => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'omp-runner-snap-failure-'));
  try {
    await assert.rejects(
      runReview({
        cwd: repoDir,
        git: (args) => {
          if (args[0] === 'rev-parse') return Buffer.from(`${repoDir}\n`);
          if (args[0] === 'diff') return Buffer.from('staged diff');
          if (args[0] === 'ls-files') return Buffer.from('malformed index entry');
          return Buffer.alloc(0);
        },
        omp: () => { throw new Error('reviewer must not run'); },
      }),
      /invalid staged entry/
    );
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
});