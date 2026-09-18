import { spawn } from 'node:child_process';
import { GitPort } from '../application/ports.mjs';
import { DiffIdentity } from '../domain/diff-identity.mjs';
import { StagedSnapshot } from '../domain/staged-snapshot.mjs';

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

  /**
   * Captures the staged index via NUL-delimited Git index entries and blob IDs.
   * Only index content is read; the working tree is never consulted.
   *
   * @param {string} repoRoot
   * @returns {Promise<StagedSnapshot>}
   */
  async getHeadFile(repoRoot, filePath) {
    try {
      const buffer = await this.#runner(['cat-file', 'blob', `HEAD:${filePath}`], repoRoot);
      return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    } catch (error) {
      // Only a genuinely absent blob means "new file at HEAD": every other
      // failure (corrupt object store, missing HEAD, unreadable repo) must
      // propagate so the reverted snapshot is skipped rather than silently
      // dropping the file.
      const message = String(error?.message ?? error);
      if (/Not a valid object name|does not exist|exists on disk, but not in/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  async getSnapshot(repoRoot) {
    const listing = await this.#runner(['ls-files', '--cached', '-z', '--stage', '--'], repoRoot);
    const entries = listing.toString('utf8').split('\0').filter(Boolean);
    const files = [];

    for (const entry of entries) {
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error('git ls-files returned an invalid staged entry');
      const metadata = entry.slice(0, separator).split(' ');
      const mode = metadata[0];
      const stage = metadata[2];
      if (stage !== '0') throw new Error('Cannot review an unmerged staged index');
      if (mode === '160000') continue;
      const objectId = metadata[1];
      const stagedPath = entry.slice(separator + 1);
      const content = await this.#runner(['cat-file', 'blob', objectId], repoRoot);
      files.push({ path: stagedPath, content, mode });
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return new StagedSnapshot(files);
  }
}
