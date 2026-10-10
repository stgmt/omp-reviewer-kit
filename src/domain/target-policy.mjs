import path from 'node:path';

const SKIPPED = [/^tp-/, /^omp-reviewer-kit-release$/];
// Disposable worker checkouts of the task runner (<folder>\omp-tasks\<task>\wt): no sync, setup or heal writes into them.
const SKIPPED_FOLDERS = [/[\\/]omp-tasks[\\/]/i];

/** Repositories that no sync, setup, heal, registration or session start may touch. */
export const isSkippedTarget = (repo) =>
  SKIPPED.some((pattern) => pattern.test(path.basename(repo))) ||
  SKIPPED_FOLDERS.some((pattern) => pattern.test(path.resolve(repo)));
