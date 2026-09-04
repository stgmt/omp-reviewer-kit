import { DiffIdentity } from '../domain/diff-identity.mjs';
import { ReviewVerdict } from '../domain/review-verdict.mjs';
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
   * @param {{ cwd?: string, timeoutMs?: number }} [options]
   * @returns {Promise<ReviewExecutionResult>}
   */
  async execute({ cwd = process.cwd(), timeoutMs } = {}) {
    const repoRoot = (await this.#gitPort.getRepoRoot(cwd)).trim();
    const diff = await this.#gitPort.getStagedDiff(repoRoot);

    if (diff.isEmpty()) {
      return ReviewExecutionResult.skipped();
    }

    const prompt = ReviewPrompt.forDiff(diff);
    const execResult = await this.#reviewerPort.executeReview({
      prompt,
      cwd: repoRoot,
      timeoutMs,
    });

    const combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;

    const verdict = execResult.status === 0
      ? ReviewVerdict.fromOutput(combinedOutput)
      : ReviewVerdict.blockDueToFailure(execResult.stderr || 'reviewer process exited with non-zero status');

    const report = new ReviewReport({
      diffIdentity: diff,
      verdict,
      rawOutput: combinedOutput,
      timestamp: this.#clock(),
    });

    const reportPath = await this.#reportStorePort.saveReport(repoRoot, report);

    if (execResult.status === 0 && verdict.isPass()) {
      this.#logger.log(`reviewer-kit PASS: ${reportPath}\n`);
      return ReviewExecutionResult.pass(reportPath, verdict.value);
    }

    this.#logger.error(`reviewer-kit BLOCK: ${reportPath}\n`);
    if (combinedOutput.trim()) {
      this.#logger.error(`${combinedOutput.trim()}\n`);
    }

    return ReviewExecutionResult.block(reportPath, combinedOutput.trim());
  }
}
