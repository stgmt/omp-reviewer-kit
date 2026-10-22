// Runs the test suite (`npm test`) with review run records, the target registry and review reports
// kept in a throwaway folder, so test runs never add records to the per-user runs directory, heal and
// register the user's repositories, or write reports into the user's Documents folder.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runsDir = mkdtempSync(path.join(tmpdir(), 'omp-test-runs-'));
const env = {
  ...process.env,
  OMP_REVIEW_KIT_RUNS_DIR: runsDir,
  OMP_REVIEW_KIT_TARGETS: path.join(runsDir, 'review-kit-targets.json'),
  OMP_REVIEW_KIT_REPORTS_DIR: path.join(runsDir, 'reports'),
};
// Set by an outer test run; a runner that inherits it exits 0 even when a test fails.
delete env.NODE_TEST_CONTEXT;
try {
  const requested = process.argv.slice(2);
  const suites = requested.length > 0 ? requested : readdirSync('tests').filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join('tests', name));
  const result = spawnSync(process.execPath, ['--test', ...suites], {
    stdio: 'inherit',
    env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(runsDir, { recursive: true, force: true });
}
