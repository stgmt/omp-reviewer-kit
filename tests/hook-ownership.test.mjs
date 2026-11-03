import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LEGACY_HOOK_DIGESTS } from '../src/application/installer-service.mjs';
import { HOOK_FORMAT, hookBodyDigest, isHookNewer, isOwnedHook, parseHookFormat, stampHookTemplate } from '../src/domain/hook-template.mjs';
import { CANONICAL_RUNNER, STALE_RUNNER, workspace } from './target-workspace.mjs';

const TEMPLATE = await readFile('templates/githooks/pre-commit', 'utf8');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const hookOf = (dir) => path.join(dir, '.githooks', 'pre-commit');

test('Given the shipped template, Then its marker names the hook format and not the release, and an edit to its body breaks ownership', () => {
  assert.equal(parseHookFormat(TEMPLATE).format, HOOK_FORMAT);
  assert.equal(TEMPLATE.includes(`v${pkg.version}`), false, 'a release version in the hook would rewrite every repository on every release');
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

test('Given a hook stamped by a newer format, Then it is ours and is never treated as older than the plugin template', () => {
  const newer = stampHookTemplate(`${TEMPLATE}# a later change\n`, HOOK_FORMAT + 1);
  assert.equal(isOwnedHook(newer), true);
  assert.equal(isHookNewer(newer, TEMPLATE), true);
  assert.equal(isHookNewer(TEMPLATE, newer), false, 'the plugin never replaces a hook that is newer than itself');
  assert.equal(isHookNewer(TEMPLATE, TEMPLATE), false, 'an identical hook is current, not newer');
  const older = stampHookTemplate(`${TEMPLATE}# an earlier change\n`, Math.max(0, HOOK_FORMAT - 1));
  assert.equal(isOwnedHook(older), true);
  assert.equal(isHookNewer(older, TEMPLATE), false);
});

test('Given a newer hook edited after its release, Then it is nobody\'s and is neither owned nor newer', () => {
  const edited = stampHookTemplate(`${TEMPLATE}# a later change\n`, HOOK_FORMAT + 1).replace('# a later change', '# hand edit');
  assert.equal(isOwnedHook(edited), false);
  assert.equal(isHookNewer(edited, TEMPLATE), false);
});

test('Given a template, When it is stamped again or has CRLF line endings, Then the marker is stable', () => {
  const once = stampHookTemplate(TEMPLATE);
  assert.equal(stampHookTemplate(once), once, 'stamping twice changes nothing');
  assert.equal(isOwnedHook(once.replace(/\n/g, '\r\n')), true, 'line endings do not change the digest');
  assert.equal(parseHookFormat(stampHookTemplate(once, HOOK_FORMAT + 1)).format, HOOK_FORMAT + 1, 'a restamp replaces the format');
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
    const newer = stampHookTemplate(`${TEMPLATE}# a later change\n`, HOOK_FORMAT + 1);
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

async function stampedCopyOf(template) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-stamp-hook-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'domain'), { recursive: true });
  await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
  await copyFile('scripts/stamp-hook.mjs', path.join(dir, 'scripts', 'stamp-hook.mjs'));
  await copyFile('src/domain/hook-template.mjs', path.join(dir, 'src', 'domain', 'hook-template.mjs'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.0.0' }));
  await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), template, 'utf8');
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'stamp-hook.mjs')], { encoding: 'utf8' });
  const written = await readFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), 'utf8');
  return { dir, run, written };
}

const withoutMarker = (text) => text.split('\n').filter((_, index) => index !== 1).join('\n').trimEnd();

test('Given an unstamped template in a kit-shaped directory, When stamp-hook runs, Then the written marker names the hook format and matches the body', async () => {
  const unstamped = withoutMarker(TEMPLATE);
  const { dir, run, written } = await stampedCopyOf(unstamped);
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), `stamped templates/githooks/pre-commit as hook-format v${HOOK_FORMAT}`);
    assert.equal(parseHookFormat(written).format, HOOK_FORMAT);
    assert.equal(isOwnedHook(written), true, 'the written marker verifies against the written body');
    assert.equal(withoutMarker(written), unstamped, 'the hook body is preserved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a template with a stale marker, When stamp-hook runs, Then the marker is replaced and the body is preserved', async () => {
  const stale = stampHookTemplate(withoutMarker(TEMPLATE), Math.max(0, HOOK_FORMAT - 1));
  const { dir, run, written } = await stampedCopyOf(stale);
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(parseHookFormat(written).format, HOOK_FORMAT);
    assert.equal(isOwnedHook(written), true);
    assert.equal(withoutMarker(written), withoutMarker(stale), 'only the marker line changes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function writeHook(repo, text) {
  return writeFile(hookOf(repo), text, 'utf8');
}

test('Given an unstamped hook whose body quotes a marker-shaped line, When it is stamped, Then the quoted data survives and the digest covers it', () => {
  const quoted = `#!/bin/sh\nset -eu\ncat <<'EOF'\n# omp-reviewer-kit hook v0.1.0 body-sha256:${'c'.repeat(64)}\nEOF\n`;
  const stamped = stampHookTemplate(quoted);
  assert.equal(stamped.includes('set -eu'), true, 'the line after the shebang is body data, not a marker');
  assert.equal(stamped.includes(`# omp-reviewer-kit hook v0.1.0 body-sha256:${'c'.repeat(64)}`), true, 'the quoted marker is body data, not metadata');
  assert.equal(isOwnedHook(stamped), true);
});


test('Given a hook written by an earlier release, When it is read and healed, Then it is ours, it migrates once, and a second heal changes nothing', async () => {
  const body = TEMPLATE.split('\n').slice(2).join('\n');
  const legacy = `#!/bin/sh\n# omp-reviewer-kit hook v0.26.3 body-sha256:${hookBodyDigest(TEMPLATE)}\n${body}`;
  const parsed = parseHookFormat(legacy);
  assert.ok(parsed, 'a release-version hook still parses as one of ours');
  assert.equal(parsed.format, 0, 'a release-version hook is the oldest format');
  assert.equal(isOwnedHook(legacy), true, 'its digest still proves it is ours');

  const ws = await workspace();
  try {
    const repo = await ws.makeRepo('legacy-marker');
    await ws.registry.add(repo);
    await writeHook(repo, legacy);
    const summary = await ws.installer.healTargets();
    assert.deepEqual(summary.healed, [path.resolve(repo)]);
    const migrated = await readFile(hookOf(repo), 'utf8');
    assert.equal(parseHookFormat(migrated).format, HOOK_FORMAT, 'the hook is migrated to the current format');
    const again = await ws.installer.healTargets();
    assert.deepEqual(again.healed, [], 'a migrated hook is current, so nothing is rewritten again');
  } finally {
    await ws.cleanup();
  }
});
