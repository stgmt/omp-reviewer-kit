// The native task assignment for `reviewer-kit`. It carries the staged inputs the orchestrator
// and its specialists read; it names no model, role, effort, provider or fallback.

import { sanitizePromptToken } from '../domain/prompt-token.mjs';

/**
 * @param {{
 *   context: {
 *     snapshot: { dir: string, changedPaths: string[], diffHash: string },
 *     repo: string,
 *     profile: 'full'|'spec-docs',
 *     lanes: string[],
 *   },
 *   maintainability?: {
 *     path: string|null, policy: string, status: string, coverage: string|null,
 *     candidates: number, reason?: string|null, truncated?: boolean,
 *   }|null,
 *   reuse?: {
 *     policy: string, reason?: string|null, files: number, units: number,
 *     coverage: string|null, lines: string[],
 *   }|null,
 * }} input
 * @returns {string}
 */
export function buildAssignment({ context, maintainability = null, reuse = null }) {
  const { snapshot, repo: repoRoot, profile, lanes } = context;
  const { dir: snapshotDir, diffHash, changedPaths } = snapshot;
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
    reuseLine(reuse),
    'No suspicion map, previous-round block, execution evidence block or hunter shards are supplied for this assignment.',
    '',
    'Changed paths:',
    ...changedPaths.map(file => `- ${sanitizePromptToken(file)}`),
  ].join('\n');
}

/**
 * What the scan did not cover. A partial or failed scan must never read as "nothing found", so the
 * coverage is spelled out next to the counts: how many supported files were left unanalysed and
 * whether the analysis itself failed.
 */
function coverageNote(reuse) {
  const unparsed = Number.isFinite(reuse.unparsed) && reuse.unparsed > 0 ? `; ${reuse.unparsed} supported file(s) or adapter not analysed` : '';
  const failed = reuse.status === 'failed' ? '; the scan failed' : '';
  return `${unparsed}${failed}`;
}

/**
 * The reuse hints: a deterministic scan of the snapshot, offered as reading suggestions. The line
 * never claims that no duplicate exists — the scan is a bounded hint, not a proof.
 */
function reuseLine(reuse) {
  if (!reuse) return 'Reuse hints: not run.';
  if (reuse.reason) return `Reuse hints: not run (${reuse.reason}).`;
  const limits = coverageNote(reuse);
  if (!Array.isArray(reuse.lines) || reuse.lines.length === 0) {
    return `Reuse hints: none above the thresholds (${reuse.files} file(s), ${reuse.units} unit(s) scanned, coverage ${reuse.coverage}, policy ${reuse.policy})${limits}.`;
  }
  // The section is bounded as a whole by the renderer, which already carries its own coverage line.
  return reuse.lines.join('\n');
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
