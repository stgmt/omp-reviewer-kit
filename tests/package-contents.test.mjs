// What the published package actually carries. A Git install reads the package's own `files` list, so
// a host entry point that is not listed is silently absent on a fresh machine even though this
// checkout works. The lockfile has to agree with the manifest pin for the same reason: the first
// review installs the locked runtime from these bytes.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The npm CLI that ships with the running Node, so the pack report is npm's own answer. */
function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find(candidate => candidate.endsWith('npm-cli.js') && existsSync(candidate)) ?? null;
}

const REQUIRED_HOST_ENTRIES = [
  'opencode/plugin.mjs',
  'opencode/agents/reviewer-kit.md',
  'opencode/commands/review.md',
  'claude-plugin/scripts/bridge.mjs',
  'claude-plugin/.claude-plugin/plugin.json',
  'package.json',
  'bun.lock',
];
const ZOD_PIN = '4.1.8';

test('Given the package is packed, When its file list is read, Then every host entry point and the lockfile are included', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const npmCli = npmCliPath();
  assert.ok(npmCli, 'the npm CLI that ships with Node is available');
  const { stdout } = await run(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const [report] = JSON.parse(stdout);
  const shipped = new Set(report.files.map(file => file.path));
  for (const required of REQUIRED_HOST_ENTRIES) {
    assert.ok(shipped.has(required), `${required} is in the published package`);
  }
  assert.ok([...shipped].some(file => file.startsWith('src/native/')), 'the review algorithm ships');
  assert.equal(pkg.dependencies.zod, ZOD_PIN, 'the Git tool imports a pinned direct dependency');
  assert.equal(pkg.exports['./server'], './opencode/plugin.mjs', 'OpenCode resolves the server export');
});

test('Given the lockfile, When its Zod entries are read, Then the workspace pin and the resolved package match the manifest', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = (await readFile(path.join(ROOT, 'bun.lock'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(lock, new RegExp(`^\\s*"zod": "${pkg.dependencies.zod.replaceAll('.', '\\.')}",$`, 'm'), 'the workspace pin in the lock matches package.json');
  assert.match(lock, new RegExp(`^\\s*"zod": \\["zod@${pkg.dependencies.zod.replaceAll('.', '\\.')}",`, 'm'), 'the resolved Zod package matches the pin');
});
