import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const WRAPPER = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url));

test('Given a failing test file, When the test wrapper runs it, Then the wrapper fails, the child gets a throwaway runs directory, and that directory is removed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-wrapper-probe-'));
  try {
    const probeOut = path.join(dir, 'probe.txt');
    const probe = path.join(dir, 'probe.test.mjs');
    await writeFile(probe, [
      "import assert from 'node:assert/strict';",
      "import { writeFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('probe', () => {",
      '  writeFileSync(process.env.PROBE_OUT, process.env.OMP_REVIEW_KIT_RUNS_DIR ?? \'\');',
      "  assert.fail('deliberate failure');",
      '});',
    ].join('\n'), 'utf8');
    const env = { ...process.env, PROBE_OUT: probeOut };
    delete env.OMP_REVIEW_KIT_RUNS_DIR;

    const result = spawnSync(process.execPath, [WRAPPER, probe], { encoding: 'utf8', env, windowsHide: true });

    assert.notEqual(result.status, 0, 'a failing suite fails the wrapper');
    const runsDir = readFileSync(probeOut, 'utf8');
    assert.match(path.basename(runsDir), /^omp-test-runs-/, 'the child runs with a throwaway runs directory');
    assert.equal(existsSync(runsDir), false, 'the throwaway directory is removed afterwards');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the package test script, When it is read, Then it runs through the wrapper', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
});

test('Given a test marker inherited from an outer test run, When the wrapper runs a failing suite, Then the wrapper still fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-wrapper-marker-'));
  try {
    const probe = path.join(dir, 'probe.test.mjs');
    await writeFile(probe, [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "test('probe', () => assert.fail('deliberate failure'));",
    ].join('\n'), 'utf8');
    const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };

    const result = spawnSync(process.execPath, [WRAPPER, probe], { encoding: 'utf8', env, windowsHide: true });

    assert.notEqual(result.status, 0, 'a failing suite fails the wrapper even under an inherited test marker');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
