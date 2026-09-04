import { spawn } from 'node:child_process';
import { ReviewerPort } from '../application/ports.mjs';

/**
 * Infrastructure adapter running headless OMP CLI reviews.
 */
export class OmpCliReviewerAdapter extends ReviewerPort {
  #runner;
  #defaultTimeoutMs;

  /**
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   defaultTimeoutMs?: number
   * }} [options]
   */
  constructor({
    runner,
    defaultTimeoutMs = process.env.OMP_REVIEW_KIT_TIMEOUT_MS
      ? parseInt(process.env.OMP_REVIEW_KIT_TIMEOUT_MS, 10)
      : 600_000,
  } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Standard OMP CLI runner using async spawn to avoid pipe buffer deadlocks.
   *
   * @param {string} prompt
   * @param {string} cwd
   * @param {number} [timeout]
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  static defaultRunner(prompt, cwd, timeout) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const commandArgs = ['-p', '--model', '@slow', '--no-session'];
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const args = isWindowsWrapper
        ? ['/d', '/c', 'call', command, ...commandArgs]
        : commandArgs;

      const proc = spawn(executable, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer;

      if (timeout && timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
        }, timeout);
      }

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          status: timedOut ? 1 : (code ?? 1),
          stdout,
          stderr: timedOut ? `Review timed out after ${timeout}ms\n${stderr}` : stderr,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          status: 1,
          stdout,
          stderr: `${err.message || err}\n${stderr}`,
        });
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
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
    const result = await this.#runner(promptText, cwd, timeout);

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
