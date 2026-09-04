import { spawnSync } from 'node:child_process';
import { ReviewerPort } from '../application/ports.mjs';

/**
 * Infrastructure adapter running headless OMP CLI reviews.
 */
export class OmpCliReviewerAdapter extends ReviewerPort {
  #runner;
  #defaultTimeoutMs;

  /**
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number) => { status: number, stdout?: string, stderr?: string },
   *   defaultTimeoutMs?: number
   * }} [options]
   */
  constructor({ runner, defaultTimeoutMs = 180_000 } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Standard OMP CLI runner.
   *
   * @param {string} prompt
   * @param {string} cwd
   * @param {number} [timeout]
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  static defaultRunner(prompt, cwd, timeout) {
    const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
    const commandArgs = ['-p', '--model', '@slow', '--no-session'];
    const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
    const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
    const args = isWindowsWrapper
      ? ['/d', '/c', 'call', command, ...commandArgs]
      : commandArgs;

    const result = spawnSync(executable, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      input: prompt,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeout && timeout > 0 ? timeout : undefined,
    });

    const hasTimedOut = result.error && result.error.code === 'ETIMEDOUT';
    const stderr = result.error
      ? `${result.error.message || result.error}\n${result.stderr ?? ''}`
      : (result.stderr ?? '');

    return {
      status: result.error ? 1 : (result.status ?? 1),
      stdout: result.stdout ?? '',
      stderr: hasTimedOut ? `Review timed out after ${timeout}ms\n${stderr}` : stderr,
    };
  }

  /**
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string,
   *   timeoutMs?: number
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, combined: string }>}
   */
  async executeReview({ prompt, cwd, timeoutMs }) {
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const timeout = timeoutMs ?? this.#defaultTimeoutMs;
    const result = this.#runner(promptText, cwd, timeout);

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = `${stdout}\n${stderr}`;

    return {
      status: result.status ?? 1,
      stdout,
      stderr,
      combined,
    };
  }
}
