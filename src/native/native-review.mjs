// One staged review from start to verdict: snapshot, native task, evidence, verdict.
// Every step is deterministic except the single native task, which OMP runs.

import path from 'node:path';

import { stageCounts } from '../domain/review-run-summary.mjs';
import { removeSnapshot, materializeStagedSnapshot } from './snapshot.mjs';
import { createStageRunner, evidenceFromResult, fallbackOf, provenanceOf, reviewerTranscript, reviewerYield } from './task-engine.mjs';
import { hunterTask, maintainabilityTask, recheckTask, scoutTask, synthesisTask, verifierTask } from './stage-tasks.mjs';
import { hunterBudget, runStagePipeline } from './stage-pipeline.mjs';
import { readFallbackEvidence } from './fallback-evidence.mjs';
import { BUDGET_REASONS, assessDiff, readDiffBudget } from '../domain/diff-budget.mjs';
import { classifyFilePath } from '../domain/file-class.mjs';
import { centralizationGroupIds } from '../domain/maintainability-centralization.mjs';
import { isTestPath } from '../domain/suspicion-map.mjs';
import { runMaintainabilityAnalysis } from './maintainability/analyze.mjs';
import { runReuseAnalysis } from './reuse/analyze.mjs';
import { runContractAnalysis } from './contract/analyze.mjs';
import { renderReuseLines } from './reuse/report.mjs';
import { HUNTER_AGENT, MAINTAINABILITY_AGENT, SCOUT_AGENT, VERIFIER_AGENT, evaluateReview, reportFindings, stageCompleted } from './verdict.mjs';
import {
  HUNTER_STAGE,
  JOURNAL_SCHEMA,
  MAINTAINABILITY_STAGE,
  SCOUT_STAGE,
  STAGE_SCHEMA,
  VERIFIER_STAGE,
  configFingerprint,
  resolveJournalPolicy,
  reviewKey,
  stageId,
  verdictReusable,
} from '../domain/review-journal.mjs';
import { journalRootDir, pruneJournals, readJournal, readStageEntry, writeJournal, writeStageEntry } from '../infra/review-journal-store.mjs';
import { readIndexTreeOid, stagedIgnoredPaths } from '../infra/git-index-identity.mjs';
import { readAgentsDigest, readKitVersion } from '../infra/kit-fingerprint.mjs';
import { repoIdentity } from '../infra/repo-identity.mjs';
import { resolveConfig as resolveMaintainabilityConfig, resolvePolicy as resolveMaintainabilityPolicy } from './maintainability/config.mjs';
import { resolveReusePolicy } from './reuse/config.mjs';
import { contractPolicy } from './contract/analyze.mjs';

const clock = () => Date.now();

/**
 * @param {{
 *   repo: string,
 *   kitRoot: string,
 *   parentDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   onProgress?: (line: string) => void,
 *   onEvent?: (event: object) => void,
 *   stageRunner?: { run: (agent: string, name: string, task: string) => Promise<{ result: object|undefined, evidence: object }> } | null,
 *   runTask?: ((input: { assignment: string }) => Promise<{ reviewer?: object, stages?: object[] }>) | null,
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
  stageRunner = null,
  runTask = null,
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
    // The identity of this exact staged state: the index tree, the diff, and the kit that asks the
    // question. A stored verdict for this key answers the review without running it; a different
    // tree (including staged junk that an ignore rule would have kept out) never reuses one.
    const journalPolicy = resolveJournalPolicy(env);
    const journalRoot = journalRootDir({ env });
    const ignoredStagedPaths = await stagedIgnoredPaths(repo, changedPaths);
    if (ignoredStagedPaths.length > 0) {
      onProgress(`review: staged paths ignored by .gitignore: ${ignoredStagedPaths.join(', ')}`);
    }
    const identity = {
      repoIdentity: repoIdentity(repo),
      treeOid: await readIndexTreeOid(repo),
      diffHash,
      kitVersion: await readKitVersion(kitRoot),
      agentsDigest: await readAgentsDigest(kitRoot),
      configFingerprint: configFingerprint({
        profile,
        lanes,
        maintainabilityPolicy: resolveMaintainabilityPolicy(env),
        reusePolicy: resolveReusePolicy(env),
        contractPolicy: contractPolicy(env),
        reuseMaxLines,
        maintainabilityConfig: analysisConfig ?? resolveMaintainabilityConfig(),
      }),
    };
    const key = reviewKey(identity);
    const journal = { key, treeOid: identity.treeOid, hit: false, policy: journalPolicy };
    if (journalPolicy === 'off') {
      onProgress('review: journal off (OMP_REVIEW_KIT_JOURNAL=off)');
    } else if (key === null) {
      onProgress('review: journal unavailable (no index tree; reuse disabled)');
    } else {
      const stored = await readJournal(journalRoot, key);
      if (verdictReusable(stored, { key })) {
        onProgress(`review: journal hit ${key.slice(0, 12)} (${stored.verdict.verdict}, ${stored.finishedAt ?? 'unknown'})`);
        return reusedResult({ record: stored, journal: { ...journal, hit: true }, ignoredStagedPaths, startedMs, now });
      }
      onProgress(`review: journal miss ${key.slice(0, 12)}`);
    }
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
    const assignmentInput = {
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
    };
    const taskStarted = now();
    // The host runs the stages, so the host decides what is reused: a stage with a valid journal
    // entry for this exact key is not run again, and the run continues from the first missing one.
    const stageJournal = journal.key !== null && journalPolicy !== 'off'
      ? {
        key: journal.key,
        read: id => readStageEntry(journalRoot, journal.key, id),
        write: (id, evidence) => writeStageEntry(journalRoot, journal.key, id, {
          schema: STAGE_SCHEMA,
          key: journal.key,
          stageId: id,
          agent: evidence.agent ?? null,
          lane: evidence.lane ?? null,
          exitCode: evidence.exitCode ?? null,
          aborted: evidence.aborted === true,
          structuredStatus: evidence.structuredStatus ?? null,
          createdAt: new Date().toISOString(),
          evidence,
        }),
      }
      : null;
    const runner = stageRunner ?? (runTask ? wholeRunAdapter(runTask) : await createStageRunner({ cwd: repo, kitRoot, onProgress, onEvent }));
    const steps = planSteps({ assignmentInput, dir, profile, lanes, maintainability, analysis, duplicates: reuse.skipped ? [] : (reuse.analysis?.candidates ?? []) });
    const { stages, evidence: stageEvidenceById } = await runStagePipeline({ runner, steps, journal: stageJournal, onProgress });
    const hunters = laneResults(lanes, stageEvidenceById);
    const synthesis = await runner.run('reviewer-kit', 'Synthesis', synthesisTask({
      input: assignmentInput,
      scout: stageEvidenceById.get(SCOUT_STAGE)?.data ?? null,
      hunters,
      maintainability: stageEvidenceById.get(MAINTAINABILITY_STAGE)?.data ?? null,
      verifier: stageEvidenceById.get(VERIFIER_STAGE)?.data ?? null,
      profile,
      lanes,
    }));
    const reviewer = synthesis.result;
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
    const maintainabilityCentralization = await centralizationGroups({ analysis: analysis.analysis ?? analysis, snapshotDir: dir });
    const decide = (stagesSoFar, recheck) => evaluateReview({
      reviewer: reviewerView,
      stages: stagesSoFar,
      profile,
      lanes,
      fileClasses,
      maintainabilityCentralization,
      maintainability: {
        policy: maintainability.policy,
        status: maintainability.status,
        coverage: maintainability.coverage,
        planned: maintainability.planned,
      },
      contract,
      recheck,
    });
    const verdictStarted = now();
    let verdict = decide(stages, null);
    let verdictMs = now() - verdictStarted;
    // The synthesis may only propose a finding. When it blocks with claims no stage confirmed, the
    // claims are settled by calling them against the snapshot, never by trusting or ignoring them.
    if (verdict.recheckNeeded) {
      const claims = reportFindings(reviewerView?.text).items;
      onProgress(`review: re-verifying ${claims.length} finding(s) the report raised; no stage confirmed them`);
      const outcome = await runner.run(VERIFIER_AGENT, 'FindingRecheck', recheckTask({ snapshotDir: dir, findings: claims }));
      const recheckStage = outcome?.evidence ?? null;
      if (recheckStage) stages.push({ ...recheckStage, recheck: true });
      const completed = recheckStage ? stageCompleted(recheckStage) : false;
      const list = value => (Array.isArray(value) ? value.length : 0);
      // Only a confirmed finding makes the recheck "confirmed". A coverage gap blocks through the
      // stage evidence under the PASS gate's own rules (severity, impact, file class, harness), and
      // an advisory gap never blocks; counting gaps here would turn a rejected finding into a block.
      const decisions = Array.isArray(recheckStage?.data?.decisions) ? recheckStage.data.decisions : [];
      const confirming = new Set(['confirmed', 'still_present']);
      const rejecting = new Set(['rejected', 'fixed']);
      // A decision answers a claim by its number: the recheck task labels the claims `report-1` …
      // `report-N`, so a duplicate or an out-of-range id cannot stand in for an unexamined claim.
      const answered = new Map();
      for (const decision of decisions) {
        const match = /^(?:report[-_ ]?)?(\d+)$/i.exec(String(decision?.candidate_id ?? '').trim());
        if (!match) continue;
        const index = Number(match[1]);
        if (!Number.isInteger(index) || index < 1 || index > claims.length || answered.has(index)) continue;
        answered.set(index, String(decision?.disposition ?? ''));
      }
      const dispositions = [...answered.values()];
      const confirmedByClaim = dispositions.filter(disposition => confirming.has(disposition)).length;
      const rejectedByClaim = dispositions.filter(disposition => rejecting.has(disposition)).length;
      // One claim has one record: a confirmed claim may arrive as a confirmed finding or as a
      // confirming disposition, so the answer is the larger count, never their sum.
      const confirmed = Math.max(list(recheckStage?.data?.confirmed_findings), confirmedByClaim);
      // Silence is not a rejection: the pass needs a decisive disposition for every numbered claim.
      // A claim the verifier could not reach (not_proven, a missing entry, a duplicate id, a
      // truncated answer) leaves the block standing exactly as it did before the recheck.
      const settled = confirmedByClaim + rejectedByClaim === claims.length;
      const secondStarted = now();
      verdict = decide(stages, {
        verdict: !completed ? 'failed' : confirmed > 0 ? 'confirmed' : settled ? 'rejected' : 'unsettled',
        findings: claims.length,
        confirmed,
      });
      verdictMs += now() - secondStarted;
    }
    const finishedMs = now();
    const stageSummaries = stages.map(stage => ({
      agent: stage.agent,
      lane: stage.lane ?? null,
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
    }));
    // The journal is written after the verdict and before the caller sees it: a killed run keeps the
    // stages it finished, and a finished review answers the next identical tree in milliseconds.
    // Every write here is fail-open — a journal that cannot be stored costs reuse, never a verdict.
    if (journal.key !== null && journalPolicy !== 'off') {
      await writeJournal(journalRoot, journal.key, {
        schema: JOURNAL_SCHEMA,
        key: journal.key,
        identity,
        state: 'done',
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: new Date(finishedMs).toISOString(),
        durationMs: finishedMs - startedMs,
        profile,
        lanes,
        diffHash,
        patchBytes,
        changedPaths,
        budget: { paths: budget.paths, bytes: budget.bytes, maxPaths: budget.maxPaths, maxBytes: budget.maxBytes },
        ignoredStagedPaths,
        verdict,
        text: reviewerView?.text ?? '',
        provenance: reviewer ? provenanceOf(reviewer) : { role: null, model: null },
        fallback,
        reviewer: {
          durationMs: reviewer?.durationMs ?? null,
          tokens: reviewer?.tokens ?? null,
          requests: reviewer?.requests ?? null,
          contextTokens: reviewer?.contextTokens ?? null,
          sessionFile: reviewerTranscript(reviewer),
          fallbackApplied: fallback.applied,
        },
        stages: stageSummaries,
        maintainability,
        contract,
      });
      pruneJournals(journalRoot).catch(() => {});
    }
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
      stages: stageSummaries,
      journal,
      ignoredStagedPaths,
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
 * A whole-run runner adapted to the stage pipeline: the single-call seam that tests and embedders
 * inject. It runs once, then replays the stages it reported for each agent the pipeline asks for; a
 * stage the runner never reported is a failed stage, which is exactly what the verdict must see.
 * Production injects no runner and gets the real per-stage session.
 *
 * @param {(input: { assignment: string }) => Promise<{ reviewer?: object, stages?: object[] }>} runWhole
 * @returns {{ run: (agent: string, name: string, task: string) => Promise<{ result?: object, evidence: object }> }}
 */
function wholeRunAdapter(runWhole) {
  let pending = null;
  const call = task => {
    if (!pending) pending = Promise.resolve(runWhole({ assignment: task }));
    return pending;
  };
  return {
    async run(agent, name, task) {
      const outcome = await call(task);
      if (agent === 'reviewer-kit') {
        const reviewer = outcome?.reviewer;
        return { result: reviewer, evidence: evidenceFromResult(reviewer) };
      }
      // A whole-run seam runs once; it cannot perform a second pass over the report's claims. Say so
      // instead of replaying the original verifier result as if it had seen those claims.
      if (name === 'FindingRecheck') return { evidence: null };
      const evidence = (outcome?.stages ?? []).find(stage => stage.agent === agent)
        ?? { agent, lane: null, exitCode: 1, aborted: false, structuredStatus: null, data: null };
      return { evidence };
    },
  };
}

/**
 * The stage plan of one review: scout, one hunter per lane, the maintainability stage when the
 * deterministic analysis planned it, and the verifier — always for `full`, and for `spec-docs` only
 * when a hunter emitted a candidate.
 *
 * @param {{
 *   assignmentInput: object,
 *   dir: string,
 *   profile: 'full'|'spec-docs',
 *   lanes: string[],
 *   maintainability: { planned: boolean, policy: string, groups: number },
 *   analysis: { analysisPath?: string|null },
 * }} input
 * @returns {Array<object>}
 */
function planSteps({ assignmentInput, dir, profile, lanes, maintainability, analysis, duplicates = [] }) {
  const snapshotPaths = assignmentInput.context.snapshot.changedPaths;
  const steps = [
    { id: SCOUT_STAGE, agent: SCOUT_AGENT, name: 'ContextScout', task: scoutTask(assignmentInput) },
  ];
  for (const lane of lanes) {
    steps.push({
      id: stageId(HUNTER_STAGE, lane),
      agent: HUNTER_AGENT,
      name: `RiskHunter-${lane}`,
      task: evidence => hunterTask({
        input: assignmentInput,
        scout: evidence.get(SCOUT_STAGE)?.data ?? null,
        lane,
        budget: hunterBudget({
          changedPaths: snapshotPaths.length,
          consumers: (evidence.get(SCOUT_STAGE)?.data?.relevant_consumers ?? []).length,
        }),
      }),
    });
  }
  if (maintainability.planned) {
    steps.push({
      id: MAINTAINABILITY_STAGE,
      agent: MAINTAINABILITY_AGENT,
      name: 'Maintainability',
      task: maintainabilityTask({
        snapshotDir: dir,
        candidatePath: analysis.analysisPath ?? path.join(dir, '.review', 'maintainability.json'),
        policy: maintainability.policy,
        profile,
        budget: Math.max(4, 2 * maintainability.groups),
      }),
    });
  }
  steps.push({
    id: VERIFIER_STAGE,
    agent: VERIFIER_AGENT,
    name: 'FindingVerifier',
    when: evidence => profile === 'full'
      || laneResults(lanes, evidence).some(result => (result.data?.candidates ?? []).length > 0),
    task: evidence => verifierTask({
      input: assignmentInput,
      scout: evidence.get(SCOUT_STAGE)?.data ?? null,
      hunters: laneResults(lanes, evidence),
      coverageGaps: laneResults(lanes, evidence)
        .flatMap(result => (Array.isArray(result.data?.coverage_gaps) ? result.data.coverage_gaps : [])),
      duplicates,
      profile,
    }),
  });
  return steps;
}

/**
 * One entry per planned hunter lane, with whatever that lane reported.
 *
 * @param {string[]} lanes
 * @param {Map<string, object>} evidence
 * @returns {Array<{ lane: string, data: object|null }>}
 */
function laneResults(lanes, evidence) {
  return (Array.isArray(lanes) ? lanes : []).map(lane => ({
    lane,
    data: evidence.get(stageId(HUNTER_STAGE, lane))?.data ?? null,
  }));
}

/**
 * The result of a review that a stored journal answered. It carries the same shape the host and the
 * report writer read from a fresh run; every timing is zero because nothing ran, and the report text
 * is the one the original review produced for these exact bytes.
 *
 * @param {{
 *   record: object,
 *   journal: { key: string|null, treeOid: string|null, hit: boolean, policy: string },
 *   ignoredStagedPaths: string[],
 *   startedMs: number,
 *   now: () => number,
 * }} input
 */
function reusedResult({ record, journal, ignoredStagedPaths, startedMs, now }) {
  const finishedMs = now();
  const reviewer = record?.reviewer ?? {};
  return {
    staged: true,
    diffHash: record?.diffHash ?? null,
    profile: record?.profile ?? null,
    lanes: Array.isArray(record?.lanes) ? record.lanes : [],
    changedPaths: Array.isArray(record?.changedPaths) ? record.changedPaths : [],
    patchBytes: record?.patchBytes ?? null,
    budget: record?.budget ?? null,
    fileClasses: [],
    provenance: record?.provenance ?? { role: null, model: null },
    fallback: record?.fallback ?? { applied: false, requested: null, chainLength: null, error: null },
    stages: Array.isArray(record?.stages) ? record.stages : [],
    journal,
    ignoredStagedPaths: Array.isArray(ignoredStagedPaths) ? ignoredStagedPaths : [],
    text: typeof record?.text === 'string' ? record.text : '',
    verdict: record?.verdict ?? { pass: false, verdict: 'BLOCK', reasons: ['journal verdict missing'] },
    maintainability: record?.maintainability ?? null,
    contract: record?.contract ?? null,
    runSummary: {
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      reviewer: {
        durationMs: reviewer.durationMs ?? null,
        tokens: reviewer.tokens ?? null,
        requests: reviewer.requests ?? null,
        contextTokens: reviewer.contextTokens ?? null,
        sessionFile: reviewer.sessionFile ?? null,
        fallbackApplied: reviewer.fallbackApplied === true,
      },
      timings: { snapshotMs: 0, maintainabilityMs: 0, contractMs: 0, nativeTaskMs: 0, verdictMs: 0 },
    },
  };
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

/**
 * The maintainability groups that are one shared contract, read from the snapshot. Test files are
 * re-tagged here: the file classifier upgrades an executable-looking test file, so the contract test
 * would never be recognised as one.
 *
 * @param {{ analysis: object, snapshotDir: string }} input
 * @returns {Promise<Set<string>>}
 */
async function centralizationGroups({ analysis, snapshotDir }) {
  const groups = Array.isArray(analysis?.groups) ? analysis.groups : [];
  if (groups.length === 0) return new Set();
  const { readFile } = await import('node:fs/promises');
  const modulePath = await import('node:path');
  const { exempt } = await centralizationGroupIds({
    groups,
    classOf: file => (isTestPath(file) ? 'test' : classifyFilePath(file)),
    readSource: async file => {
      try {
        return await readFile(modulePath.join(snapshotDir, file), 'utf8');
      } catch {
        return null;
      }
    },
  });
  return exempt;
}
