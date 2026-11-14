// Given/When/Then over the required-file list that the layout check enforces: the check itself is
// the real function, the fixture is a temporary tree that mirrors the list, so a path dropped from
// the list or from the repository fails here instead of at the first read that follows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REQUIRED_FILES, assertRequiredFiles } from '../src/infra/layout-required.mjs';

// Paths a consumer imports or a command runs by name: dropping one of them from the list would let
// the layout check accept a tree that fails at the first import instead of at the check.
const PINNED_PATHS = [
  'src/infra/registration-record.mjs',
  'src/infra/repo-identity.mjs',
  'src/domain/report-envelope.mjs',
  'src/domain/diff-budget.mjs',
  'src/domain/review-run-summary.mjs',
  'src/infra/review-run-store.mjs',
  'src/native/review-telemetry.mjs',
  'scripts/review-runs.mjs',
  // The census and the Python side of the contract stage are imported by the review; a row dropped
  // from the list would surface as a runtime failure instead of a layout failure.
  'src/native/compat/config.mjs',
  'src/native/compat/extract.mjs',
  'src/native/compat/analyze.mjs',
  'src/native/compat/report.mjs',
  'src/native/contract/python.mjs',
  'src/native/contract/probe_python.py',
];

test('Given the repository, When every required file is checked, Then the list names every run-record path and nothing is missing', async () => {
  for (const file of PINNED_PATHS) assert.ok(REQUIRED_FILES.includes(file), `${file} is required`);
  await assertRequiredFiles(process.cwd(), REQUIRED_FILES);
});

for (const victim of PINNED_PATHS) {
  test(`Given a tree without ${victim}, When the required files are checked, Then the check fails naming that path`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'layout-required-'));
    try {
      for (const file of REQUIRED_FILES) {
        if (file === victim) continue;
        const absolute = path.join(root, file);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, '');
      }
      await assert.rejects(
        () => assertRequiredFiles(root, REQUIRED_FILES),
        new RegExp(`missing required file: ${victim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const victim of ['src/infra/ensure-review-runtime.mjs', 'bun.lock']) {
  test(`Given an installation missing ${victim}, When the layout is checked, Then it is rejected`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'layout-runtime-'));
    try {
      for (const file of REQUIRED_FILES) {
        if (file === victim) continue;
        const absolute = path.join(root, file);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, '');
      }
      await assert.rejects(() => assertRequiredFiles(root, REQUIRED_FILES), /missing required file/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
}

test('Given the native review imports the contract stage, When the layout is checked, Then all three contract modules are required and their absence is rejected', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  for (const file of ['src/native/contract/find.mjs', 'src/native/contract/analyze.mjs', 'src/native/contract/probe.mjs', 'scripts/deliver.mjs']) {
    assert.ok(REQUIRED_FILES.includes(file), `${file} is required`);
    const root = await mkdtemp(path.join(tmpdir(), 'layout-contract-'));
    try {
      // Everything present but the one file under test.
      for (const other of REQUIRED_FILES.filter(entry => entry !== file)) {
        await mkdir(path.dirname(path.join(root, other)), { recursive: true });
        await (await import('node:fs/promises')).writeFile(path.join(root, other), '// fixture\n');
      }
      await assert.rejects(() => assertRequiredFiles(root, REQUIRED_FILES), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
