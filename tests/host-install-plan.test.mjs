// The install plan and the OpenCode config editing: what the installer decides, and what it writes
// into a JSONC file that a user may have hand-edited.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  INSTALL_MANIFEST,
  installRecord,
  opencodeConfigDir,
  planHostInstall,
  readPluginArray,
  writePluginArray,
  writePluginItems,
} from '../src/domain/host-install-plan.mjs';
import { applyOpenCode, copyComponents, openCodeConfigFile } from '../scripts/host-install.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

/** The document, or null when the text is not valid JSON — a corrupt config must fail an assertion, not throw. */
function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

test('Given a config directory, When it is resolved, Then OPENCODE_CONFIG_DIR wins over XDG over the home default', () => {
  assert.equal(opencodeConfigDir({ OPENCODE_CONFIG_DIR: '/custom' }, '/home/u'), '/custom');
  assert.equal(opencodeConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), path.join('/xdg', 'opencode'));
  assert.equal(opencodeConfigDir({}, '/home/u'), path.join('/home/u', '.config', 'opencode'));
});

test('Given a JSONC file with a commented plugin array, When the array is read, Then comments are not entries', () => {
  const text = `{
  // my plugins
  "plugin": [
    "other-plugin",
    // a comment between entries
    "omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git"
  ],
  "model": "x"
}`;
  const read = readPluginArray(text);
  assert.equal(read.present, true);
  assert.deepEqual(read.entries, ['other-plugin', 'omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git']);
});

test('Given a file without a plugin array, When the array is written, Then the rest of the file survives and the JSON stays valid', () => {
  const written = writePluginArray('{\n  "$schema": "https://opencode.ai/config.json"\n}\n', ['one']);
  const parsed = JSON.parse(written);
  assert.deepEqual(parsed.plugin, ['one']);
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
});

test('Given an existing array with comments, When it is rewritten, Then only the array changes', () => {
  const text = '{\n  // keep me\n  "plugin": ["old"],\n  "theme": "dark"\n}\n';
  const written = writePluginArray(text, ['new']);
  assert.match(written, /keep me/);
  assert.match(written, /"theme": "dark"/);
  assert.match(written, /"plugin": \[\n    "new"\n  \]/);
});

test('Given an entry already present, When the installer plans without force, Then it reports the same array and no change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-'));
  try {
    const configDir = path.join(root, 'opencode');
    await mkdir(configDir, { recursive: true });
    const entry = 'omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git';
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: [entry] }, null, 2), 'utf8');
    const result = await applyOpenCode({ apply: false, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    assert.equal(result.changed.length, 0);
    assert.equal(result.entry, entry);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a dry run, Then nothing on disk changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-'));
  try {
    const configDir = path.join(root, 'opencode');
    await applyOpenCode({ apply: false, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    const file = await openCodeConfigFile(configDir);
    assert.equal(file.exists, false);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an apply, Then the plugin entry and the copied components are recorded, and a remove deletes exactly those', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-'));
  try {
    const configDir = path.join(root, 'opencode');
    const installed = await applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    assert.ok(installed.changed.length > 0);
    const config = parseOrNull(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.ok(config, 'the config stays valid JSON');
    assert.equal(config.plugin.length, 1);
    assert.match(config.plugin[0], /omp-reviewer-kit@git\+https/);
    const manifest = JSON.parse(await readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8'));
    assert.ok(manifest.files.length > 0, 'the copied components are recorded');

    const removed = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    assert.ok(removed.changed.length > 0);
    const after = parseOrNull(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.ok(after, 'the config stays valid JSON after removal');
    assert.deepEqual(after.plugin ?? [], []);
    await assert.rejects(readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a kit root with no component directories, When the components are copied, Then nothing is invented', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-'));
  try {
    const emptyKit = path.join(root, 'kit');
    await mkdir(emptyKit, { recursive: true });
    const { copied, conflicts } = await copyComponents({ configDir: path.join(root, 'config'), kitRoot: emptyKit });
    assert.deepEqual(copied, []);
    assert.deepEqual(conflicts, []);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a host that installs itself, When the plan is built, Then it reports the host commands and no file step', () => {
  for (const host of ['omp', 'claude', 'codex']) {
    const plan = planHostInstall({ host, version: '1.0.0', action: 'report', kitRoot: '/kit' });
    assert.equal(plan.steps.every(step => step.kind === 'report'), true, `${host} is not installed by the kit`);
    assert.ok(plan.steps.some(step => step.detail.includes('marketplace add')), `${host} names its marketplace command`);
  }
});

test('Given a duplicate install mode, When the plan is built, Then it is blocked and the blocker is carried', () => {
  const plan = planHostInstall({
    host: 'opencode',
    version: '1.0.0',
    action: 'install',
    kitRoot: '/kit',
    configDir: '/config',
    findings: [{ code: 'duplicate-install-mode', message: 'two modes' }],
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.blockers.length, 1);
});

test('Given tuple options in the plugin array, When the entries are read, Then option strings are not plugin names', () => {
  const text = JSON.stringify({ plugin: ['plain-plugin', ['tuple-plugin', { option: 'value', nested: ['a', 'b'] }]] });
  const read = readPluginArray(text);
  assert.deepEqual(read.entries, ['plain-plugin', 'tuple-plugin']);
});

test('Given a JSONC comment containing a bracket, When the plugin array is read, Then the comment does not end it early', () => {
  const text = '{\n  "plugin": [\n    // a comment with ] and [ inside\n    "one",\n    "two"\n  ],\n  "theme": "dark"\n}\n';
  const read = readPluginArray(text);
  assert.deepEqual(read.entries, ['one', 'two']);
});

test('Given a config with a tuple plugin, When the kit is installed and removed, Then the tuple keeps its options', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-tuple-'));
  try {
    const configDir = path.join(root, 'oc');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: [['tuple-plugin', { option: 'value' }]] }, null, 2), 'utf8');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    await applyOpenCode({ apply: true, remove: false, force: true, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    const installedDoc = parseOrNull(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.ok(installedDoc, 'the config stays valid JSON');
    const installed = installedDoc.plugin;
    assert.deepEqual(installed[0], ['tuple-plugin', { option: 'value' }], 'the tuple and its options survive');
    await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    const removedDoc = parseOrNull(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.ok(removedDoc, 'the config stays valid JSON');
    const removed = removedDoc.plugin;
    assert.deepEqual(removed, [['tuple-plugin', { option: 'value' }]]);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a plugin array whose comment holds a bracket, When the array is rewritten, Then the file stays valid and the comment does not truncate it', () => {
  const text = '{\n  "plugin": [\n    // keep ] this plugin\n    "one"\n  ],\n  "theme": "dark"\n}\n';
  const written = writePluginItems(text, ['"one"', '"two"']);
  assert.match(written, /"theme": "dark"/);
  assert.match(written, /"two"/);
  assert.ok(parseOrNull(written), 'the rewritten file is valid JSON');
  const entries = readPluginArray(written).entries;
  assert.deepEqual(entries, ['one', 'two']);
});

test('Given a JSONC file with a commented plugin example before the active one, When the array is read, Then the active array is the one reported', () => {
  const text = '{\n  // "plugin": ["example"]\n  "plugin": ["existing"],\n  "theme": "dark"\n}\n';
  const read = readPluginArray(text);
  assert.deepEqual(read.entries, ['existing']);
});

test('Given a JSONC file with a commented plugin example before the active array, When the array is rewritten, Then the active one is replaced and the config stays valid', () => {
  const text = '{\n  // "plugin": ["example"]\n  "plugin": ["existing"],\n  "theme": "dark"\n}\n';
  const written = writePluginItems(text, ['"existing"', '"omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git"']);
  assert.match(written, /\/\/ "plugin": \["example"\]/, 'the comment survives');
  assert.match(written, /"theme": "dark"/, 'the rest of the file survives');
  assert.equal(readPluginArray(written).entries.length, 2, 'the active array holds the existing entry and the kit');
  assert.equal(written.includes('["existing"]'), false, 'the old active array was replaced');
});

test('Given a version and files, When the install record is built, Then it is deduplicated and sorted', () => {
  const record = installRecord({ version: '1.2.3', files: ['b', 'a', 'b'] });
  assert.deepEqual(record, { version: '1.2.3', files: ['a', 'b'] });
});
