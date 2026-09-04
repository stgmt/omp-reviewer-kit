/**
 * @typedef {import('../domain/diff-identity.mjs').DiffIdentity} DiffIdentity
 * @typedef {import('../domain/review-prompt.mjs').ReviewPrompt} ReviewPrompt
 * @typedef {import('../domain/review-report.mjs').ReviewReport} ReviewReport
 */

/**
 * Port representing Git VCS operations.
 *
 * @interface
 */
export class GitPort {
  /**
   * Resolves top-level repository directory.
   *
   * @param {string} cwd
   * @returns {Promise<string>|string}
   */
  getRepoRoot(cwd) {
    throw new Error('GitPort.getRepoRoot must be implemented');
  }

  /**
   * Captures strictly staged changes as a DiffIdentity.
   *
   * @param {string} repoRoot
   * @returns {Promise<DiffIdentity>|DiffIdentity}
   */
  getStagedDiff(repoRoot) {
    throw new Error('GitPort.getStagedDiff must be implemented');
  }
}

/**
 * Port representing the headless OMP review execution engine.
 *
 * @interface
 */
export class ReviewerPort {
  /**
   * Executes review prompt headlessly and returns process output.
   *
   * @param {{
   *   prompt: ReviewPrompt|string,
   *   cwd: string,
   *   timeoutMs?: number
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, combined: string }>|{ status: number, stdout: string, stderr: string, combined: string }}
   */
  executeReview(params) {
    throw new Error('ReviewerPort.executeReview must be implemented');
  }
}

/**
 * Port representing the audit report storage engine.
 *
 * @interface
 */
export class ReportStorePort {
  /**
   * Persists a ReviewReport artifact to durable storage and returns its filesystem path.
   *
   * @param {string} repoRoot
   * @param {ReviewReport} report
   * @returns {Promise<string>|string}
   */
  saveReport(repoRoot, report) {
    throw new Error('ReportStorePort.saveReport must be implemented');
  }
}
