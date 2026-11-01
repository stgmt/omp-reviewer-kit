// One staged review from start to verdict: snapshot, native task, evidence, verdict.
// Every step is deterministic except the single native task, which OMP runs.

import { stageCounts } from '../domain/review-run-summary.mjs';
import { removeSnapshot, materializeStagedSnapshot } from './snapshot.mjs';
import { buildAssignment } from './assignment.mjs';
import { fallbackOf, provenanceOf, reviewerTranscript, reviewerYield, runReviewerTask } from './task-engine.mjs';
import { readFallbackEvidence } from './fallback-evidence.mjs';
import { runMaintainabilityAnalysis } from './maintainability/analyze.mjs';
import { evaluateReview } from './verdict.mjs';

const clock = () => Date.now();

/**
 * @param {{
 *   repo: string,
 *   kitRoot: string,
 *   parentDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   onProgress?: (line: string) => void,
 *   onEvent?: (event: object) => void,
 *   runTask?: typeof runReviewerTask,
 *   now?: () => number,
 * }} input
 * @returns {Promise<
 *   { staged: false, runSummary: { startedAt: string, finishedAt: string, durationMs: number, timings: object } } |
 *   {
 *     staged: true,
 *     diffHash: string,
 *     profile: 'full'|'spec-docs',
 *     lanes: string[],
 *     changedPaths: string[],
 *     fileClasses: Array<{ path: string, fileClass: string }>,
 *     provenance: { role: string|null, model: string|null },
 *     fallback: { applied: boolean, requested: string|null, chainLength: number|null, error: string|null },
 *     stages: Array<object>,
 *     text: string,
 *     verdict: { pass: boolean, verdict: 'PASS'|'BLOCK', reasons: string[] },
 *     runSummary: { startedAt: string, finishedAt: string, durationMs: number, reviewer: object, timings: object },
 *   }
 * >}
 */
export async function runNativeReview({
  repo,
  kitRoot,
  parentDir,
  env = process.env,
  onProgress = () => {},
  onEvent = () => {},
  runTask = runReviewerTask,
  now = clock,
  analysisConfig = undefined,
}) {
  const startedMs = now();
  const snapshotStarted = now();
  const snapshot = await materializeStagedSnapshot({ repo, parentDir, env });
  const snapshotMs = now() - snapshotStarted;
  if (!snapshot) {
    return {
      staged: false,
      runSummary: { startedAt: new Date(startedMs).toISOString(), finishedAt: new Date().toISOString(), durationMs: now() - startedMs, timings: { snapshotMs } },
    };
  }
  try {
    const { dir, diffHash, profile, lanes, changedPaths, fileClasses } = snapshot;
    onProgress(`review: ${changedPaths.length} staged path(s), profile ${profile}, lanes ${lanes.join(', ')}`);
    const analysisStarted = now();
    const analysis = await runMaintainabilityAnalysis({
      snapshotDir: dir,
      changedPaths,
      diffHash,
      env,
      now,
      config: analysisConfig ?? undefined,
    });
    const maintainabilityMs = now() - analysisStarted;
    const maintainability = summarizeMaintainability(analysis);
    if (!analysis.skipped) onProgress(`review: maintainability ${maintainability.status} (${maintainability.groups} group(s), coverage ${maintainability.coverage}, policy ${maintainability.policy})`);
    const assignment = buildAssignment({
      snapshotDir: dir,
      repoRoot: repo,
      diffHash,
      profile,
      lanes,
      changedPaths,
      maintainability: analysis.skipped
        ? { path: null, policy: analysis.policy, status: 'not-run', coverage: null, candidates: 0, reason: analysis.reason }
        : {
          path: analysis.analysisPath,
          policy: maintainability.policy,
          status: maintainability.status,
          coverage: maintainability.coverage,
          candidates: maintainability.groups,
          truncated: maintainability.truncated,
        },
    });
    const taskStarted = now();
    const { reviewer, stages } = await runTask({ cwd: repo, kitRoot, assignment, onProgress, onEvent });
    const nativeTaskMs = now() - taskStarted;
    const evidence = await readFallbackEvidence(reviewerTranscript(reviewer));
    const fallback = { ...fallbackOf(reviewer), chainLength: evidence?.chainLength ?? null, error: evidence?.errors[0] ?? null };
    const yielded = reviewerYield(reviewer);
    const reviewerView = reviewer && {
      exitCode: reviewer.exitCode ?? null,
      aborted: reviewer.aborted === true,
      yieldStatus: yielded?.status ?? null,
      text: yielded?.text ?? null,
    };
    const verdictStarted = now();
    const verdict = evaluateReview({
      reviewer: reviewerView,
      stages,
      profile,
      lanes,
      fileClasses,
      maintainability: {
        policy: maintainability.policy,
        status: maintainability.status,
        coverage: maintainability.coverage,
        planned: maintainability.planned,
      },
    });
    const verdictMs = now() - verdictStarted;
    const finishedMs = now();
    return {
      staged: true,
      diffHash,
      profile,
      lanes,
      changedPaths,
      fileClasses,
      provenance: reviewer ? provenanceOf(reviewer) : { role: null, model: null },
      fallback,
      stages: stages.map(stage => ({
        agent: stage.agent,
        exitCode: stage.exitCode,
        aborted: stage.aborted,
        structuredStatus: stage.structuredStatus,
        role: stage.role,
        model: stage.model,
        durationMs: stage.durationMs ?? null,
        tokens: stage.tokens ?? null,
        requests: stage.requests ?? null,
        contextTokens: stage.contextTokens ?? null,
        counts: stageCounts(stage.data),
      })),
      text: reviewerView?.text ?? '',
      verdict,
      maintainability,
      runSummary: {
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: new Date(finishedMs).toISOString(),
        durationMs: finishedMs - startedMs,
        reviewer: {
          durationMs: reviewer?.durationMs ?? null,
          tokens: reviewer?.tokens ?? null,
          requests: reviewer?.requests ?? null,
          contextTokens: reviewer?.contextTokens ?? null,
          sessionFile: reviewerTranscript(reviewer),
          fallbackApplied: fallback.applied,
        },
        timings: { snapshotMs, maintainabilityMs, nativeTaskMs, verdictMs },
      },
    };
  } finally {
    await removeSnapshot(snapshot.dir);
  }
}

/**
 * The maintainability summary carried into the event stream, the run record and the verdict.
 * Counters only: no report text, no file bodies.
 *
 * @param {{ policy: string, skipped: boolean, reason: string|null, analysis: object|null }} analysis
 */
function summarizeMaintainability({ policy, skipped, reason, analysis }) {
  if (skipped || !analysis) {
    return {
      policy,
      status: 'not-run',
      reason: reason ?? null,
      coverage: null,
      groups: 0,
      unparsed: 0,
      excluded: 0,
      truncated: false,
      planned: false,
    };
  }
  return {
    policy,
    status: analysis.status,
    reason: null,
    coverage: analysis.coverage,
    groups: Array.isArray(analysis.groups) ? analysis.groups.length : 0,
    unparsed: Array.isArray(analysis.unparsedFiles) ? analysis.unparsedFiles.length : 0,
    excluded: Array.isArray(analysis.excluded) ? analysis.excluded.length : 0,
    truncated: analysis.scan?.truncated === true,
    planned: analysis.status === 'analyzed',
  };
}
