// The host doctor: what it reports about a machine, and the one state it refuses to bless.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { activeToml, inspectClaude, inspectCodex, inspectOmp, inspectOpenCode, inspectHosts, renderHostReport } from '../scripts/host-doctor.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
const KIT = 'omp-reviewer-kit';

async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-doctor-'));
  return root;
}

test('Given no OMP state, When the host is inspected, Then it is absent and its paths are still listed', async () => {
  const root = await home();
  try {
    const omp = await inspectOmp({ home: root });
    assert.equal(omp.installed, false);
    assert.equal(omp.mode, 'absent');
    assert.ok(omp.paths.every(value => typeof value === 'string' && value.length > 0));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given the npm form and a marketplace registration, When OMP is inspected, Then two install modes are reported as a conflict', async () => {
  const root = await home();
  try {
    await mkdir(path.join(root, '.omp', 'plugins', 'node_modules', KIT), { recursive: true });
    await writeFile(path.join(root, '.omp', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { [`${KIT}@${KIT}`]: [{ scope: 'user', installPath: path.join(root, 'cache', 'x'), version: '1.2.3' }] },
    }), 'utf8');
    const omp = await inspectOmp({ home: root });
    assert.equal(omp.mode, 'npm');
    assert.ok(omp.findings.some(finding => finding.code === 'duplicate-install-mode'));
    assert.match(omp.findings.find(finding => finding.code === 'duplicate-install-mode').message, /omp plugin uninstall/);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a marketplace pointing at a local checkout, When OMP is inspected, Then the local source is named', async () => {
  const root = await home();
  try {
    await mkdir(path.join(root, '.omp'), { recursive: true });
    await writeFile(path.join(root, '.omp', 'marketplaces.json'), JSON.stringify({
      version: 1,
      marketplaces: [{ name: KIT, sourceType: 'local', sourceUri: 'E:/repos/omp-reviewer-kit' }],
    }), 'utf8');
    const omp = await inspectOmp({ home: root });
    assert.match(omp.marketplaceSource, /^local:/);
    assert.ok(omp.findings.some(finding => finding.code === 'local-marketplace'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an enabled Claude plugin, When Claude is inspected, Then its version comes from the registry', async () => {
  const root = await home();
  try {
    await mkdir(path.join(root, '.claude', 'plugins'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [`${KIT}@${KIT}`]: true } }), 'utf8');
    await writeFile(path.join(root, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { [`${KIT}@${KIT}`]: [{ version: '0.26.4', installPath: 'x' }] },
    }), 'utf8');
    const claude = await inspectClaude({ home: root });
    assert.equal(claude.installed, true);
    assert.equal(claude.version, '0.26.4');
    assert.equal(claude.mode, 'marketplace');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a Codex config with the marketplace and an enabled plugin, When Codex is inspected, Then it is installed', async () => {
  const root = await home();
  try {
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'config.toml'), `[marketplaces.${KIT}]\nsource_type = "git"\nsource = "https://github.com/stgmt/omp-reviewer-kit.git"\n\n[plugins."${KIT}@${KIT}"]\nenabled = true\n`, 'utf8');
    const codex = await inspectCodex({ home: root });
    assert.equal(codex.installed, true);
    assert.equal(codex.mode, 'marketplace');
    assert.deepEqual(codex.findings, []);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a Codex config that only disables the plugin, When Codex is inspected, Then it is not installed', async () => {
  const root = await home();
  try {
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'config.toml'), `[plugins."${KIT}@${KIT}"]\nenabled = false\n`, 'utf8');
    const codex = await inspectCodex({ home: root });
    assert.equal(codex.installed, false);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an OpenCode config with the kit entry, When OpenCode is inspected, Then the manifest version is reported', async () => {
  const root = await home();
  try {
    const configDir = path.join(root, 'oc');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: [`${KIT}@git+https://github.com/stgmt/omp-reviewer-kit.git`] }), 'utf8');
    await writeFile(path.join(configDir, '.omp-reviewer-kit-manifest.json'), JSON.stringify({ version: '5.6.7', files: [] }), 'utf8');
    const opencode = await inspectOpenCode({ env: { OPENCODE_CONFIG_DIR: configDir }, home: root });
    assert.equal(opencode.installed, true);
    assert.equal(opencode.version, '5.6.7');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given any machine, When all hosts are inspected, Then one row per host is rendered with its mode', async () => {
  const root = await home();
  try {
    const hosts = await inspectHosts({ home: root, env: { OPENCODE_CONFIG_DIR: path.join(root, 'oc') } });
    assert.deepEqual(hosts.map(host => host.host), ['omp', 'claude', 'codex', 'opencode']);
    const lines = renderHostReport(hosts);
    assert.equal(lines.length >= hosts.length, true);
    for (const host of hosts) assert.ok(lines.some(line => line.startsWith(host.host)), `${host.host} renders`);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a Codex config where every entry is commented out, When Codex is inspected, Then it is not installed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'doctor-comments-'));
  try {
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'config.toml'), [
      '# [marketplaces.omp-reviewer-kit]',
      '# source_type = "git"',
      `# [plugins."${KIT}@${KIT}"]`,
      '# enabled = true',
      'notes = "value with a # inside is data"',
    ].join('\n'), 'utf8');
    const codex = await inspectCodex({ home: root });
    assert.equal(codex.installed, false);
    assert.equal(codex.mode, 'absent');
    assert.ok(codex.findings.some(finding => finding.code === 'absent'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given TOML with a hash inside a quoted value, When the comments are stripped, Then the value is kept', () => {
  assert.equal(activeToml('a = "x # y" # trailing\nb = 2 # note'), 'a = "x # y" \nb = 2 ');
});

test('Given two OMP install modes, When the doctor prints JSON, Then the conflict is in the report and the exit status is nonzero', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'doctor-json-'));
  try {
    await mkdir(path.join(root, '.omp', 'plugins', 'node_modules', KIT), { recursive: true });
    await writeFile(path.join(root, '.omp', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [`${KIT}@${KIT}`]: [{ scope: 'user', installPath: 'x', version: '1.0.0' }] } }), 'utf8');
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'host-doctor.mjs'), '--json'], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODE_CONFIG_DIR: path.join(root, 'oc') },
    });
    assert.equal(result.status, 1, 'a conflict is not healthy');
    const report = JSON.parse(result.stdout);
    const omp = report.hosts.find(host => host.host === 'omp');
    assert.ok(omp.findings.some(finding => finding.code === 'duplicate-install-mode'));
  } finally {
    await rm(root, REMOVE);
  }
});
