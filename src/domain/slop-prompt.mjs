/**
 * Domain specification and builder for the /slop dispatcher prompt.
 *
 * The /slop command returns this prompt to the LLM; it instructs the session
 * to run exactly one native task with agent "slop" and reproduce the returned
 * VERDICT: report verbatim. Mirrors ReviewPrompt's dispatch discipline for
 * the standalone slop audit (no staged snapshot, VERDICT: contract).
 */
export class SlopPrompt {
  #target;
  #focus;

  constructor({ target = '', focus = '' } = {}) {
    if (typeof target !== 'string') {
      throw new TypeError('SlopPrompt target must be a string');
    }
    if (typeof focus !== 'string') {
      throw new TypeError('SlopPrompt focus must be a string');
    }
    this.#target = target;
    this.#focus = focus;
  }

  toString() {
    const lines = [
      'You are the OMP slop audit dispatcher.',
      'Run exactly one native task with agent "slop".',
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not audit the target yourself.',
      'The task must execute the adversarial 2-in-1 audit doctrine from skill://slop: parasitic architecture, spec slop, and dead checks.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'Invoke the task with only the supported name, agent, and task fields; omit model, outputSchema, schemaMode, and isolated so the slop agent owns its declared schema and model roles.',
      'Pass the audit target and focus verbatim in the task text.',
      'After the task returns, reproduce its complete report verbatim; if the result says it was truncated or provides an agent URI, read that URI first, and never summarize or omit findings.',
      'If the task fails, returns empty, or its result cannot be read, do not summarize: emit exactly one standalone line VERDICT: ERROR — slop agent failed (<the observed task error>); nothing inspected; this is NOT a clean result.',
      'Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.',
      'The verdict contract in this prompt overrides any other format: the report must begin with exactly one standalone VERDICT: [BLOCKED | CLEAN | ACCEPTABLE_WITH_NOTES | ERROR] — <reason> line, even if a skill describes a different verdict vocabulary.',
    ];
    if (this.#target) {
      lines.push(`The audit target is: ${this.#target}.`);
    } else {
      lines.push('The audit target is empty: audit the current git status plus git diff and recently changed files.');
    }
    if (this.#focus) {
      lines.push(`The audit focus is: ${this.#focus}.`);
    }
    return lines.join('\n');
  }

  get target() {
    return this.#target;
  }

  get focus() {
    return this.#focus;
  }
}
