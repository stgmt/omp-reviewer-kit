import { ReviewRejectionEnvelope } from '../domain/review-rejection-envelope.mjs';
import { ReviewPrompt } from '../domain/review-prompt.mjs';
import { ReviewReport } from '../domain/review-report.mjs';
import { ReviewExecutionResult } from '../domain/review-execution-result.mjs';
import { GitPort, ReviewerPort, ReportStorePort } from './ports.mjs';

/**
 * Application Orchestrator Service implementing the staged code review lifecycle use case.
 */
export class ReviewWorkflowService {
  #gitPort;
  #reviewerPort;
  #reportStorePort;
  #clock;
  #logger;

  /**
   * @param {{
   *   gitPort: GitPort,
   *   reviewerPort: ReviewerPort,
   *   reportStorePort: ReportStorePort,
   *   clock?: () => Date,
   *   logger?: { log: (msg: string) => void, error: (msg: string) => void }
   * }} dependencies
   */
  constructor({
    gitPort,
    reviewerPort,
    reportStorePort,
    clock = () => new Date(),
    logger = {
      log: (msg) => process.stdout.write(msg),
      error: (msg) => process.stderr.write(msg),
    },
  }) {
    if (!gitPort) throw new TypeError('ReviewWorkflowService requires gitPort');
    if (!reviewerPort) throw new TypeError('ReviewWorkflowService requires reviewerPort');
    if (!reportStorePort) throw new TypeError('ReviewWorkflowService requires reportStorePort');

    this.#gitPort = gitPort;
    this.#reviewerPort = reviewerPort;
    this.#reportStorePort = reportStorePort;
    this.#clock = clock;
    this.#logger = logger;
  }

  /**
   * Executes the complete review lifecycle.
   *
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<ReviewExecutionResult>}
   */
  async execute({ cwd = process.cwd() } = {}) {
    const repoRoot = (await this.#gitPort.getRepoRoot(cwd)).trim();
    const diff = await this.#gitPort.getStagedDiff(repoRoot);

    if (diff.isEmpty()) {
      return ReviewExecutionResult.skipped();
    }

    const prompt = ReviewPrompt.forDiff(diff);
    const execResult = await this.#reviewerPort.executeReview({
      prompt,
      cwd: repoRoot,
    });

    const combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;
    const modelsTried = execResult.modelsTried;

    const { verdict, envelope } = ReviewRejectionEnvelope.evaluate({
      output: combinedOutput,
      diffIdentity: diff,
      processStatus: execResult.status,
      processError: execResult.stderr,
    });

    const report = new ReviewReport({
      diffIdentity: diff,
      verdict,
      rawOutput: combinedOutput,
      modelsTried,
      envelope,
      timestamp: this.#clock(),
    });

    const reportPath = await this.#reportStorePort.saveReport(repoRoot, report);

    if (verdict.isPass()) {
      this.#logger.log(`reviewer-kit PASS: ${reportPath}\n`);
      return ReviewExecutionResult.pass(reportPath, verdict.value, modelsTried);
    }

    this.#logger.error(`reviewer-kit BLOCK: ${reportPath}\n`);
    this.#logger.error(`REVIEW_REJECTION_REPORT=${reportPath}\n`);

    return ReviewExecutionResult.block(reportPath, combinedOutput.trim(), modelsTried, envelope);
  }
}
