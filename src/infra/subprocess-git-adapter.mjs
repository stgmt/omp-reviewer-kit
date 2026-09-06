import { spawn } from 'node:child_process';
import { GitPort } from '../application/ports.mjs';
import { DiffIdentity } from '../domain/diff-identity.mjs';

/**
 * Infrastructure adapter executing Git via child processes.
 *
 * Uses streaming async `spawn` (no `maxBuffer`) so large staged diffs
 * cannot fail with ENOBUFS the way `spawnSync` does by default.
 */
export class SubprocessGitAdapter extends GitPort {
  #runner;

  /**
   * @param {(args: string[], cwd: string) => Buffer|Promise<Buffer>} [runner]
   */
  constructor(runner) {
    super();
    this.#runner = runner ?? SubprocessGitAdapter.defaultRunner;
  }

  /**
   * Standard Git CLI runner using streaming async spawn.
   *
   * @param {string[]} args
   * @param {string} cwd
   * @returns {Promise<Buffer>}
   */
  static defaultRunner(args, cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const chunks = [];
      const errChunks = [];
      proc.stdout.on('data', (chunk) => chunks.push(chunk));
      proc.stderr.on('data', (chunk) => errChunks.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(errChunks).toString('utf8').trim();
          reject(new Error(detail || `git ${args[0] ?? 'command'} failed with exit ${code ?? 'unknown'}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /**
   * @param {string} cwd
   * @returns {Promise<string>}
   */
  async getRepoRoot(cwd) {
    const output = await this.#runner(['rev-parse', '--show-toplevel'], cwd);
    return output.toString('utf8').trim();
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<DiffIdentity>}
   */
  async getStagedDiff(repoRoot) {
    const output = await this.#runner(['diff', '--cached', '--binary', '--no-ext-diff', '--'], repoRoot);
    return DiffIdentity.fromBuffer(output);
  }
}
