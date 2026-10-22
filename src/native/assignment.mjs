// The native task assignment for `reviewer-kit`. It carries the staged inputs the orchestrator
// and its specialists read; it names no model, role, effort, provider or fallback.

import { sanitizePromptToken } from '../domain/prompt-token.mjs';

/**
 * @param {{
 *   snapshotDir: string,
 *   repoRoot: string,
 *   diffHash: string,
 *   profile: 'full'|'spec-docs',
 *   lanes: string[],
 *   changedPaths: string[],
 * }} input
 * @returns {string}
 */
export function buildAssignment({ snapshotDir, repoRoot, diffHash, profile, lanes, changedPaths }) {
  const review = `${snapshotDir}/.review`;
  return [
    'Review the staged Git change of the repository below as the reviewer-kit orchestrator.',
    '',
    `The staged snapshot directory is ${snapshotDir}`,
    `Diff file (complete staged diff, byte-exact): ${review}/diff.patch`,
    `Changed-file manifest: ${review}/changed-files.txt`,
    `File-class manifest (deterministic, do not re-classify): ${review}/file-classes.json`,
    `Repository root (read-only Git metadata and skill discovery only): ${repoRoot}`,
    `Diff hash (SHA-256 of the binary staged diff): ${diffHash}`,
    `Review profile for this diff: ${profile}`,
    `Risk lanes for this diff: ${JSON.stringify(lanes)}`,
    'No suspicion map, previous-round block, execution evidence block or hunter shards are supplied for this assignment.',
    '',
    'Changed paths:',
    ...changedPaths.map(file => `- ${sanitizePromptToken(file)}`),
  ].join('\n');
}
