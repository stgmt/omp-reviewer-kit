// omp-reviewer-kit runner stub
// Thin and fixed: this file is identical in every repository and never changes. The installer writes it from
// templates/review-kit/run-review.mjs. The review runs from the installed OMP plugin (or from the directory named by
// OMP_REVIEW_KIT_PLUGIN_DIR), so a kit update changes the algorithm without changing this file.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const pluginDir = process.env.OMP_REVIEW_KIT_PLUGIN_DIR
  || path.join(homedir(), '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit');
const algorithm = path.join(pluginDir, 'scripts', 'run-review.mjs');

if (!existsSync(algorithm)) {
  // Fail closed: without the plugin no review can run, so the commit is blocked.
  process.stderr.write(`reviewer-kit INFRA_ERROR: no omp-reviewer-kit plugin at ${pluginDir}. Install it with: omp plugin install github:stgmt/omp-reviewer-kit\n`);
  process.exitCode = 1;
} else {
  const child = spawnSync(process.execPath, [algorithm, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env, windowsHide: true });
  if (child.error) process.stderr.write(`reviewer-kit INFRA_ERROR: ${child.error.message}\n`);
  // A child that ended by signal has no status: that is a failed review, never a pass.
  process.exitCode = child.status ?? 1;
}
