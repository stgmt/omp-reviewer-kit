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
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'Invoke the task with only the supported name, agent, and task fields; omit model, outputSchema, schemaMode, and isolated so the reviewer agent owns its declared schema and model roles.',
      'After the task returns, reproduce its complete report verbatim; if the result says it was truncated or provides an agent URI, read that URI first, and never summarize or omit a rejection envelope.',
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
