import { DiffIdentity } from './diff-identity.mjs';
import { ReviewVerdict } from './review-verdict.mjs';
import { ReviewRejectionEnvelope } from './review-rejection-envelope.mjs';

/**
 * Domain Entity representing an audit report artifact.
 */
export class ReviewReport {
  #diffHash;
  #verdict;
  #rawOutput;
  #modelsTried;
  #verifiedOk;
  #envelope;
  #timestamp;

  /**
   * @param {{
   *   diffIdentity: DiffIdentity|string,
   *   verdict: ReviewVerdict|string,
   *   rawOutput: string,
   *   modelsTried?: string[],
   *   verifiedOk?: string[],
   *   envelope?: ReviewRejectionEnvelope|null,
   *   timestamp?: Date
   * }} params
   */
  constructor({
    diffIdentity,
    verdict,
    rawOutput = '',
    modelsTried,
    verifiedOk = [],
    envelope = null,
    timestamp = new Date(),
  }) {
    this.#diffHash = diffIdentity instanceof DiffIdentity ? diffIdentity.hash : String(diffIdentity);
    this.#verdict = verdict instanceof ReviewVerdict ? verdict.value : String(verdict);
    this.#rawOutput = rawOutput;
    this.#modelsTried = Array.isArray(modelsTried) ? modelsTried.filter((m) => typeof m === 'string') : undefined;
    if (!Array.isArray(verifiedOk) || verifiedOk.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      throw new TypeError('verifiedOk must be an array of non-empty strings');
    }
    this.#verifiedOk = Object.freeze(verifiedOk.map((item) => item.trim()));
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
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
    const lines = [
      '# OMP Review Kit commit review',
      '',
      `- staged diff hash: ${this.#diffHash}`,
      `- result: ${this.#verdict}`,
    ];
    if (this.#modelsTried && this.#modelsTried.length > 0) {
      lines.push(`- reviewer models tried: ${this.#modelsTried.join(', ')}`);
    }
    if (this.#envelope) {
      lines.push('', '## Normalized rejection envelope', '', '```json', this.#envelope.toString(), '```');
    }

    const rawOutput = this.#rawOutput.trim();
    if (this.#verifiedOk.length > 0 && !/^### Verified-OK\s*$/m.test(rawOutput)) {
      lines.push('', '### Verified-OK', ...this.#verifiedOk.map((item) => `- ${item}`));
    }
    lines.push('', rawOutput, '');
    return lines.join('\n');
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

  get modelsTried() {
    return this.#modelsTried;
  }

  get verifiedOk() {
    return this.#verifiedOk;
  }

  get envelope() {
    return this.#envelope;
  }

  get timestamp() {
    return this.#timestamp;
  }
}
