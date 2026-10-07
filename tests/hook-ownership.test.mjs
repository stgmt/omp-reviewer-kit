import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LEGACY_HOOK_DIGESTS } from '../src/application/installer-service.mjs';
import { hookBodyDigest, isHookNewer, isOwnedHook, parseHookMarker, stampHookTemplate } from '../src/domain/hook-template.mjs';
import { CANONICAL_RUNNER, STALE_RUNNER, workspace } from './target-workspace.mjs';

const TEMPLATE = await readFile('templates/githooks/pre-commit', 'utf8');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const hookOf = (dir) => path.join(dir, '.githooks', 'pre-commit');

test('Given the shipped template, Then its marker names the package version and verifies, and an edit to its body breaks ownership', () => {
  assert.equal(parseHookMarker(TEMPLATE).version, pkg.version);
  assert.equal(isOwnedHook(TEMPLATE), true);
  assert.equal(isOwnedHook(TEMPLATE.replace('set -eu', 'set -eu\n# hand edit')), false, 'a hand-edited hook keeps its marker but is not ours');
});

test('Given the hook templates shipped before markers existed, Then each is recognised through its frozen digest', async () => {
  const fixtures = (await readdir('tests/fixtures/hooks')).filter((name) => name.endsWith('.sh'));
  assert.equal(fixtures.length, 3, 'three legacy templates are kept as fixtures');
  for (const name of fixtures) {
    const text = await readFile(path.join('tests/fixtures/hooks', name), 'utf8');
    assert.ok(LEGACY_HOOK_DIGESTS.includes(hookBodyDigest(text)), `${name} is in LEGACY_HOOK_DIGESTS`);
    assert.notEqual(text, TEMPLATE, `${name} is an older template`);
  }
});

test('Given a hook stamped by a newer release, Then it is ours and is never treated as older than the plugin template', () => {
  const newer = stampHookTemplate(`${TEMPLATE}# a later change\n`, '9.9.9');
  assert.equal(isOwnedHook(newer), true);
  assert.equal(isHookNewer(newer, TEMPLATE), true);
  assert.equal(isHookNewer(TEMPLATE, newer), false, 'the plugin never replaces a hook that is newer than itself');
  assert.equal(isHookNewer(TEMPLATE, TEMPLATE), false, 'an identical hook is current, not newer');
  const older = stampHookTemplate(`${TEMPLATE}# an earlier change\n`, '0.1.0');
  assert.equal(isOwnedHook(older), true);
  assert.equal(isHookNewer(older, TEMPLATE), false);
});

test('Given a newer hook edited after its release, Then it is nobody\'s and is neither owned nor newer', () => {
  const edited = stampHookTemplate(`${TEMPLATE}# a later change\n`, '9.9.9').replace('# a later change', '# hand edit');
  assert.equal(isOwnedHook(edited), false);
  assert.equal(isHookNewer(edited, TEMPLATE), false);
});

test('Given a template, When it is stamped again or has CRLF line endings, Then the marker is stable', () => {
  const once = stampHookTemplate(TEMPLATE, '1.2.3');
  assert.equal(stampHookTemplate(once, '1.2.3'), once);
  assert.equal(isOwnedHook(once.replace(/\n/g, '\r\n')), true, 'line endings do not change the digest');
  assert.equal(parseHookMarker(stampHookTemplate(once, '1.2.4')).version, '1.2.4', 'a restamp replaces the version');
});

test('Given a repository on a legacy hook and a stale runner, When targets are healed, Then the hook and the runner are brought to the current release', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('legacy');
    await ws.registry.add(repo);
    await writeHook(repo, await readFile('tests/fixtures/hooks/pre-commit-566c59e.sh', 'utf8'));
    await ws.makeStale(repo);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary.healed, [path.resolve(repo)]);
    assert.equal(await readFile(hookOf(repo), 'utf8'), TEMPLATE);
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), CANONICAL_RUNNER);
  } finally {
    await ws.cleanup();
  }
});

test('Given a hook from a newer release and a stale runner, When targets are healed, Then the hook is kept and the runner is refreshed', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('newer');
    await ws.registry.add(repo);
    const newer = stampHookTemplate(`${TEMPLATE}# a later change\n`, '9.9.9');
    await writeHook(repo, newer);
    await ws.makeStale(repo);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary.healed, [path.resolve(repo)]);
    assert.equal(await readFile(hookOf(repo), 'utf8'), newer, 'a newer release\'s hook is never downgraded');
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), CANONICAL_RUNNER);
    const again = await ws.installer.healTargets();
    assert.deepEqual(again.healed, [], 'a newer release\'s hook counts as current, so the repository is not healed again');
  } finally {
    await ws.cleanup();
  }
});

test('Given a hook edited under an unchanged marker, When targets are healed, Then it is a conflict and nothing is rewritten', async () => {
  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('edited');
    await ws.registry.add(repo);
    const edited = TEMPLATE.replace('set -eu', 'set -eu\n# hand edit');
    await writeHook(repo, edited);
    await ws.makeStale(repo);

    const summary = await ws.installer.healTargets();

    assert.deepEqual(summary.healed, []);
    assert.equal(await readFile(hookOf(repo), 'utf8'), edited, 'the hand-edited hook is left exactly as it is');
    assert.equal(await readFile(ws.runnerOf(repo), 'utf8'), STALE_RUNNER);
    assert.equal((await ws.installer.status(repo)).state, 'conflict');
  } finally {
    await ws.cleanup();
  }
});

async function stampedCopyOf(version, template) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-stamp-hook-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'domain'), { recursive: true });
  await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
  await copyFile('scripts/stamp-hook.mjs', path.join(dir, 'scripts', 'stamp-hook.mjs'));
  await copyFile('src/domain/hook-template.mjs', path.join(dir, 'src', 'domain', 'hook-template.mjs'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version }));
  await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), template, 'utf8');
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'stamp-hook.mjs')], { encoding: 'utf8' });
  const written = await readFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), 'utf8');
  return { dir, run, written };
}

const withoutMarker = (text) => text.split('\n').filter((_, index) => index !== 1).join('\n').trimEnd();

test('Given an unstamped template in a kit-shaped directory, When stamp-hook runs, Then the written marker names the package version and matches the body', async () => {
  const unstamped = withoutMarker(TEMPLATE);
  const { dir, run, written } = await stampedCopyOf('0.20.0', unstamped);
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'stamped templates/githooks/pre-commit as v0.20.0');
    assert.equal(parseHookMarker(written).version, '0.20.0');
    assert.equal(isOwnedHook(written), true, 'the written marker verifies against the written body');
    assert.equal(withoutMarker(written), unstamped, 'the hook body is preserved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a template with a wrong-version marker, When stamp-hook runs, Then the marker is replaced and the body is preserved', async () => {
  const stale = stampHookTemplate(withoutMarker(TEMPLATE), '0.1.0');
  const { dir, run, written } = await stampedCopyOf('0.20.0', stale);
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(parseHookMarker(written).version, '0.20.0');
    assert.equal(isOwnedHook(written), true);
    assert.equal(withoutMarker(written), withoutMarker(stale), 'only the marker line changes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function writeHook(repo, text) {
  return writeFile(hookOf(repo), text, 'utf8');
}
