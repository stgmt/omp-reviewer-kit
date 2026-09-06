import { ReviewRejectionEnvelope } from './review-rejection-envelope.mjs';

/**
 * Value Object representing the final outcome of the review workflow execution.
 */
export class ReviewExecutionResult {
  #exitCode;
  #skipped;
  #verdict;
  #reportPath;
  #details;
  #modelsTried;
  #envelope;

  /**
   * @param {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   details?: string,
   *   modelsTried?: string[],
   *   envelope?: ReviewRejectionEnvelope|null
   * }} params
   */
  constructor({ exitCode, skipped, verdict, reportPath, details, modelsTried, envelope = null }) {
    this.#exitCode = exitCode;
    this.#skipped = skipped;
    this.#verdict = verdict;
    this.#reportPath = reportPath;
    this.#details = details;
    if (modelsTried !== undefined && (!Array.isArray(modelsTried) || modelsTried.some((model) => typeof model !== 'string'))) {
      throw new TypeError('modelsTried must be an array of strings');
    }
    this.#modelsTried = modelsTried;
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
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
   * @param {string[]} [modelsTried]
   * @returns {ReviewExecutionResult}
   */
  static pass(reportPath, verdict = 'PASS', modelsTried) {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: false,
      verdict,
      reportPath,
      modelsTried,
    });
  }

  /**
   * Factory for rejected changes.
   *
   * @param {string} [reportPath]
   * @param {string} [details]
   * @param {string[]} [modelsTried]
   * @param {ReviewRejectionEnvelope} envelope
   * @returns {ReviewExecutionResult}
   */
  static block(reportPath, details = '', modelsTried, envelope) {
    return new ReviewExecutionResult({
      exitCode: 1,
      skipped: false,
      verdict: 'BLOCK',
      reportPath,
      details,
      modelsTried,
      envelope,
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

  get modelsTried() {
    return this.#modelsTried;
  }

  get envelope() {
    return this.#envelope;
  }

  /**
   * Plain object representation for backward-compatible consumption.
   *
   * @returns {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   details?: string,
   *   modelsTried?: string[],
   *   envelope?: object
   * }}
   */
  toJSON() {
    const obj = {
      exitCode: this.#exitCode,
      skipped: this.#skipped,
    };
    if (this.#verdict !== undefined) obj.verdict = this.#verdict;
    if (this.#reportPath !== undefined) obj.reportPath = this.#reportPath;
    if (this.#details !== undefined) obj.details = this.#details;
    if (this.#modelsTried !== undefined && this.#modelsTried.length > 0) {
      obj.modelsTried = this.#modelsTried;
    }
    if (this.#envelope) obj.envelope = this.#envelope.toJSON();
    return obj;
  }
}
