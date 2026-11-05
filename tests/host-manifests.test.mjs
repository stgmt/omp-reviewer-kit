// The generated host manifests: one version, four hosts, and a check that fails when a file drifts.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyHostManifests, checkHostManifests } from '../scripts/sync-host-manifests.mjs';
import {
  buildClaudeMarketplace,
  buildClaudePluginManifest,
  buildCodexHooks,
  buildCodexMarketplace,
  buildCodexPluginManifest,
  buildOmpMarketplace,
  generatedHostFiles,
} from '../src/domain/host-manifests.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

test('Given one version, When every manifest is built, Then each carries that version and the name the host reads', () => {
  const version = '9.9.9';
  assert.equal(buildOmpMarketplace(version).plugins[0].version, version);
  assert.equal(buildClaudeMarketplace(version).plugins[0].version, version);
  assert.equal(buildClaudePluginManifest(version).version, version);
  assert.equal(buildCodexPluginManifest(version).version, version);
  assert.equal(buildCodexMarketplace(version).plugins[0].version, version);
  for (const manifest of [buildOmpMarketplace(version), buildClaudeMarketplace(version), buildClaudePluginManifest(version), buildCodexPluginManifest(version), buildCodexMarketplace(version)]) {
    assert.equal(manifest.name, 'omp-reviewer-kit');
  }
});

test('Given the Claude catalogue, When it is built, Then the entry points at the shell and Codex gets its own native catalogue at the root', () => {
  assert.equal(buildClaudeMarketplace('1.0.0').plugins[0].source, './claude-plugin');
  assert.equal(buildCodexMarketplace('1.0.0').plugins[0].source.url, './');
  assert.equal(buildCodexPluginManifest('1.0.0').skills, './skills');
});

test('Given the Codex hooks file, When it is built, Then it guards the shell tool through the shared guard script', () => {
  const hooks = buildCodexHooks();
  const handler = hooks.hooks.PreToolUse[0];
  assert.equal(handler.matcher, '^Bash$');
  assert.match(handler.hooks[0].command, /scripts\/hook-guard\.mjs/);
  assert.equal(handler.hooks[0].type, 'command');
});

test('Given the generated files, When the version changes, Then every file that carries a version is regenerated', () => {
  const files = generatedHostFiles({ version: '2.0.0' });
  const versioned = files.filter(file => file.content.includes('"version"'));
  assert.equal(versioned.length, 5, 'five manifests carry a version; the hooks file does not');
  for (const file of versioned) assert.match(file.content, /"version": "2\.0\.0"/);
});

test('Given a checkout whose manifests are current, When the check runs, Then nothing is stale', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-manifests-'));
  try {
    await applyHostManifests({ root, version: '3.1.4' });
    const rows = await checkHostManifests({ root, version: '3.1.4' });
    assert.deepEqual(rows.map(row => row.status), ['current', 'current', 'current', 'current', 'current', 'current']);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a version bump without regeneration, When the check runs, Then the stale files are named', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-manifests-'));
  try {
    await applyHostManifests({ root, version: '3.1.4' });
    const rows = await checkHostManifests({ root, version: '3.1.5' });
    assert.ok(rows.some(row => row.status === 'stale'));
    assert.ok(rows.every(row => row.status !== 'missing'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a missing manifest, When the check runs, Then it is reported as missing rather than current', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-manifests-'));
  try {
    const rows = await checkHostManifests({ root, version: '1.0.0' });
    assert.ok(rows.every(row => row.status === 'missing'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a checkout with CRLF manifests, When the check runs, Then the line ending is not a difference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-manifests-'));
  try {
    await applyHostManifests({ root, version: '4.0.0' });
    const file = path.join(root, '.codex-plugin/plugin.json');
    const crlf = (await readFile(file, 'utf8')).replace(/\n/g, '\r\n');
    await writeFile(file, crlf, 'utf8');
    const rows = await checkHostManifests({ root, version: '4.0.0' });
    assert.equal(rows.find(row => row.path === '.codex-plugin/plugin.json').status, 'current');
  } finally {
    await rm(root, REMOVE);
  }
});
