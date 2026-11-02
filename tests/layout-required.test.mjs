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
