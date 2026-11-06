import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectOmp } from '../scripts/host-doctor.mjs';

const KIT = 'omp-reviewer-kit';
const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'host-doctor-link-'));
  t.after(() => rm(root, REMOVE));
  const pluginRoot = path.join(root, '.omp', 'plugins');
  await mkdir(path.join(pluginRoot, 'node_modules'), { recursive: true });
  return { root, pluginRoot };
}

async function writeRegistry(pluginRoot, records) {
  await writeFile(path.join(pluginRoot, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { [`${KIT}@${KIT}`]: records },
  }), 'utf8');
}

test('Given a marketplace package exposed through a runtime link, When OMP is inspected, Then it is one marketplace installation', async t => {
  const { root, pluginRoot } = await fixture(t);
  const installed = path.join(pluginRoot, 'cache', 'kit');
  await mkdir(installed, { recursive: true });
  await symlink(installed, path.join(pluginRoot, 'node_modules', KIT), process.platform === 'win32' ? 'junction' : 'dir');
  await writeRegistry(pluginRoot, [
    { scope: 'user', installPath: 123, version: '1.2.3' },
    { scope: 'user', installPath: path.join(pluginRoot, 'missing') },
    { scope: 'user', installPath: installed },
  ]);
  const omp = await inspectOmp({ home: root });
  assert.equal(omp.installed, true);
  assert.equal(omp.mode, 'marketplace');
  assert.equal(omp.version, '1.2.3');
  assert.equal(omp.findings.some(finding => finding.code === 'duplicate-install-mode'), false);
});

test('Given malformed marketplace records, When OMP is inspected, Then a possible duplicate is reported', async t => {
  const { root, pluginRoot } = await fixture(t);
  await mkdir(path.join(pluginRoot, 'node_modules', KIT), { recursive: true });
  for (const records of [null, {}]) {
    await writeRegistry(pluginRoot, records);
    const omp = await inspectOmp({ home: root });
    assert.equal(omp.mode, 'npm');
    assert.equal(omp.findings.some(finding => finding.code === 'duplicate-install-mode'), true);
  }
});

test('Given a non-string marketplace path, When OMP is inspected, Then it remains a possible duplicate', async t => {
  const { root, pluginRoot } = await fixture(t);
  await mkdir(path.join(pluginRoot, 'node_modules', KIT), { recursive: true });
  await writeRegistry(pluginRoot, [{ installPath: 123 }]);
  const omp = await inspectOmp({ home: root });
  assert.equal(omp.mode, 'npm');
  assert.equal(omp.findings.some(finding => finding.code === 'duplicate-install-mode'), true);
});

test('Given a runtime link and another distinct installation, When OMP is inspected, Then the conflict is reported in either order', async t => {
  const { root, pluginRoot } = await fixture(t);
  const linked = path.join(pluginRoot, 'cache', 'linked');
  const other = path.join(pluginRoot, 'cache', 'other');
  await mkdir(linked, { recursive: true });
  await mkdir(other, { recursive: true });
  await symlink(linked, path.join(pluginRoot, 'node_modules', KIT), process.platform === 'win32' ? 'junction' : 'dir');
  for (const paths of [[linked, other], [other, linked]]) {
    await writeRegistry(pluginRoot, paths.map(installPath => ({ installPath })));
    const omp = await inspectOmp({ home: root });
    assert.equal(omp.mode, 'npm');
    assert.equal(omp.findings.some(finding => finding.code === 'duplicate-install-mode'), true);
  }
});
