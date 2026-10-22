// Public entry point of the kit. The review itself is `src/native/`: one staged snapshot, one
// native OMP task for `reviewer-kit`, and a verdict over the native evidence. The rest is the
// hook installer, its guard and the target registry.

export { runNativeReview } from './native/native-review.mjs';
export { materializeStagedSnapshot, readStagedChange, removeSnapshot } from './native/snapshot.mjs';
export { buildAssignment } from './native/assignment.mjs';
export { evaluateReview, readVerdictMarker, PASS_MARKER, BLOCK_MARKER } from './native/verdict.mjs';
export { runReviewerTask, reviewerYield, stageEvidence } from './native/task-engine.mjs';

export { DiffIdentity } from './domain/diff-identity.mjs';
export { classifyFilePath, classifyChangedPaths, reviewProfileFor, riskLanesFor } from './domain/file-class.mjs';
export { sanitizePromptToken } from './domain/prompt-token.mjs';
export { HOOK_SHIM, HOOK_SHIM_FORMAT, isOwnedShim } from './domain/hook-shim.mjs';
export { isGitCommitCommand } from './domain/git-commit-command.mjs';
export { PluginInstallerService } from './application/installer-service.mjs';
export { VENDORED_KIT_FILES, loadCanonicalVendoredFiles } from './infra/vendored-kit-files.mjs';
export { repoReportsDir, reportsRootDir } from './infra/filesystem-report-store-adapter.mjs';
