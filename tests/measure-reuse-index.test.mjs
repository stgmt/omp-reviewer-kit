// The measurement command as a user runs it: a valid fixture repository reports the three known
// copies as matches and the unrelated function as no match, and a path typo fails instead of
// printing plausible zero-file numbers.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
const SCRIPT = path.join(process.cwd(), 'scripts', 'measure-reuse-index.mjs');

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

test('Given a fixture repository, When the measurement runs, Then the known copies match and the unrelated function does not', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'measure-reuse-'));
  try {
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'place.mjs'), 'export const place = 1;\n', 'utf8');
    const result = run(['--repo', repo, '--json'], repo);
    assert.equal(result.status, 0, result.stderr);
    const measured = JSON.parse(result.stdout);
    assert.equal(measured.synthetic.length, 4);
    const copyCases = measured.synthetic.filter(entry => entry.expected === 'match');
    assert.deepEqual(copyCases.map(entry => entry.found), ['match', 'match', 'match']);
    assert.equal(measured.synthetic.find(entry => entry.expected === 'no match').found, 'no match');
    assert.equal(measured.repository.files >= 1, true, 'the fixture repository was actually scanned');
  } finally {
    await rm(repo, REMOVE);
  }
});

test('Given a path that does not exist, When the measurement runs, Then it fails instead of reporting zero files', async () => {
  const missing = path.join(os.tmpdir(), `measure-reuse-missing-${process.pid}-${Date.now()}`);
  const result = run(['--repo', missing, '--json'], os.tmpdir());
  assert.equal(result.status, 2, 'a typos is a usage error, not an empty measurement');
  assert.match(result.stderr, /cannot read/);
  assert.equal(result.stdout.includes('"repository"'), false, 'nothing is printed as a result');
});

test('Given no --repo value, When the measurement runs, Then it refuses before scanning anything', () => {
  const result = run(['--repo'], os.tmpdir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--repo needs a directory/);
});

test('Given a regular file as the target, When the measurement runs, Then the diagnostic names the file the user supplied', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'measure-reuse-file-'));
  try {
    const file = path.join(dir, 'not-a-directory.mjs');
    await writeFile(file, 'export const a = 1;\n', 'utf8');
    const result = run(['--repo', file, '--json'], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot read/);
    assert.equal(result.stderr.includes(file), true, 'the message names the target that failed, not another path');
  } finally {
    await rm(dir, REMOVE);
  }
});
