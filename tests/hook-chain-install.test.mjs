import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { isOwnedChain, renderChainBlock } from '../src/domain/hook-chain.mjs';
import { workspace } from './target-workspace.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
const hooksPathOf = (cwd) => git(cwd, 'config', '--get', 'core.hooksPath').stdout.trim();
const same = (left, right) => realpathSync.native(left) === realpathSync.native(right);
// What husky v9 generates: the effective pre-commit only sources the sibling "h".
const HOST_HOOK = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
// Husky's "h": runs the user's hook in a child shell and exits with its code, so anything appended
// after the source line in the generated shim is dead code.
const HUSKY_H = `#!/usr/bin/env sh
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n
[ ! -f "$s" ] && exit 0
sh -e "$s" "$@"
c=$?
exit $c
`;

let current;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});
const open = async () => (current = await workspace());

/**
 * A husky v9 checkout: core.hooksPath is .husky/_, the generated shim is untracked, the user's
 * own .husky/pre-commit is the hook husky's "h" runs.
 */
async function huskyRepo(makeRepo, name, { tracked = false, userHook = '#!/usr/bin/env sh\nexit 0\n' } = {}) {
  const repo = await makeRepo(name, { hook: false });
  const huskyDir = path.join(repo, '.husky');
  await mkdir(path.join(huskyDir, '_'), { recursive: true });
  await writeFile(path.join(huskyDir, '_', '.gitignore'), '*\n');
  const hostPath = path.join(huskyDir, '_', 'pre-commit');
  await writeFile(hostPath, HOST_HOOK, { mode: 0o755 });
  await writeFile(path.join(huskyDir, '_', 'h'), HUSKY_H, { mode: 0o755 });
  await writeFile(path.join(huskyDir, 'pre-commit'), userHook, { mode: 0o755 });
  if (tracked) git(repo, 'add', '-f', '--', '.husky/_/pre-commit');
  git(repo, 'config', 'core.hooksPath', '.husky/_');
  return { repo, hostPath };
}

/** Replaces the vendored runner with a stub that records the call and exits with `code`. */
async function stubRunner(repo, marker, code) {
  const runner = path.join(repo, '.omp', 'review-kit', 'run-review.mjs');
  await writeFile(runner, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(marker)}, 'review\\n');`,
    `process.exit(${code});`,
    '',
  ].join('\n'));
}

describe('Feature: the kit runs from another tool\'s generated hook', () => {
  it('Given husky owns core.hooksPath, When setup runs, Then the review block is inserted and the host hook stays byte-identical', async () => {
    const { makeRepo, installer } = await open();
    const { repo, hostPath } = await huskyRepo(makeRepo, 'husky-chain');
    const hostBefore = await readFile(hostPath, 'utf8');

    const result = await installer.setup(repo);
    assert.equal(result.success, true);
    assert.match(result.message, /core\.hooksPath "\.husky\/_" kept/);
    assert.equal(hooksPathOf(repo), '.husky/_');

    const hostAfter = await readFile(hostPath, 'utf8');
    assert.equal(hostAfter.replace(renderChainBlock(), ''), hostBefore, 'the host hook body is untouched');
    assert.equal(isOwnedChain(hostAfter), true);
    // No dead safety-net shim: in chaining mode there is no .githooks/pre-commit for it to start.
    assert.equal(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')), false);

    const status = await installer.status(repo);
    assert.equal(status.state, 'active');
    assert.ok(status.chainHookPath !== null && same(status.chainHookPath, hostPath));
    assert.equal(status.conflictReason, null);

    const assessment = await installer.assessHook(repo);
    assert.equal(assessment.kind, 'chained');
    assert.equal(assessment.effective, true);
    assert.deepEqual(await installer.guardCommit(repo), { action: 'allow' });
  });

  it('Given a second setup, Then the block is not duplicated', async () => {
    const { makeRepo, installer } = await open();
    const { repo, hostPath } = await huskyRepo(makeRepo, 'husky-idempotent');
    assert.equal((await installer.setup(repo)).success, true);
    const first = await readFile(hostPath, 'utf8');
    assert.equal((await installer.setup(repo)).success, true);
    const second = await readFile(hostPath, 'utf8');
    assert.equal(second, first);
    assert.equal((second.match(/# >>> omp-reviewer-kit chain/g) ?? []).length, 1);
  });

  it('Given husky runs its hook, When a commit starts, Then the review runs after the host hook and its PASS lets the commit through', async () => {
    const { base, makeRepo, installer } = await open();
    const marker = path.join(base, 'review.log');
    const { repo, hostPath } = await huskyRepo(makeRepo, 'husky-exec', {
      userHook: `#!/usr/bin/env sh\nprintf 'host\\n' >> ${JSON.stringify(marker)}\nexit 0\n`,
    });
    assert.equal((await installer.setup(repo)).success, true);
    await stubRunner(repo, marker, 0);

    await writeFile(path.join(repo, 'work.txt'), 'one\n');
    git(repo, 'add', '--', 'work.txt');
    const commit = git(repo, 'commit', '-m', 'work');

    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(await readFile(marker, 'utf8'), 'host\nreview\n', 'review runs after the host hook');
    assert.ok(isOwnedChain(await readFile(hostPath, 'utf8')));
  });

  it('Given the review refuses the change, Then the commit is blocked', async () => {
    const { base, makeRepo, installer } = await open();
    const marker = path.join(base, 'review-blocked.log');
    const { repo } = await huskyRepo(makeRepo, 'husky-exec-block', {
      userHook: `#!/usr/bin/env sh\nprintf 'host\\n' >> ${JSON.stringify(marker)}\nexit 0\n`,
    });
    assert.equal((await installer.setup(repo)).success, true);
    await stubRunner(repo, marker, 1);

    await writeFile(path.join(repo, 'work.txt'), 'one\n');
    git(repo, 'add', '--', 'work.txt');
    const commit = git(repo, 'commit', '-m', 'work');

    assert.notEqual(commit.status, 0);
    assert.equal(await readFile(marker, 'utf8'), 'host\nreview\n');
    assert.notEqual(git(repo, 'rev-parse', '--verify', 'HEAD').status, 0, 'no commit was created');
  });

  it('Given a linked worktree and a hook in the shared hooks directory, Then setup reports a conflict instead of writing a shared block', async () => {
    const { base, makeRepo, installer } = await open();
    const main = await makeRepo('worktree-main', { hook: false });
    await writeFile(path.join(main, 'seed.txt'), 'seed\n');
    git(main, 'add', '--', 'seed.txt');
    assert.equal(git(main, 'commit', '-m', 'seed').status, 0);
    const worktree = path.join(base, 'linked-worktree');
    assert.equal(git(main, 'worktree', 'add', '-q', '--detach', worktree).status, 0);

    // A hook manager installed its generated hook into the shared .git/hooks, outside the worktree.
    const hooksDir = path.join(main, '.git', 'hooks');
    const hostPath = path.join(hooksDir, 'pre-commit');
    const host = '#!/bin/sh\nprintf "host\\n"\n';
    await writeFile(hostPath, host, { mode: 0o755 });

    // A throw here would be an infrastructure failure of the gate, not a deciding assertion.
    const result = await installer.setup(worktree).then(
      (value) => value,
      (error) => ({ success: false, state: 'threw', message: error instanceof Error ? error.message : String(error) }),
    );
    assert.equal(result.success, false);
    assert.equal(result.state, 'conflict');
    assert.match(result.message, /outside this checkout/);
    assert.equal(await readFile(hostPath, 'utf8'), host, 'the shared host is untouched');
    assert.equal(existsSync(path.join(worktree, '.omp', 'review-kit', 'run-review.mjs')), false,
      'a refusal writes no runner that would guard the checkout');
  });

  it('Given a chained install, When a stray core.hooksPath points at the default hooks directory, Then the guard repairs the checkout instead of allowing an unreviewed commit', async () => {
    const { makeRepo, installer } = await open();
    const { repo } = await huskyRepo(makeRepo, 'chain-stray');
    assert.equal((await installer.setup(repo)).success, true);
    git(repo, 'config', 'core.hooksPath', '.git/hooks');

    const guarded = await installer.guardCommit(repo);
    assert.equal(guarded.action, 'allow');
    assert.equal(guarded.repaired, true);
    assert.equal(hooksPathOf(repo), '.githooks');
    assert.equal(existsSync(path.join(repo, '.githooks', 'pre-commit')), true);
  });

  it('Given a chained install and a stale runner, Then doctor names the runner instead of the present block', async () => {
    const { makeRepo, installer, makeStale } = await open();
    const { repo } = await huskyRepo(makeRepo, 'husky-doctor');
    assert.equal((await installer.setup(repo)).success, true);
    await makeStale(repo);
    const check = (await installer.doctor(repo)).checks.find((c) => c.name === 'Pre-commit hook');
    assert.equal(check.status, 'WARN');
    assert.match(check.message, /Review runner script is stale/);
  });

  it('Given the host hook refuses the commit, Then the review does not run and the host exit code is kept', async () => {
    const { base, makeRepo, installer } = await open();
    const marker = path.join(base, 'host-refused.log');
    const { repo } = await huskyRepo(makeRepo, 'husky-host-refused', {
      userHook: `#!/usr/bin/env sh\nprintf 'host\\n' >> ${JSON.stringify(marker)}\nexit 1\n`,
    });
    assert.equal((await installer.setup(repo)).success, true);
    await stubRunner(repo, marker, 0);

    await writeFile(path.join(repo, 'work.txt'), 'one\n');
    git(repo, 'add', '--', 'work.txt');
    const commit = git(repo, 'commit', '-m', 'work');

    assert.notEqual(commit.status, 0);
    assert.equal(await readFile(marker, 'utf8'), 'host\n', 'the review did not run after the host failed');
    assert.notEqual(git(repo, 'rev-parse', '--verify', 'HEAD').status, 0, 'no commit was created');
  });

  it('Given the review runner is gone, Then the commit is blocked and stderr names the missing file', async () => {
    const { base, makeRepo, installer } = await open();
    const marker = path.join(base, 'missing-runner.log');
    const { repo } = await huskyRepo(makeRepo, 'husky-missing-runner', {
      userHook: `#!/usr/bin/env sh\nprintf 'host\\n' >> ${JSON.stringify(marker)}\nexit 0\n`,
    });
    assert.equal((await installer.setup(repo)).success, true);
    await rm(path.join(repo, '.omp', 'review-kit', 'run-review.mjs'));

    await writeFile(path.join(repo, 'work.txt'), 'one\n');
    git(repo, 'add', '--', 'work.txt');
    const commit = git(repo, 'commit', '-m', 'work');

    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr + commit.stdout, /run-review\.mjs is missing; refusing to commit unreviewed/);
    assert.equal(await readFile(marker, 'utf8'), 'host\n', 'no review marker is written');
    assert.notEqual(git(repo, 'rev-parse', '--verify', 'HEAD').status, 0, 'no commit was created');
  });

  it('Given husky regenerates its shim, When a commit starts, Then the guard restores the block and allows the commit', async () => {
    const { makeRepo, installer } = await open();
    const { repo, hostPath } = await huskyRepo(makeRepo, 'husky-regenerated');
    assert.equal((await installer.setup(repo)).success, true);
    await writeFile(hostPath, HOST_HOOK, { mode: 0o755 });
    assert.equal((await installer.status(repo)).state, 'stale');

    const guarded = await installer.guardCommit(repo);
    assert.equal(guarded.action, 'allow');
    assert.equal(guarded.repaired, true);
    assert.equal(isOwnedChain(await readFile(hostPath, 'utf8')), true);
    assert.equal(hooksPathOf(repo), '.husky/_');
  });

  it('Given the generated shim is tracked, Then the kit never edits it and reports conflict', async () => {
    const { makeRepo, installer } = await open();
    const { repo, hostPath } = await huskyRepo(makeRepo, 'husky-tracked', { tracked: true });
    const hostBefore = await readFile(hostPath, 'utf8');

    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.match(status.conflictReason, /core\.hooksPath is configured to "\.husky\/_"/);

    const result = await installer.setup(repo);
    assert.equal(result.success, false);
    assert.equal(await readFile(hostPath, 'utf8'), hostBefore);
    assert.equal(hooksPathOf(repo), '.husky/_');
  });

  it('Given a generated hook that replaces the shell with exec, Then it stays a conflict and is never edited', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('exec-hook', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    // pre-commit's generated hook: the last branch execs the runner, so an EXIT trap never runs.
    const host = [
      '#!/usr/bin/env bash',
      'INSTALL_PYTHON=/usr/bin/python3',
      'ARGS=(hook-impl --config=.pre-commit-config.yaml --hook-type=pre-commit)',
      'if [ -x "$INSTALL_PYTHON" ]; then',
      '  exec "$INSTALL_PYTHON" -mpre_commit "${ARGS[@]}"',
      'fi',
      'exec pre-commit "${ARGS[@]}"',
      '',
    ].join('\n');
    await writeFile(hostPath, host, { mode: 0o755 });

    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.match(status.conflictReason, /replaces the shell with "exec"/);
    const result = await installer.setup(repo);
    assert.equal(result.success, false);
    assert.equal(await readFile(hostPath, 'utf8'), host);
    assert.equal(hooksPathOf(repo), '');
  });

  it('Given a hook for a non-shell interpreter, Then the kit never writes a shell block into it', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('python-hook', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    const host = '#!/usr/bin/env python3\nprint("host")\n';
    await writeFile(hostPath, host, { mode: 0o755 });

    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.match(status.conflictReason, /runs python3, not a POSIX shell/);
    assert.equal((await installer.setup(repo)).success, false);
    assert.equal(await readFile(hostPath, 'utf8'), host);
  });

  it('Given a hook that is not UTF-8 or is binary, Then it is a conflict and its bytes are untouched', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('binary-hook', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    const invalidUtf8 = Buffer.from([0x67, 0x69, 0x74, 0x20, 0xff, 0x0a]);
    await writeFile(hostPath, invalidUtf8);
    const invalidStatus = await installer.status(repo);
    assert.equal(invalidStatus.state, 'conflict');
    assert.match(invalidStatus.conflictReason, /not UTF-8 text/);
    assert.equal((await installer.setup(repo)).success, false);
    assert.deepEqual(await readFile(hostPath), invalidUtf8);

    const binary = Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x00, 0x0a]);
    await writeFile(hostPath, binary);
    const binaryStatus = await installer.status(repo);
    assert.equal(binaryStatus.state, 'conflict');
    assert.match(binaryStatus.conflictReason, /binary file/);
    assert.equal((await installer.setup(repo)).success, false);
    assert.deepEqual(await readFile(hostPath), binary);
  });

  it('Given a generated hook that installs its own trap, Then it stays a conflict and is never edited', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('trap-hook', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    const host = '#!/bin/sh\ntrap "rm -f .commit.tmp" EXIT\nprintf "host\\n"\n';
    await writeFile(hostPath, host, { mode: 0o755 });

    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.match(status.conflictReason, /installs its own shell trap/);
    assert.equal((await installer.setup(repo)).success, false);
    assert.equal(await readFile(hostPath, 'utf8'), host);
  });

  it('Given a generated hook in git\'s default hooks directory (simple-git-hooks), Then the kit chains into it and leaves every other hook alone', async () => {
    const { base, makeRepo, installer } = await open();
    const marker = path.join(base, 'default-hooks.log');
    const repo = await makeRepo('default-hooks', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    const host = `#!/bin/sh

if [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ]; then
    echo "[INFO] skipped"
    exit 0
fi

printf 'host\\n' >> ${JSON.stringify(marker)}
`;
    await writeFile(hostPath, host, { mode: 0o755 });
    const prePush = '#!/bin/sh\nexit 0\n';
    await writeFile(path.join(hooksDir, 'pre-push'), prePush, { mode: 0o755 });

    const result = await installer.setup(repo);
    assert.equal(result.success, true);
    assert.match(result.message, /git's default hooks directory kept/);
    assert.equal(hooksPathOf(repo), '', 'core.hooksPath stays unset');
    const hostAfter = await readFile(hostPath, 'utf8');
    assert.equal(hostAfter.replace(renderChainBlock(), ''), host);
    assert.equal(await readFile(path.join(hooksDir, 'pre-push'), 'utf8'), prePush);
    assert.equal((await installer.status(repo)).state, 'active');
    assert.equal(existsSync(path.join(repo, '.githooks')), false, 'no .githooks is created');

    await stubRunner(repo, marker, 0);
    await writeFile(path.join(repo, 'work.txt'), 'one\n');
    git(repo, 'add', '--', 'work.txt');
    const commit = git(repo, 'commit', '-m', 'work');
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(await readFile(marker, 'utf8'), 'host\nreview\n');
  });

  it('Given simple-git-hooks rewrites its hook, When a commit starts, Then the guard restores the block into the new hook', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('default-regenerated', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    const host = '#!/bin/sh\nprintf "host\\n"\n';
    await writeFile(hostPath, host, { mode: 0o755 });
    assert.equal((await installer.setup(repo)).success, true);
    await writeFile(hostPath, host, { mode: 0o755 });
    assert.equal((await installer.status(repo)).state, 'stale');

    const guarded = await installer.guardCommit(repo);
    assert.equal(guarded.action, 'allow');
    assert.equal(guarded.repaired, true);
    assert.equal(isOwnedChain(await readFile(hostPath, 'utf8')), true);
    assert.equal(hooksPathOf(repo), '');
  });

  it('Given a lefthook-generated hook, Then the kit chains into it as well', async () => {
    const { makeRepo, installer } = await open();
    const repo = await makeRepo('lefthook-hook', { hook: false });
    const hooksDir = path.join(repo, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hostPath = path.join(hooksDir, 'pre-commit');
    const host = [
      '#!/bin/sh',
      'if [ "$LEFTHOOK" = "0" ]; then',
      '  exit 0',
      'fi',
      'call_lefthook() {',
      '  lefthook "$@"',
      '}',
      'call_lefthook run "pre-commit" "$@"',
      '',
    ].join('\n');
    await writeFile(hostPath, host, { mode: 0o755 });

    assert.equal((await installer.setup(repo)).success, true);
    assert.equal(isOwnedChain(await readFile(hostPath, 'utf8')), true);
    assert.equal((await installer.status(repo)).state, 'active');
  });

  it('Given core.hooksPath names a hooks directory outside the checkout, Then it is a conflict and nothing is written', async () => {
    const { base, makeRepo, installer } = await open();
    const repo = await makeRepo('global-hooks', { hook: false });
    const globalDir = path.join(base, 'global-hooks');
    await mkdir(globalDir, { recursive: true });
    const hostPath = path.join(globalDir, 'pre-commit');
    const host = '#!/bin/sh\nexit 0\n';
    await writeFile(hostPath, host, { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', globalDir);

    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.match(status.conflictReason, /outside this checkout/);
    const result = await installer.setup(repo);
    assert.equal(result.success, false);
    assert.equal(await readFile(hostPath, 'utf8'), host);
    assert.equal(hooksPathOf(repo), globalDir);
  });

  it('Given a block someone edited, Then it is not overwritten and the repository reports conflict', async () => {
    const { makeRepo, installer } = await open();
    const { repo, hostPath } = await huskyRepo(makeRepo, 'husky-edited');
    assert.equal((await installer.setup(repo)).success, true);
    const edited = (await readFile(hostPath, 'utf8')).replace(
      'node "$__omp_review_kit_root/.omp/review-kit/run-review.mjs" || __omp_review_kit_rc=$?',
      'true',
    );
    await writeFile(hostPath, edited, { mode: 0o755 });

    const status = await installer.status(repo);
    assert.equal(status.state, 'conflict');
    assert.match(status.conflictReason, /edited omp-reviewer-kit chain block/);
    assert.equal((await installer.setup(repo)).success, false);
    assert.equal(await readFile(hostPath, 'utf8'), edited);
  });
});
