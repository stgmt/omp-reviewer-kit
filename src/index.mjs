// Public entry point of the kit. The review itself is `src/native/`: one staged snapshot, one
// native OMP task for `reviewer-kit`, and a verdict over the native evidence. The rest is the
// hook installer, its guard and the target registry.

export { runNativeReview } from './native/native-review.mjs';
export { materializeStagedSnapshot, readStagedChange, removeSnapshot } from './native/snapshot.mjs';
export { buildAssignment } from './native/assignment.mjs';
export { evaluateReview, readVerdictMarker, PASS_MARKER, BLOCK_MARKER, MAINTAINABILITY_AGENT, maintainabilityBlocks } from './native/verdict.mjs';
export { runMaintainabilityAnalysis, analyzeTree, ANALYSIS_RELATIVE_PATH } from './native/maintainability/analyze.mjs';
export { resolvePolicy, resolveConfig, DEFAULT_CONFIG, POLICY_ENV } from './native/maintainability/config.mjs';
export { extractSignatures, collectExecutableFiles } from './native/maintainability/extract.mjs';
export { groupClumps, isGeneratedPath } from './native/maintainability/group.mjs';
export { runReviewerTask, reviewerYield, stageEvidence, progressEvents } from './native/task-engine.mjs';
export { buildRunRecord, createRunId, createRunRecorder, formatStageEvent } from './native/review-telemetry.mjs';
export {
  RUN_SCHEMA,
  formatDuration,
  isTerminalRun,
  normalizeRunRecord,
  runStateFor,
  stageCounts,
  stageSummaryLine,
} from './domain/review-run-summary.mjs';
export {
  isRunAlive,
  latestRunRecord,
  pruneRuns,
  readRunRecord,
  readRunRecords,
  runRecordFile,
  runsRootDir,
  writeRunRecord,
} from './infra/review-run-store.mjs';

export { DiffIdentity } from './domain/diff-identity.mjs';
export { classifyFilePath, classifyChangedPaths, reviewProfileFor, riskLanesFor } from './domain/file-class.mjs';
export { sanitizePromptToken } from './domain/prompt-token.mjs';
export { HOOK_SHIM, HOOK_SHIM_FORMAT, isOwnedShim } from './domain/hook-shim.mjs';
export { isGitCommitCommand } from './domain/git-commit-command.mjs';
export { PluginInstallerService } from './application/installer-service.mjs';
export { VENDORED_KIT_FILES, loadCanonicalVendoredFiles } from './infra/vendored-kit-files.mjs';
export { repoReportsDir, reportsRootDir } from './infra/filesystem-report-store-adapter.mjs';
