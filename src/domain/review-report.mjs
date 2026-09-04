import { DiffIdentity } from './diff-identity.mjs';
import { ReviewVerdict } from './review-verdict.mjs';

/**
 * Domain Entity representing an audit report artifact.
 */
export class ReviewReport {
  #diffHash;
  #verdict;
  #rawOutput;
  #timestamp;

  /**
   * @param {{
   *   diffIdentity: DiffIdentity|string,
   *   verdict: ReviewVerdict|string,
   *   rawOutput: string,
   *   timestamp?: Date
   * }} params
   */
  constructor({ diffIdentity, verdict, rawOutput = '', timestamp = new Date() }) {
    this.#diffHash = diffIdentity instanceof DiffIdentity ? diffIdentity.hash : String(diffIdentity);
    this.#verdict = verdict instanceof ReviewVerdict ? verdict.value : String(verdict);
    this.#rawOutput = rawOutput;
    this.#timestamp = timestamp instanceof Date ? timestamp : new Date(timestamp);
  }

  /**
   * Formats ISO timestamp into safe filename segment.
   *
   * @param {Date} date
   * @returns {string}
   */
  static formatTimestamp(date) {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Computes standardized report filename.
   *
   * @returns {string}
   */
  get filename() {
    const stamp = ReviewReport.formatTimestamp(this.#timestamp);
    return `${stamp}-${this.#diffHash}.md`;
  }

  /**
   * Renders the complete markdown audit report.
   *
   * @returns {string}
   */
  toMarkdown() {
    return [
      '# OMP Review Kit commit review',
      '',
      `- staged diff hash: ${this.#diffHash}`,
      `- result: ${this.#verdict}`,
      '',
      this.#rawOutput.trim(),
      '',
    ].join('\n');
  }

  get diffHash() {
    return this.#diffHash;
  }

  get verdict() {
    return this.#verdict;
  }

  get rawOutput() {
    return this.#rawOutput;
  }

  get timestamp() {
    return this.#timestamp;
  }
}
