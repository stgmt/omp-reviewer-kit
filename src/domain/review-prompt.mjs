import { DiffIdentity } from './diff-identity.mjs';

/**
 * Domain specification and builder for reviewer agent prompt instructions.
 */
export class ReviewPrompt {
  #snapshotDir;
  #diffHash;
  #changedPaths;
  #suspicionMapText;
  #executionEvidenceText;
  #reemitOutput;

  constructor(diffHash, snapshotDir = '', changedPaths = [], extras = {}) {
    if (!diffHash || typeof diffHash !== 'string') {
      throw new TypeError('ReviewPrompt requires a non-empty diff hash string');
    }
    if (typeof snapshotDir !== 'string') {
      throw new TypeError('ReviewPrompt snapshotDir must be a string');
    }
    if (!Array.isArray(changedPaths)) {
      throw new TypeError('ReviewPrompt changedPaths must be an array');
    }
    this.#diffHash = diffHash;
    this.#snapshotDir = snapshotDir;
    this.#changedPaths = changedPaths;
    this.#suspicionMapText = typeof extras?.suspicionMapText === 'string' ? extras.suspicionMapText : '';
    this.#executionEvidenceText = typeof extras?.executionEvidenceText === 'string' ? extras.executionEvidenceText : '';
  }

  static forDiff(target, snapshotDir = '', changedPaths = [], extras = {}) {
    const hash = target instanceof DiffIdentity ? target.hash : target;
    const paths = target instanceof DiffIdentity ? target.changedPaths : changedPaths;
    return new ReviewPrompt(hash, snapshotDir, paths, extras);
  }

  /**
   * Builds the bounded verbatim re-emit re-prompt used to recover a completed
   * review whose output carried no standalone REVIEW_RESULT marker.
   *
   * @param {string} originalOutput
   * @returns {ReviewPrompt}
   */
  static forReemit(originalOutput) {
    const prompt = new ReviewPrompt('verbatim-reemit');
    prompt.#reemitOutput = String(originalOutput ?? '');
    return prompt;
  }

  toString() {
    if (this.#reemitOutput !== undefined) return this.#toReemitString();
    const lines = [
      'You are the OMP headless review dispatcher.',
      'Run exactly one native task with agent "reviewer-kit".',
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',
      'The task must run both correctness and security risk lanes; the correctness lane must inspect focused tests and YAGNI only when a concrete reachable P1/P2 impact is proven.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'Invoke the task with only the supported name, agent, and task fields; omit model, outputSchema, schemaMode, and isolated so the reviewer agent owns its declared schema and model roles.',
      'After the task returns, reproduce its complete report verbatim; if the result says it was truncated or provides an agent URI, read that URI first, and never summarize or omit a rejection envelope.',
      'If the task fails, returns empty, or its result cannot be read, do not summarize: emit exactly one review_failure envelope — the line REVIEW_REJECTION_ENVELOPE_BEGIN, then one JSON object {"schema":"review-rejection-envelope@1","kind":"review_failure","diff_hash":"<the staged diff hash from this prompt>","findings":[],"failure":{"code":"execution_failure","message":"<the observed task error>"}}, then REVIEW_REJECTION_ENVELOPE_END, then REVIEW_RESULT=BLOCK on its own line.',
      'Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.',
      'The verdict contract in this prompt overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line, even if a skill describes a different verdict vocabulary.',
    ];
    if (this.#snapshotDir) {
      lines.push(
        `The staged snapshot directory is ${this.#snapshotDir}.`,
        `The complete staged diff is materialized at ${this.#snapshotDir}/.review/diff.patch and the changed-file list at ${this.#snapshotDir}/.review/changed-files.txt. Read them as files; do not run git diff or git show to obtain review content.`,
        'Read every source file from that staged snapshot directory, never from the working tree. Use the repository only for read-only Git metadata and project skill discovery.',
      );
    }
    if (this.#changedPaths.length > 0) {
      lines.push(
        `The changed paths for this review are: ${this.#changedPaths.join(', ')}.`,
        'Pass these paths to the context scout in its task text so it does not re-derive them from the diff.',
      );
    }
    if (this.#suspicionMapText) {
      lines.push('', this.#suspicionMapText);
    }
    if (this.#executionEvidenceText) {
      lines.push('', this.#executionEvidenceText);
    }
    lines.push(`The staged diff hash for this hook invocation is ${this.#diffHash}.`);
    return lines.join('\n');
  }

  #toReemitString() {
    return 'Reproduce the following review report verbatim as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it. The verdict contract overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line, even if the input describes a different verdict vocabulary.\n\n---ORIGINAL OUTPUT---\n' + this.#reemitOutput;
  }

  get diffHash() {
    return this.#diffHash;
  }

  get snapshotDir() {
    return this.#snapshotDir;
  }

  get changedPaths() {
    return [...this.#changedPaths];
  }

  get suspicionMapText() {
    return this.#suspicionMapText;
  }

  get executionEvidenceText() {
    return this.#executionEvidenceText;
  }
}
