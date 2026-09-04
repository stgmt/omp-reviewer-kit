import { DiffIdentity } from './diff-identity.mjs';

/**
 * Domain specification and builder for reviewer agent prompt instructions.
 */
export class ReviewPrompt {
  #diffHash;

  /**
   * @param {string} diffHash
   */
  constructor(diffHash) {
    if (!diffHash || typeof diffHash !== 'string') {
      throw new TypeError('ReviewPrompt requires a non-empty diff hash string');
    }
    this.#diffHash = diffHash;
  }

  /**
   * @param {DiffIdentity|string} target
   * @returns {ReviewPrompt}
   */
  static forDiff(target) {
    const hash = target instanceof DiffIdentity ? target.hash : target;
    return new ReviewPrompt(hash);
  }

  /**
   * Generates the immutable dispatch prompt text.
   *
   * @returns {string}
   */
  toString() {
    return [
      'You are the OMP headless review dispatcher.',
      'Run exactly one native task with agent "reviewer-kit".',
      'Do not review the change yourself and do not run any other agent.',
      'The task must inspect only the current staged Git change.',
      'The task must read skill://reality-first-review and then only relevant project review skills discovered by OMP.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'The task must return its complete report and finish with exactly REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK.',
      `The staged diff hash for this hook invocation is ${this.#diffHash}.`,
    ].join('\n');
  }

  /**
   * @returns {string}
   */
  get diffHash() {
    return this.#diffHash;
  }
}
