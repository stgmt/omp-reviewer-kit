import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SubprocessGitAdapter } from '../src/infra/subprocess-git-adapter.mjs';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

test('streams staged diffs larger than the spawnSync default buffer without ENOBUFS', async () => {
  // Given a staged file whose diff exceeds the ~10 MiB spawnSync maxBuffer
  const repoDir = await mkdtemp(path.join(tmpdir(), 'omp-large-diff-'));
  try {
    git(['init'], repoDir);
    git(['config', 'user.name', 'Large Diff Test'], repoDir);
    git(['config', 'user.email', 'large-diff@test.local'], repoDir);
    // 12 MiB of low-entropy text: every byte lands in the diff output.
    await writeFile(path.join(repoDir, 'big.txt'), 'x'.repeat(12 * 1024 * 1024), 'utf8');
    git(['add', 'big.txt'], repoDir);

    // When the streaming adapter captures the staged diff
    const adapter = new SubprocessGitAdapter();
    const diff = await adapter.getStagedDiff(repoDir);

    // Then the full diff arrives instead of throwing ENOBUFS
    assert.equal(diff.isEmpty(), false);
    assert.ok(diff.length > 10 * 1024 * 1024, `expected >10 MiB diff, got ${diff.length}`);
    assert.match(diff.hash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('still accepts legacy synchronous Buffer runners', async () => {
  // Given an injected sync runner as used by existing unit fakes
  const adapter = new SubprocessGitAdapter((args, cwd) => {
    if (args[0] === 'rev-parse') return Buffer.from(`${cwd}\n`);
    return Buffer.from('sync diff');
  });

  // When/Then both methods resolve through await
  assert.equal(await adapter.getRepoRoot('/repo'), '/repo');
  assert.equal((await adapter.getStagedDiff('/repo')).length, Buffer.from('sync diff').length);
});

test('CLI reports infrastructure failures as INFRA_ERROR, not a verdict BLOCK', async () => {
  // Given a directory outside any Git repository
  const outside = await mkdtemp(path.join(tmpdir(), 'omp-outside-git-'));
  try {
    // When the hook runner is executed there
    const res = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'run-review.mjs')], {
      cwd: outside,
      encoding: 'utf8',
      windowsHide: true,
    });

    // Then it fails closed with a distinguishable infrastructure marker
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /reviewer-kit INFRA_ERROR:/);
    assert.doesNotMatch(res.stderr, /reviewer-kit BLOCK:/);
  } finally {
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});
