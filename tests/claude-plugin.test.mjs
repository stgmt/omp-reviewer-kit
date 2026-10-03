import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSkippedTarget, loadTargets, syncTarget } from '../scripts/sync-targets.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('Claude Code plugin manifests stay version-synchronized with the OMP plugin', async () => {
  const pkg = await json('package.json');
  const plugin = await json('.claude-plugin/plugin.json');
  const catalog = await json('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'omp-reviewer-kit');
  assert.equal(plugin.version, pkg.version);
  assert.equal(catalog.plugins[0].version, pkg.version);
  assert.equal(catalog.plugins[0].source, './');
  assert.deepEqual(plugin.agents, [], 'OMP agent frontmatter must not be loaded by Claude Code');
});

test('sync-targets reports drift read-only, applies on request, and skips protected repos', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-sync-'));
  try {
    await mkdir(path.join(repo, '.git'));
    await mkdir(path.join(repo, '.omp', 'review-kit'), { recursive: true });
    await writeFile(path.join(repo, '.omp', 'review-kit', 'run-review.mjs'), 'stale');

    const dry = await syncTarget(repo);
    assert.equal(dry.status, 'drift');
    assert.deepEqual(dry.files.map((f) => f.state), ['stale', 'missing']);
    assert.equal(await readFile(path.join(repo, '.omp', 'review-kit', 'run-review.mjs'), 'utf8'), 'stale');

    const applied = await syncTarget(repo, { apply: true });
    assert.equal(applied.status, 'synced');
    assert.equal(await readFile(path.join(repo, '.omp', 'review-kit', 'run-review.mjs'), 'utf8'), await readFile('scripts/run-review.mjs', 'utf8'));
    assert.equal((await syncTarget(repo)).status, 'synced');

    assert.ok(isSkippedTarget('E:/repos/tp-foo'));
    assert.ok(isSkippedTarget('E:/repos/omp-reviewer-kit-release'));
    assert.ok(!isSkippedTarget('E:/repos/tokenplan'));
    assert.equal((await syncTarget('E:/repos/tp-foo')).status, 'skipped');
    assert.equal((await syncTarget(path.join(repo, 'nope'))).status, 'not-a-repo');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadTargets prefers explicit paths and rejects a non-array config', async () => {
  assert.equal((await loadTargets(['--apply', 'a'], 'unused')).length, 1);
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-cfg-'));
  try {
    const cfg = path.join(dir, 'c.json');
    await writeFile(cfg, '{}');
    await assert.rejects(loadTargets([], cfg), /JSON array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-layout requires every Claude plugin and sync file and passes when all are present', async () => {
  const source = await readFile('scripts/check-layout.mjs', 'utf8');
  const required = [...source.slice(source.indexOf('const required'), source.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const mustBeListed = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'commands/review.md', 'scripts/sync-targets.mjs'];
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-layout-'));
  try {
    for (const file of required) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), await readFile(file));
    }
    await mkdir(path.join(dir, '.omp', 'review-kit'), { recursive: true });
    await writeFile(path.join(dir, '.omp', 'review-kit', 'run-review.mjs'), await readFile('scripts/run-review.mjs'));
    const check = () => spawnSync(process.execPath, [path.resolve('scripts/check-layout.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(check().status, 0, check().stderr);
    for (const file of mustBeListed) {
      assert.ok(required.includes(file), `${file} missing from required`);
      const copy = await readFile(path.join(dir, file));
      await rm(path.join(dir, file));
      assert.notEqual(check().status, 0, `${file} absent must fail layout check`);
      await writeFile(path.join(dir, file), copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sync-targets CLI prints the drift table with the apply hint and exits 1, then 0 after --apply', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-sync-cli-'));
  try {
    await mkdir(path.join(repo, '.git'));
    await mkdir(path.join(repo, '.omp', 'review-kit'), { recursive: true });
    await writeFile(path.join(repo, '.omp', 'review-kit', 'run-review.mjs'), 'stale');
    const run = (...args) => spawnSync(process.execPath, ['scripts/sync-targets.mjs', ...args, repo], { encoding: 'utf8' });

    const dry = run();
    assert.equal(dry.status, 1, dry.stderr);
    assert.match(dry.stdout, /drift\s+.*run-review\.mjs:stale/);
    assert.match(dry.stdout, /--apply/);

    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /synced/);
    assert.equal(await readFile(path.join(repo, '.githooks', 'pre-commit'), 'utf8'), await readFile('templates/githooks/pre-commit', 'utf8'));
    assert.equal(run().status, 0);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(repo, '.githooks', 'pre-commit'))).mode & 0o111, 0o111);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('package.json files allowlist ships every Claude plugin runtime path', async () => {
  const pkg = await json('package.json');
  for (const entry of ['.claude-plugin', 'commands', 'scripts']) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`);
    await readFile(path.join(entry, entry === 'commands' ? 'review.md' : entry === 'scripts' ? 'run-review.mjs' : 'plugin.json'));
  }
  assert.ok(!pkg.files.includes('hooks'));
});

test('review command runs the shipped runner through the plugin root', async () => {
  assert.match(await readFile('commands/review.md', 'utf8'), /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/run-review\.mjs/);
});
