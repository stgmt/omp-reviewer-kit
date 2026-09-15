import { isTestPath } from './suspicion-map.mjs';

/**
 * Builds the file set for a reverted snapshot where non-test staged changes
 * are reverted to their HEAD state to test if test changes fail without them (red proof).
 *
 * @param {{
 *   files: { path: string, content: Buffer }[],
 *   changedPaths: string[],
 *   testPathPatterns?: string[],
 *   headFiles: Map<string, Buffer | null>,
 * }} options
 * @returns {{ path: string, content: Buffer }[]}
 */
export function buildRevertedFiles({
  files = [],
  changedPaths = [],
  testPathPatterns,
  headFiles = new Map(),
} = {}) {
  const changedSet = new Set(changedPaths);
  const resultFiles = [];
  const processedPaths = new Set();

  for (const file of files) {
    processedPaths.add(file.path);
    if (!changedSet.has(file.path) || isTestPath(file.path, testPathPatterns)) {
      resultFiles.push({ path: file.path, content: file.content });
      continue;
    }

    const headContent = headFiles.get(file.path);
    if (headContent !== null && headContent !== undefined) {
      resultFiles.push({ path: file.path, content: headContent });
    }
  }

  for (const p of changedPaths) {
    if (!processedPaths.has(p) && !isTestPath(p, testPathPatterns)) {
      const headContent = headFiles.get(p);
      if (headContent !== null && headContent !== undefined) {
        resultFiles.push({ path: p, content: headContent });
      }
    }
  }

  return resultFiles;
}
