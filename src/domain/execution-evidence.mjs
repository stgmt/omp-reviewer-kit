/**
 * Value Object representing opt-in project test/check execution evidence.
 */
export class ExecutionEvidence {
  #command;
  #timeoutMs;
  #staged;
  #reverted;
  #revertedSkipReason;
  #warnings;

  constructor({
    command = '',
    timeoutMs = 600000,
    staged = null,
    reverted = null,
    revertedSkipReason = '',
    warnings = [],
  } = {}) {
    this.#command = command;
    this.#timeoutMs = timeoutMs;
    this.#staged = staged;
    this.#reverted = reverted;
    this.#revertedSkipReason = revertedSkipReason;
    this.#warnings = Object.freeze([...warnings]);
  }

  get command() {
    return this.#command;
  }

  get staged() {
    return this.#staged;
  }

  get reverted() {
    return this.#reverted;
  }

  get warnings() {
    return this.#warnings;
  }

  static tail(output, maxLines = 20) {
    if (!output || typeof output !== 'string') return '';
    const lines = output.trimEnd().split(/\r?\n/);
    if (lines.length <= maxLines) return lines.join('\n');
    return lines.slice(-maxLines).join('\n');
  }

  toPromptText() {
    const timeoutSec = Math.round(this.#timeoutMs / 1000);
    const lines = [
      'Execution evidence (opt-in, produced by the dispatcher before this review):',
      `- Command: \`${this.#command}\` (timeout ${timeoutSec}s)`,
    ];

    for (const warning of this.#warnings) {
      lines.push(`- Warning: ${warning}`);
    }

    if (!this.#staged) {
      lines.push('- Staged snapshot: not executed');
    } else if (!this.#staged.ok) {
      lines.push(`- Staged snapshot: unavailable (${this.#staged.error})`);
    } else {
      const durationSec = (this.#staged.durationMs / 1000).toFixed(1);
      lines.push(`- Staged snapshot: exit ${this.#staged.exitCode} in ${durationSec}s`);
      const combined = `${this.#staged.stdout ?? ''}\n${this.#staged.stderr ?? ''}`.trim();
      const tail = ExecutionEvidence.tail(combined);
      if (tail) {
        lines.push(`  tail: ${tail.replace(/\n/g, '\n  ')}`);
      }
    }

    if (this.#reverted && this.#reverted.ok !== undefined) {
      if (!this.#reverted.ok) {
        lines.push(`- Reverted snapshot: unavailable (${this.#reverted.error})`);
      } else {
        const durationSec = (this.#reverted.durationMs / 1000).toFixed(1);
        lines.push(`- Reverted snapshot (non-test staged changes reverted to HEAD): exit ${this.#reverted.exitCode} in ${durationSec}s`);
        const combined = `${this.#reverted.stdout ?? ''}\n${this.#reverted.stderr ?? ''}`.trim();
        const tail = ExecutionEvidence.tail(combined);
        if (tail) {
          lines.push(`  tail: ${tail.replace(/\n/g, '\n  ')}`);
        }
      }
    } else {
      const reason = this.#revertedSkipReason || (this.#staged && !this.#staged.ok ? 'staged execution unavailable' : 'skipped');
      lines.push(`- Reverted snapshot: skipped (${reason})`);
    }

    lines.push(
      'Interpretation (apply; do not re-derive):',
      '- staged pass + reverted fail => the staged tests prove the staged change (red proof achieved).',
      '- staged pass + reverted pass => the staged tests do not discriminate the staged change; raise a correctness candidate when test files changed.',
      "- staged fail + reverted pass => the staged change breaks the project's own gates; P1 correctness candidate.",
      '- staged fail + reverted fail => pre-existing failure; compare tails; do not attribute it to this change without evidence.',
      '- unavailable => execution evidence is absent; absence proves nothing.',
    );

    return lines.join('\n');
  }
}
