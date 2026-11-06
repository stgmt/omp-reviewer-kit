// The install plan and the OpenCode config editing: what the installer decides, and what it writes
// into a JSONC file that a user may have hand-edited.

import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
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

async function legacySkillRemovalFixture(root) {
  const kitRoot = path.join(root, 'kit');
  const configDir = path.join(root, 'opencode');
  const skillSource = path.join(kitRoot, 'skills', 'demo');
  const skillDestination = path.join(configDir, 'skills', 'demo');
  await mkdir(skillSource, { recursive: true });
  await mkdir(skillDestination, { recursive: true });
  await writeFile(path.join(kitRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  await writeFile(path.join(skillSource, 'SKILL.md'), 'kit skill\n', 'utf8');
  await writeFile(path.join(skillDestination, 'SKILL.md'), 'kit skill\n', 'utf8');
  await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: ['omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git'] }), 'utf8');
  await writeFile(path.join(configDir, INSTALL_MANIFEST), JSON.stringify({ version: '0.1.0', files: ['skills/demo'] }), 'utf8');
  return { kitRoot, configDir, skillSource, skillDestination };
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

test('Given an old OpenCode install, When the kit is upgraded, Then each release selects its own package without changing other plugins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-'));
  try {
    const kitRoot = path.join(root, 'kit');
    const configDir = path.join(root, 'opencode');
    await mkdir(kitRoot, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'opencode.json');
    const packagePath = path.join(kitRoot, 'package.json');
    const base = 'omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git';
    await writeFile(packagePath, JSON.stringify({ version: '1.0.0' }), 'utf8');
    await writeFile(configPath, JSON.stringify({ plugin: [['other-plugin', { enabled: true }], base] }), 'utf8');
    const options = { apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot };

    await applyOpenCode(options);
    let config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.plugin, [['other-plugin', { enabled: true }], `${base}#v1.0.0`]);

    await writeFile(packagePath, JSON.stringify({ version: '1.0.1' }), 'utf8');
    await applyOpenCode(options);
    config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.plugin, [['other-plugin', { enabled: true }], `${base}#v1.0.1`]);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a config that cannot be written, When the install fails, Then the copied assets stay recorded and a retry completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-fail-'));
  try {
    const kitRoot = path.join(root, 'kit');
    const configDir = path.join(root, 'opencode');
    await mkdir(path.join(kitRoot, 'opencode', 'agents'), { recursive: true });
    await writeFile(path.join(kitRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'kit-agent.md'), 'kit agent', 'utf8');
    const options = { apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot };
    const failing = async (file, data, encoding) => {
      if (file === path.join(configDir, 'opencode.json')) throw new Error('EACCES: the config is read-only');
      return writeFile(file, data, encoding);
    };

    await assert.rejects(applyOpenCode({ ...options, writeFileImpl: failing }), /EACCES/);
    const manifest = JSON.parse(await readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8'));
    assert.deepEqual(manifest.files.map(file => file.path), ['agents/kit-agent.md'], 'the copied asset is recorded, not stranded');

    const retried = await applyOpenCode(options);
    assert.deepEqual(retried.conflicts, [], 'the retry reads the recorded asset as kit-owned, not as a conflict');
    const config = JSON.parse(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.equal(config.plugin.length, 1, 'the retry enables the plugin');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a manifest that cannot be written, When the install fails, Then the files it created are removed and the plugin stays disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-fail-'));
  try {
    const kitRoot = path.join(root, 'kit');
    const configDir = path.join(root, 'opencode');
    await mkdir(path.join(kitRoot, 'opencode', 'agents'), { recursive: true });
    await writeFile(path.join(kitRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'kit-agent.md'), 'kit agent', 'utf8');
    const failing = async (file, data, encoding) => {
      if (file === path.join(configDir, INSTALL_MANIFEST)) throw new Error('ENOSPC: the manifest cannot be written');
      return writeFile(file, data, encoding);
    };

    await assert.rejects(
      applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot, writeFileImpl: failing }),
      /ENOSPC/,
    );
    await assert.rejects(readFile(path.join(configDir, 'agents', 'kit-agent.md'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(configDir, 'opencode.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an installed release, When an upgrade cannot record ownership, Then the replaced asset gets its previous bytes back and a retry proceeds', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-fail-'));
  try {
    const kitRoot = path.join(root, 'kit');
    const configDir = path.join(root, 'opencode');
    const agent = path.join(kitRoot, 'opencode', 'agents', 'kit-agent.md');
    await mkdir(path.dirname(agent), { recursive: true });
    await writeFile(path.join(kitRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    await writeFile(agent, 'kit agent version one', 'utf8');
    const options = { apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot };
    await applyOpenCode(options);
    const installed = JSON.parse(await readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8'));

    await writeFile(agent, 'kit agent version two', 'utf8');
    const failing = async (file, data, encoding) => {
      if (file === path.join(configDir, INSTALL_MANIFEST)) throw new Error('ENOSPC: the manifest cannot be written');
      return writeFile(file, data, encoding);
    };
    await assert.rejects(applyOpenCode({ ...options, writeFileImpl: failing }), /ENOSPC/);

    const restored = await readFile(path.join(configDir, 'agents', 'kit-agent.md'), 'utf8');
    assert.equal(restored, 'kit agent version one', 'the replaced asset is rolled back to the bytes the manifest names');
    assert.deepEqual(JSON.parse(await readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8')).files, installed.files, 'the recorded ownership still describes the files on disk');

    const retried = await applyOpenCode(options);
    assert.deepEqual(retried.conflicts, [], 'the retry reads the restored asset as kit-owned, not as a conflict');
    assert.equal(await readFile(path.join(configDir, 'agents', 'kit-agent.md'), 'utf8'), 'kit agent version two');
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

test('Given OpenCode installation, When it is removed, Then its configuration entry and unchanged agent are removed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-install-'));
  try {
    const configDir = path.join(root, 'opencode');
    await applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    const config = parseOrNull(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.ok(config, 'the config stays valid JSON');
    assert.equal(config.plugin.length, 1);
    assert.match(config.plugin[0], /omp-reviewer-kit@git\+https/);

    await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: process.cwd() });
    const after = parseOrNull(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
    assert.ok(after, 'the config stays valid JSON after removal');
    assert.deepEqual(after.plugin ?? [], []);
    await assert.rejects(readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(configDir, 'agents', 'reviewer-kit.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a user-edited agent, When an upgrade conflicts, Then no agent is replaced and removal preserves the edit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-upgrade-'));
  try {
    const kitRoot = path.join(root, 'kit');
    const configDir = path.join(root, 'opencode');
    await mkdir(path.join(kitRoot, 'opencode', 'agents'), { recursive: true });
    await mkdir(path.join(kitRoot, 'skills', 'demo'), { recursive: true });
    await writeFile(path.join(kitRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'managed.md'), 'kit version one', 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'edited.md'), 'kit original', 'utf8');
    await writeFile(path.join(kitRoot, 'skills', 'demo', 'SKILL.md'), 'skill one', 'utf8');
    await mkdir(path.join(configDir, 'agents'), { recursive: true });
    await writeFile(path.join(configDir, 'agents', 'foreign.md'), 'user file', 'utf8');

    await applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot });
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'managed.md'), 'kit version two', 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'edited.md'), 'kit version two', 'utf8');
    await writeFile(path.join(configDir, 'agents', 'edited.md'), 'user edit', 'utf8');
    const upgraded = await applyOpenCode({ apply: true, remove: false, force: true, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot });
    assert.equal(await readFile(path.join(configDir, 'agents', 'managed.md'), 'utf8'), 'kit version one');
    assert.equal(await readFile(path.join(configDir, 'agents', 'edited.md'), 'utf8'), 'user edit');
    assert.equal(await readFile(path.join(configDir, 'agents', 'foreign.md'), 'utf8'), 'user file');
    assert.ok(upgraded.conflicts.includes('agents/edited.md'));

    const removed = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot });
    assert.ok(removed.ignored.includes('agents/edited.md'), 'edited kit-owned bytes are preserved');
    await assert.rejects(readFile(path.join(configDir, 'agents', 'managed.md'), 'utf8'));
    assert.equal(await readFile(path.join(configDir, 'agents', 'edited.md'), 'utf8'), 'user edit');
    assert.equal(await readFile(path.join(configDir, 'agents', 'foreign.md'), 'utf8'), 'user file');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a legacy install manifest, Then unchanged old OpenCode copies upgrade to native assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-legacy-upgrade-'));
  try {
    const kitRoot = path.join(root, 'kit');
    const configDir = path.join(root, 'opencode');
    await mkdir(path.join(kitRoot, 'agents'), { recursive: true });
    await mkdir(path.join(kitRoot, 'claude-plugin', 'commands'), { recursive: true });
    await mkdir(path.join(kitRoot, 'opencode', 'agents'), { recursive: true });
    await mkdir(path.join(kitRoot, 'opencode', 'commands'), { recursive: true });
    await mkdir(path.join(configDir, 'agents'), { recursive: true });
    await mkdir(path.join(configDir, 'commands'), { recursive: true });
    await writeFile(path.join(kitRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }), 'utf8');
    await writeFile(path.join(kitRoot, 'agents', 'scout.md'), 'old OMP agent', 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'agents', 'scout.md'), '---\nmode: subagent\n---\nnative OpenCode agent', 'utf8');
    await writeFile(path.join(kitRoot, 'claude-plugin', 'commands', 'review.md'), 'old Claude command', 'utf8');
    await writeFile(path.join(kitRoot, 'opencode', 'commands', 'review.md'), '---\nagent: review-result\n---\nCall review_kit with operation: "review".', 'utf8');
    await writeFile(path.join(configDir, 'agents', 'scout.md'), 'old OMP agent', 'utf8');
    await writeFile(path.join(configDir, 'commands', 'review.md'), 'old Claude command', 'utf8');
    await writeFile(path.join(configDir, INSTALL_MANIFEST), JSON.stringify({ version: '1.0.0', files: ['agents/scout.md', 'commands/review.md'] }), 'utf8');

    await applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot });
    assert.equal(await readFile(path.join(configDir, 'agents', 'scout.md'), 'utf8'), '---\nmode: subagent\n---\nnative OpenCode agent');
    const command = await readFile(path.join(configDir, 'commands', 'review.md'), 'utf8');
    assert.match(command, /review_kit/);
    assert.doesNotMatch(command, /!\s*`|BRIDGE_SCRIPT|claude-plugin/);
    const manifest = JSON.parse(await readFile(path.join(configDir, INSTALL_MANIFEST), 'utf8'));
    assert.ok(manifest.files.some(file => file.path === 'agents/scout.md' && /^[a-f0-9]{64}$/.test(file.sha256)));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an exact legacy skill tree with an empty directory, When it is removed, Then the complete matching tree is deleted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-legacy-exact-tree-'));
  try {
    const fixture = await legacySkillRemovalFixture(root);
    await mkdir(path.join(fixture.skillSource, 'empty'), { recursive: true });
    await mkdir(path.join(fixture.skillDestination, 'empty'), { recursive: true });
    const result = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: fixture.configDir }, home: root, kitRoot: fixture.kitRoot });
    assert.ok(result.changed.includes('skills/demo'));
    await assert.rejects(lstat(fixture.skillDestination));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a user-added empty directory in a legacy skill tree, When it is removed, Then the tree is preserved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-legacy-empty-dir-'));
  try {
    const fixture = await legacySkillRemovalFixture(root);
    await mkdir(path.join(fixture.skillDestination, 'user-empty'), { recursive: true });
    const result = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: fixture.configDir }, home: root, kitRoot: fixture.kitRoot });
    assert.ok(result.ignored.includes('skills/demo'));
    assert.equal((await lstat(path.join(fixture.skillDestination, 'user-empty'))).isDirectory(), true);
    assert.equal(await readFile(path.join(fixture.skillDestination, 'SKILL.md'), 'utf8'), 'kit skill\n');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a user-added directory symlink in a legacy skill tree, When it is removed, Then the tree and target are preserved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-legacy-symlink-'));
  try {
    const fixture = await legacySkillRemovalFixture(root);
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'user.txt'), 'outside user data', 'utf8');
    const link = path.join(fixture.skillDestination, 'user-link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: fixture.configDir }, home: root, kitRoot: fixture.kitRoot });
    assert.ok(result.ignored.includes('skills/demo'));
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(outside, 'user.txt'), 'utf8'), 'outside user data');
    assert.equal(await readFile(path.join(fixture.skillDestination, 'SKILL.md'), 'utf8'), 'kit skill\n');
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
