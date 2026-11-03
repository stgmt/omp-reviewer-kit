// Given/When/Then over the delivery command: which host is updated, which is skipped because it is not
// installed, and which is a failure because it is installed and did not answer. No real host is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { deliver, probe } from '../scripts/deliver.mjs';

const TEMPLATE = await readFile('templates/githooks/pre-commit', 'utf8');
const FORMAT_MARKER = TEMPLATE.split('\n')[1];
const LEGACY_TEMPLATE = `#!/bin/sh\n# omp-reviewer-kit hook v0.26.3 body-sha256:${'a'.repeat(64)}\nset -eu\n`;

/** A CLI table: command+args key to either stdout or a failure. */
const execFrom = (table) => (command, args) => {
  const key = [command, ...args].join(' ');
  const entry = table[key];
  if (entry === undefined) {
    const error = new Error(`ENOENT: ${key}`);
    error.code = 'ENOENT';
    throw error;
  }
  if (entry instanceof Error) throw entry;
  return entry;
};

const byHost = results => Object.fromEntries(results.map(result => [result.host, result]));

test('Given every host installed and current, When delivery runs, Then all three checks pass', () => {
  const exec = execFrom({
    'omp --version': 'omp/18.14.1',
    'omp plugin upgrade omp-reviewer-kit': 'omp-reviewer-kit is up to date',
    'omp plugin list': '  omp-reviewer-kit@0.28.0',
    'claude --version': '2.0.0',
    'claude plugin update omp-reviewer-kit@omp-reviewer-kit': 'Plugin omp-reviewer-kit updated from 0.26.4 to 0.28.0',
  });
  const results = deliver({ version: '0.28.0', template: TEMPLATE, execFile: exec });
  const hosts = byHost(results);
  assert.equal(hosts.OMP.ok, true);
  assert.match(hosts.OMP.detail, /0\.28\.0/);
  assert.equal(hosts['Claude Code'].ok, true);
  assert.equal(hosts['repository hooks'].ok, true);
  assert.match(hosts['repository hooks'].detail, /format only/);
});

test('Given OMP is not installed at all, When delivery runs, Then it is skipped instead of failing', () => {
  const results = byHost(deliver({ version: '0.28.0', template: TEMPLATE, execFile: execFrom({}) }));
  assert.equal(results.OMP.ok, true);
  assert.match(results.OMP.detail, /not installed/);
});

test('Given OMP is installed but does not answer, When delivery runs, Then delivery fails instead of skipping', () => {
  const broken = new Error('exit 1');
  broken.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const results = byHost(deliver({ version: '0.28.0', template: TEMPLATE, execFile: execFrom({ 'omp --version': broken }) }));
  assert.equal(results.OMP.ok, false);
  assert.match(results.OMP.detail, /installed but not answering/);
});

test('Given Claude Code is installed but does not answer, When delivery runs, Then delivery fails instead of skipping', () => {
  const broken = new Error('boom');
  broken.code = 'EACCES';
  const results = byHost(deliver({
    version: '0.28.0',
    template: TEMPLATE,
    execFile: execFrom({ 'claude --version': broken }),
  }));
  assert.equal(results['Claude Code'].ok, false);
});

test('Given the shipped hook still names a release, When delivery runs, Then the invariant check fails', () => {
  const results = byHost(deliver({ version: '0.28.0', template: LEGACY_TEMPLATE, execFile: execFrom({}) }));
  assert.equal(results['repository hooks'].ok, false, 'any release marker fails, not just the current one');
});

test('Given the installed kit is not the delivered version, When delivery runs, Then OMP is reported as not current', () => {
  const exec = execFrom({
    'omp --version': 'omp/18.14.1',
    'omp plugin upgrade omp-reviewer-kit': 'omp-reviewer-kit is up to date (0.26.4)',
    'omp plugin list': '  omp-reviewer-kit@0.26.4',
  });
  const results = byHost(deliver({ version: '0.28.0', template: TEMPLATE, execFile: exec }));
  assert.equal(results.OMP.ok, false);
});

test('Given an executable that reports a missing binary, When it is probed, Then the state is absent rather than failed', () => {
  const missing = () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; };
  const failing = () => { const error = new Error('exit 2'); throw error; };
  assert.equal(probe(missing, 'omp', ['--version']).state, 'absent');
  assert.equal(probe(failing, 'omp', ['--version']).state, 'failed');
  assert.equal(probe(() => 'ok\n', 'omp', ['--version']).state, 'ok');
});

test('Given the shipped hook, When its marker is read, Then it is the format marker the delivery check expects', () => {
  assert.match(FORMAT_MARKER, /^# omp-reviewer-kit hook-format v\d+ body-sha256:/);
  assert.doesNotMatch(FORMAT_MARKER, /\bhook v\d+\.\d+\.\d+/);
});

test('Given the delivery CLI runs where the shipped hook names a release, When it finishes, Then it exits nonzero', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const path = (await import('node:path')).default;
  const root = await mkdtemp(path.join(tmpdir(), 'deliver-cli-'));
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'templates', 'githooks'), { recursive: true });
    await copyFile('scripts/deliver.mjs', path.join(root, 'scripts', 'deliver.mjs'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.28.0' }));
    await writeFile(path.join(root, 'templates', 'githooks', 'pre-commit'), LEGACY_TEMPLATE);
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'deliver.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'a release marker in the shipped hook fails delivery');
    assert.match(run.stdout, /FAIL repository hooks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the delivery CLI runs with the format marker and no hosts installed, When it finishes, Then it exits zero', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const path = (await import('node:path')).default;
  const root = await mkdtemp(path.join(tmpdir(), 'deliver-cli-'));
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'templates', 'githooks'), { recursive: true });
    await copyFile('scripts/deliver.mjs', path.join(root, 'scripts', 'deliver.mjs'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.28.0' }));
    await writeFile(path.join(root, 'templates', 'githooks', 'pre-commit'), TEMPLATE);
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'deliver.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: path.join(root, 'empty-bin') },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
