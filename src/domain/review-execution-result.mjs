/**
 * Value Object representing the final outcome of the review workflow execution.
 */
export class ReviewExecutionResult {
  #exitCode;
  #skipped;
  #verdict;
  #reportPath;
  #details;

  /**
   * @param {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   details?: string
   * }} params
   */
  constructor({ exitCode, skipped, verdict, reportPath, details }) {
    this.#exitCode = exitCode;
    this.#skipped = skipped;
    this.#verdict = verdict;
    this.#reportPath = reportPath;
    this.#details = details;
  }

  /**
   * Factory for clean commits with no staged modifications.
   *
   * @returns {ReviewExecutionResult}
   */
  static skipped() {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: true,
    });
  }

  /**
   * Factory for approved changes.
   *
   * @param {string} reportPath
   * @param {'PASS'} [verdict='PASS']
   * @returns {ReviewExecutionResult}
   */
  static pass(reportPath, verdict = 'PASS') {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: false,
      verdict,
      reportPath,
    });
  }

  /**
   * Factory for rejected changes.
   *
   * @param {string} [reportPath]
   * @param {string} [details]
   * @returns {ReviewExecutionResult}
   */
  static block(reportPath, details = '') {
    return new ReviewExecutionResult({
      exitCode: 1,
      skipped: false,
      verdict: 'BLOCK',
      reportPath,
      details,
    });
  }

  get exitCode() {
    return this.#exitCode;
  }

  get skipped() {
    return this.#skipped;
  }

  get verdict() {
    return this.#verdict;
  }

  get reportPath() {
    return this.#reportPath;
  }

  get details() {
    return this.#details;
  }

  /**
   * Plain object representation for backward-compatible consumption.
   *
   * @returns {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string
   * }}
   */
  toJSON() {
    const obj = {
      exitCode: this.#exitCode,
      skipped: this.#skipped,
    };
    if (this.#verdict !== undefined) obj.verdict = this.#verdict;
    if (this.#reportPath !== undefined) obj.reportPath = this.#reportPath;
    return obj;
  }
}
