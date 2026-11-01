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
 *   maintainability?: {
 *     path: string|null, policy: string, status: string, coverage: string|null,
 *     candidates: number, reason?: string|null, truncated?: boolean,
 *   }|null,
 * }} input
 * @returns {string}
 */
export function buildAssignment({ snapshotDir, repoRoot, diffHash, profile, lanes, changedPaths, maintainability = null }) {
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
    maintainabilityLine(maintainability),
    'No suspicion map, previous-round block, execution evidence block or hunter shards are supplied for this assignment.',
    '',
    'Changed paths:',
    ...changedPaths.map(file => `- ${sanitizePromptToken(file)}`),
  ].join('\n');
}

/**
 * The maintainability inputs the orchestrator hands to its stage: where the deterministic
 * candidate file is, which policy governs blocking, and how much of the snapshot was read.
 * A skipped analysis is stated with its reason, never left implicit.
 */
function maintainabilityLine(maintainability) {
  if (!maintainability || !maintainability.path) {
    const reason = maintainability?.reason ?? 'not-run';
    return `Maintainability review: not run (${reason}); the maintainability stage is not planned for this diff.`;
  }
  const coverage = maintainability.coverage ?? 'unknown';
  const truncated = maintainability.truncated === true ? ', scan truncated: support is a lower bound' : '';
  return `Maintainability candidates (deterministic, written before this task): ${maintainability.path} — status ${maintainability.status}, ${maintainability.candidates} group(s), coverage ${coverage}, policy ${maintainability.policy}${truncated}.`;
}
