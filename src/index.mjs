export { DiffIdentity } from './domain/diff-identity.mjs';
export { StagedSnapshot } from './domain/staged-snapshot.mjs';
export { ReviewVerdict } from './domain/review-verdict.mjs';
export { ReviewRejectionEnvelope } from './domain/review-rejection-envelope.mjs';
export { ReviewPrompt } from './domain/review-prompt.mjs';
export {
  SuspicionMap,
  isTestPath,
  parseDiffBlocks,
  DEFAULT_ASSERT_PATTERNS,
  DEFAULT_TEST_PATH_PATTERNS,
  DEFAULT_TEST_DECLARATION_PATTERNS,
} from './domain/suspicion-map.mjs';
export { ReviewReport } from './domain/review-report.mjs';
export { ReviewExecutionResult } from './domain/review-execution-result.mjs';

export { GitPort, ReviewerPort, ReportStorePort, SnapshotStorePort, TelemetryPort } from './application/ports.mjs';
export { ReviewWorkflowService } from './application/review-workflow-service.mjs';
export { PluginInstallerService } from './application/installer-service.mjs';

export { SubprocessGitAdapter } from './infra/subprocess-git-adapter.mjs';
export { FileSystemSnapshotAdapter } from './infra/filesystem-snapshot-adapter.mjs';
export { OmpCliReviewerAdapter, sanitizeReviewerOutput } from './infra/omp-cli-reviewer-adapter.mjs';
export { FileSystemReportStoreAdapter } from './infra/filesystem-report-store-adapter.mjs';
export {
  FileSystemTelemetryAdapter,
  NullTelemetryAdapter,
  RunTelemetry,
  NULL_RUN_TELEMETRY,
  REVIEW_EVENT_SCHEMA,
  REVIEW_LAST_RUN_SCHEMA,
  formatProviderOutageError,
} from './infra/filesystem-telemetry-adapter.mjs';

import { SubprocessGitAdapter } from './infra/subprocess-git-adapter.mjs';
import { FileSystemSnapshotAdapter } from './infra/filesystem-snapshot-adapter.mjs';
import { OmpCliReviewerAdapter } from './infra/omp-cli-reviewer-adapter.mjs';
import { FileSystemReportStoreAdapter } from './infra/filesystem-report-store-adapter.mjs';
import { FileSystemTelemetryAdapter } from './infra/filesystem-telemetry-adapter.mjs';
import { ReviewWorkflowService } from './application/review-workflow-service.mjs';

/**
 * Convenience composition root for the default review workflow service.
 *
 * @param {{
 *   git?: (args: string[], cwd: string) => Buffer,
 *   omp?: (prompt: string, cwd: string, timeoutMs?: number) => { status: number, stdout?: string, stderr?: string },
 *   clock?: () => Date,
 *   logger?: { log: (msg: string) => void, error: (msg: string) => void },
 *   progress?: (event: { state: string, message: string, model?: string, elapsedMs?: number }) => void
 * }} [options]
 * @returns {ReviewWorkflowService}
 */
export function createReviewWorkflowService({ git, omp, ompOptions, clock, logger, progress, telemetry, assertPatterns, testPathPatterns, testDeclarationPatterns } = {}) {
  const gitPort = new SubprocessGitAdapter(git);
  const reviewerPort = new OmpCliReviewerAdapter({ runner: omp, progress, ...ompOptions });
  const reportStorePort = new FileSystemReportStoreAdapter();
  const snapshotStorePort = new FileSystemSnapshotAdapter();
  const telemetryPort = telemetry ?? new FileSystemTelemetryAdapter();

  return new ReviewWorkflowService({
    gitPort,
    reviewerPort,
    reportStorePort,
    snapshotStorePort,
    telemetryPort,
    clock,
    logger,
    assertPatterns,
    testPathPatterns,
    testDeclarationPatterns,
  });
}

/**
 * Public facade maintaining backward compatibility with existing Git pre-commit hooks and tests.
 *
 * @param {{
 *   cwd?: string,
 *   git?: (args: string[], cwd: string) => Buffer,
 *   omp?: (prompt: string, cwd: string, timeoutMs?: number) => { status: number, stdout?: string, stderr?: string },
 *   now?: Date,
 *   logger?: { log: (msg: string) => void, error: (msg: string) => void },
 * }} [options]
 * @returns {Promise<{ exitCode: number, skipped: boolean, verdict?: 'PASS'|'BLOCK', reportPath?: string }>}
 */
export async function runReview({
  cwd = process.cwd(),
  git,
  omp,
  ompOptions,
  now = new Date(),
  logger,
  progress,
  telemetry,
} = {}) {
  const service = createReviewWorkflowService({
    git,
    omp,
    ompOptions,
    clock: () => now,
    logger,
    progress,
    telemetry,
  });

  const result = await service.execute({ cwd });
  return result.toJSON();
}
