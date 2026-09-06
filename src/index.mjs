export { DiffIdentity } from './domain/diff-identity.mjs';
export { ReviewVerdict } from './domain/review-verdict.mjs';
export { ReviewRejectionEnvelope } from './domain/review-rejection-envelope.mjs';
export { ReviewPrompt } from './domain/review-prompt.mjs';
export { ReviewReport } from './domain/review-report.mjs';
export { ReviewExecutionResult } from './domain/review-execution-result.mjs';

export { GitPort, ReviewerPort, ReportStorePort } from './application/ports.mjs';
export { ReviewWorkflowService } from './application/review-workflow-service.mjs';
export { PluginInstallerService } from './application/installer-service.mjs';

export { SubprocessGitAdapter } from './infra/subprocess-git-adapter.mjs';
export { OmpCliReviewerAdapter } from './infra/omp-cli-reviewer-adapter.mjs';
export { FileSystemReportStoreAdapter } from './infra/filesystem-report-store-adapter.mjs';

import { SubprocessGitAdapter } from './infra/subprocess-git-adapter.mjs';
import { OmpCliReviewerAdapter } from './infra/omp-cli-reviewer-adapter.mjs';
import { FileSystemReportStoreAdapter } from './infra/filesystem-report-store-adapter.mjs';
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
export function createReviewWorkflowService({ git, omp, clock, logger, progress } = {}) {
  const gitPort = new SubprocessGitAdapter(git);
  const reviewerPort = new OmpCliReviewerAdapter({ runner: omp, progress });
  const reportStorePort = new FileSystemReportStoreAdapter();

  return new ReviewWorkflowService({
    gitPort,
    reviewerPort,
    reportStorePort,
    clock,
    logger,
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
  now = new Date(),
  logger,
} = {}) {
  const service = createReviewWorkflowService({
    git,
    omp,
    clock: () => now,
    logger,
  });

  const result = await service.execute({ cwd });
  return result.toJSON();
}
