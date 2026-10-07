import path from 'node:path';

const SKIPPED = [/^tp-/, /^omp-reviewer-kit-release$/];

/** Repositories that no sync, manual or automatic, may touch. */
export const isSkippedTarget = (repo) => SKIPPED.some((pattern) => pattern.test(path.basename(repo)));
