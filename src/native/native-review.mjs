// One staged review from start to verdict: snapshot, native task, evidence, verdict.
// Every step is deterministic except the single native task, which OMP runs.

import { stageCounts } from '../domain/review-run-summary.mjs';
import { removeSnapshot, materializeStagedSnapshot } from './snapshot.mjs';
import { buildAssignment } from './assignment.mjs';
import { fallbackOf, provenanceOf, reviewerTranscript, reviewerYield, runReviewerTask } from './task-engine.mjs';
import { readFallbackEvidence } from './fallback-evidence.mjs';
import { BUDGET_REASONS, assessDiff, readDiffBudget } from '../domain/diff-budget.mjs';
import { runMaintainabilityAnalysis } from './maintainability/analyze.mjs';
import { runReuseAnalysis } from './reuse/analyze.mjs';
import { runContractAnalysis } from './contract/analyze.mjs';
import { renderReuseLines } from './reuse/report.mjs';
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
  runContract = runContractAnalysis,
  now = clock,
  analysisConfig = undefined,
  reuseConfig = undefined,
  reuseMaxLines = 12,
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
    const { dir, diffHash, profile, lanes, changedPaths, patchBytes, fileClasses } = snapshot;
    // The budget is decided before any model runs: a stage that cannot finish is a cost, not a verdict.
    const budgetConfig = readDiffBudget({ env });
    const budget = budgetConfig.ok
      ? assessDiff({ paths: changedPaths.length, bytes: patchBytes }, budgetConfig)
      : {
        refused: true,
        reason: BUDGET_REASONS.invalid,
        paths: changedPaths.length,
        bytes: patchBytes,
        maxPaths: null,
        maxBytes: null,
        error: budgetConfig.error,
      };
    if (budget.refused) return { staged: true, refused: budget };
    onProgress(`review: ${changedPaths.length} staged path(s), profile ${profile}, lanes ${lanes.join(', ')}`);
    const context = { snapshot: { dir, changedPaths, diffHash }, repo, profile, lanes };
    const analysisStarted = now();
    const analysis = await runMaintainabilityAnalysis({
      context,
      env,
      now,
      config: analysisConfig ?? undefined,
    });
    const maintainabilityMs = now() - analysisStarted;
    const maintainability = summarizeMaintainability(analysis);
    const reuseStarted = now();
    const reuse = await runReuseAnalysis({
      context,
      env,
      now,
      config: reuseConfig ?? undefined,
    });
    const reuseMs = now() - reuseStarted;
    const reuseLines = reuse.skipped ? [] : renderReuseLines(reuse.analysis, { maxLines: reuseMaxLines });
    if (!reuse.skipped && reuse.artifactWritten === false) onProgress(`review: reuse artifact not written (${reuse.artifactError}); hints still supplied`);
    if (!reuse.skipped) onProgress(`review: reuse hints ${reuseLines.length > 0 ? `${reuse.analysis.candidates.length} candidate(s)` : 'none'} (${reuse.analysis.scan.units} unit(s), coverage ${reuse.analysis.coverage}, ${reuseMs} ms)`);
    if (!analysis.skipped) onProgress(`review: maintainability ${maintainability.status} (${maintainability.groups} group(s), coverage ${maintainability.coverage}, policy ${maintainability.policy})`);
    // Deterministic and cheap: a producer/consumer pair is settled by calling it, not by asking a model.
    const contractStarted = now();
    const contractAnalysis = await runContract(dir, env, { changedPaths }).catch(error => ({
      schema: 'contract@1',
      status: 'failed',
      files: 0,
      pairs: [],
      unparsedFiles: [],
      unproven: [],
      policy: 'block',
      note: `the contract stage crashed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    const contractMs = now() - contractStarted;
    const contract = {
      policy: contractAnalysis.policy,
      status: contractAnalysis.status,
      rejected: (contractAnalysis.pairs ?? [])
        .filter(pair => pair.outcome === 'reader-rejects-written-record')
        .map(pair => ({ file: pair.file, writer: pair.writer, reader: pair.reader, error: pair.error, record: pair.record })),
      probed: (contractAnalysis.pairs ?? []).length,
      note: contractAnalysis.note,
      unproven: contractAnalysis.unproven ?? [],
      unparsedFiles: contractAnalysis.unparsedFiles ?? [],
    };
    onProgress(`review: contract ${contract.status} (${contract.probed} pair(s), policy ${contract.policy})`);
    const assignment = buildAssignment({
      context,
      contract,
      reuse: reuse.skipped
        ? { policy: reuse.policy, reason: reuse.reason, files: 0, units: 0, coverage: null, lines: [] }
        : {
          policy: reuse.policy,
          reason: null,
          files: reuse.analysis.scan.filesScanned,
          units: reuse.analysis.scan.units,
          coverage: reuse.analysis.coverage,
          status: reuse.analysis.status,
          unparsed: reuse.analysis.scan.unparsedTotal ?? reuse.analysis.scan.unparsed.length,
          lines: reuseLines,
        },
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
      yieldReason: yielded?.reason ?? null,
      yieldPayload: yielded?.observed ?? null,
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
      contract,
    });
    const verdictMs = now() - verdictStarted;
    const finishedMs = now();
    return {
      staged: true,
      diffHash,
      profile,
      lanes,
      changedPaths,
      patchBytes,
      budget,
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
      contract,
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
        timings: { snapshotMs, maintainabilityMs, contractMs, nativeTaskMs, verdictMs },
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
