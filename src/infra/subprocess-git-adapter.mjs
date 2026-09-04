import { spawnSync } from 'node:child_process';
import { GitPort } from '../application/ports.mjs';
import { DiffIdentity } from '../domain/diff-identity.mjs';

/**
 * Infrastructure adapter executing Git via child processes.
 */
export class SubprocessGitAdapter extends GitPort {
  #runner;

  /**
   * @param {(args: string[], cwd: string) => Buffer} [runner]
   */
  constructor(runner) {
    super();
    this.#runner = runner ?? SubprocessGitAdapter.defaultRunner;
  }

  /**
   * Standard Git CLI runner using spawnSync.
   *
   * @param {string[]} args
   * @param {string} cwd
   * @returns {Buffer}
   */
  static defaultRunner(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: null, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr ?? Buffer.from('git command failed')).toString().trim());
    }
    return result.stdout ?? Buffer.alloc(0);
  }

  /**
   * @param {string} cwd
   * @returns {Promise<string>|string}
   */
  getRepoRoot(cwd) {
    const output = this.#runner(['rev-parse', '--show-toplevel'], cwd);
    return output.toString('utf8').trim();
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<DiffIdentity>|DiffIdentity}
   */
  getStagedDiff(repoRoot) {
    const output = this.#runner(['diff', '--cached', '--binary', '--no-ext-diff', '--'], repoRoot);
    return DiffIdentity.fromBuffer(output);
  }
}
