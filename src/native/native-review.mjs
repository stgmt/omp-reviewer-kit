// One staged review from start to verdict: snapshot, native task, evidence, verdict.
// Every step is deterministic except the single native task, which OMP runs.

import { removeSnapshot, materializeStagedSnapshot } from './snapshot.mjs';
import { buildAssignment } from './assignment.mjs';
import { provenanceOf, reviewerYield, runReviewerTask } from './task-engine.mjs';
import { evaluateReview } from './verdict.mjs';

/**
 * @param {{
 *   repo: string,
 *   kitRoot: string,
 *   parentDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   onProgress?: (line: string) => void,
 *   runTask?: typeof runReviewerTask,
 * }} input
 * @returns {Promise<
 *   { staged: false } |
 *   {
 *     staged: true,
 *     diffHash: string,
 *     profile: 'full'|'spec-docs',
 *     lanes: string[],
 *     changedPaths: string[],
 *     provenance: { role: string|null, model: string|null },
 *     stages: Array<{ agent: string|null, exitCode: number|null, aborted: boolean, structuredStatus: string|null, role: string|null, model: string|null }>,
 *     text: string,
 *     verdict: { pass: boolean, verdict: 'PASS'|'BLOCK', reasons: string[] },
 *   }
 * >}
 */
export async function runNativeReview({ repo, kitRoot, parentDir, env = process.env, onProgress = () => {}, runTask = runReviewerTask }) {
  const snapshot = await materializeStagedSnapshot({ repo, parentDir, env });
  if (!snapshot) return { staged: false };
  try {
    const { dir, diffHash, profile, lanes, changedPaths } = snapshot;
    onProgress(`review: ${changedPaths.length} staged path(s), profile ${profile}, lanes ${lanes.join(', ')}`);
    const assignment = buildAssignment({ snapshotDir: dir, repoRoot: repo, diffHash, profile, lanes, changedPaths });
    const { reviewer, stages } = await runTask({ cwd: repo, kitRoot, assignment, onProgress });
    const yielded = reviewerYield(reviewer);
    const reviewerView = reviewer && {
      exitCode: reviewer.exitCode ?? null,
      aborted: reviewer.aborted === true,
      yieldStatus: yielded?.status ?? null,
      text: yielded?.text ?? null,
    };
    const verdict = evaluateReview({ reviewer: reviewerView, stages, profile, lanes });
    return {
      staged: true,
      diffHash,
      profile,
      lanes,
      changedPaths,
      provenance: reviewer ? provenanceOf(reviewer) : { role: null, model: null },
      stages: stages.map(({ agent, exitCode, aborted, structuredStatus, role, model }) => ({ agent, exitCode, aborted, structuredStatus, role, model })),
      text: reviewerView?.text ?? '',
      verdict,
    };
  } finally {
    await removeSnapshot(snapshot.dir);
  }
}
