// Runs the test suite (`npm test`) with review run records kept in a throwaway
// folder, so test runs never add records to the per-user runs directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runsDir = mkdtempSync(path.join(tmpdir(), 'omp-test-runs-'));
const env = { ...process.env, OMP_REVIEW_KIT_RUNS_DIR: runsDir };
// Set by an outer test run; a runner that inherits it exits 0 even when a test fails.
delete env.NODE_TEST_CONTEXT;
try {
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(runsDir, { recursive: true, force: true });
}
