import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { stampHookTemplate } from '../src/domain/hook-template.mjs';
import { syncTarget } from '../scripts/sync-targets.mjs';

const RUNNER = '.omp/review-kit/run-review.mjs';
const STUB = await readFile('templates/review-kit/run-review.mjs', 'utf8');
const HOOK = await readFile('templates/githooks/pre-commit', 'utf8');
const HOOK_TARGET = '.githooks/pre-commit';

// A registered repository with a git directory and, when given, a vendored runner.
async function repoWithRunner(runner) {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-sync-runner-'));
  await mkdir(path.join(repo, '.git'));
  if (runner !== null) {
    await mkdir(path.join(repo, '.omp', 'review-kit'), { recursive: true });
    await writeFile(path.join(repo, RUNNER), runner);
  }
  return repo;
}

describe('Feature: sync-targets puts the thin runner stub in place without rolling a newer runner back', () => {
  it('Given a runner of an older release, When the registry is synced with --apply, Then the stub replaces it', async () => {
    const repo = await repoWithRunner('// omp-reviewer-kit runner v0.0.1\nold\n');
    try {
      assert.equal((await syncTarget(repo)).files[0].state, 'stale');

      const applied = await syncTarget(repo, { apply: true });
      assert.equal(applied.files[0].state, 'updated');
      assert.equal(await readFile(path.join(repo, RUNNER), 'utf8'), STUB);
      assert.equal((await syncTarget(repo)).files[0].state, 'ok');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('Given a hook from a newer kit release, When the registry is synced with --apply, Then it is kept', async () => {
    const newer = stampHookTemplate(HOOK, '99.0.0');
    const repo = await repoWithRunner(null);
    try {
      await mkdir(path.join(repo, '.githooks'), { recursive: true });
      await writeFile(path.join(repo, HOOK_TARGET), newer);

      const applied = await syncTarget(repo, { apply: true });
      assert.equal(applied.files[1].state, 'newer');
      assert.equal(await readFile(path.join(repo, HOOK_TARGET), 'utf8'), newer);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('Given a hook of an older release, When the registry is synced with --apply, Then the template replaces it', async () => {
    const older = stampHookTemplate(HOOK, '0.0.1');
    const repo = await repoWithRunner(null);
    try {
      await mkdir(path.join(repo, '.githooks'), { recursive: true });
      await writeFile(path.join(repo, HOOK_TARGET), older);

      const applied = await syncTarget(repo, { apply: true });
      assert.equal(applied.files[1].state, 'updated');
      assert.equal(await readFile(path.join(repo, HOOK_TARGET), 'utf8'), HOOK);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('Given a runner newer than this release, When the registry is synced with --apply, Then it is kept', async () => {
    const newer = '// omp-reviewer-kit runner v99.0.0\nnewer\n';
    const repo = await repoWithRunner(newer);
    try {
      const applied = await syncTarget(repo, { apply: true });
      assert.equal(applied.files[0].state, 'newer');
      assert.equal(await readFile(path.join(repo, RUNNER), 'utf8'), newer);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('Given no runner yet, When the registry is synced with --apply, Then the stub is written', async () => {
    const repo = await repoWithRunner(null);
    try {
      assert.equal((await syncTarget(repo)).files[0].state, 'missing');
      assert.equal((await syncTarget(repo, { apply: true })).files[0].state, 'updated');
      assert.equal(await readFile(path.join(repo, RUNNER), 'utf8'), STUB);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
