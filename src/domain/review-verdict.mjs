const RESULT_LINE_RE = /^REVIEW_RESULT=(PASS|BLOCK)$/gm;

/**
 * Domain Value Object encapsulating the review verdict and fail-closed validation rules.
 */
export class ReviewVerdict {
  static PASS = 'PASS';
  static BLOCK = 'BLOCK';

  #value;
  #reason;
  #rawOutput;

  /**
   * @param {'PASS'|'BLOCK'} value
   * @param {{ reason?: string, rawOutput?: string }} [meta]
   */
  constructor(value, { reason = '', rawOutput = '' } = {}) {
    if (value !== ReviewVerdict.PASS && value !== ReviewVerdict.BLOCK) {
      throw new Error(`Invalid ReviewVerdict value: ${value}`);
    }
    this.#value = value;
    this.#reason = reason;
    this.#rawOutput = rawOutput;
  }

  /**
   * Evaluates raw reviewer process output and derives a verdict.
   * Fail-closed invariant: only exactly one REVIEW_RESULT=PASS line yields a PASS verdict.
   * Any missing, multiple, or malformed markers strictly yield BLOCK.
   *
   * @param {string} output
   * @returns {ReviewVerdict}
   */
  static fromOutput(output) {
    if (typeof output !== 'string') {
      return new ReviewVerdict(ReviewVerdict.BLOCK, {
        reason: 'non_string_output',
        rawOutput: String(output ?? ''),
      });
    }

    const matches = [...output.matchAll(RESULT_LINE_RE)];
    if (matches.length === 1) {
      const parsedValue = matches[0][1];
      return new ReviewVerdict(parsedValue, {
        reason: parsedValue === ReviewVerdict.PASS ? 'verified' : 'explicit_block',
        rawOutput: output,
      });
    }

    if (matches.length === 0) {
      return new ReviewVerdict(ReviewVerdict.BLOCK, {
        reason: 'missing_verdict_marker',
        rawOutput: output,
      });
    }

    return new ReviewVerdict(ReviewVerdict.BLOCK, {
      reason: 'multiple_verdict_markers',
      rawOutput: output,
    });
  }

  /**
   * Factory for process or execution failures.
   *
   * @param {string} errorDetails
   * @returns {ReviewVerdict}
   */
  static blockDueToFailure(errorDetails) {
    return new ReviewVerdict(ReviewVerdict.BLOCK, {
      reason: 'execution_failure',
      rawOutput: errorDetails,
    });
  }

  /**
   * @returns {boolean}
   */
  isPass() {
    return this.#value === ReviewVerdict.PASS;
  }

  /**
   * @returns {boolean}
   */
  isBlock() {
    return this.#value === ReviewVerdict.BLOCK;
  }

  /**
   * @returns {'PASS'|'BLOCK'}
   */
  get value() {
    return this.#value;
  }

  /**
   * @returns {string}
   */
  get reason() {
    return this.#reason;
  }

  /**
   * @returns {string}
   */
  get rawOutput() {
    return this.#rawOutput;
  }
}
