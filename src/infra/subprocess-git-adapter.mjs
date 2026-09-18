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
   * @param {Buffer} [input] - when provided, piped to the child's stdin
   * @returns {Promise<Buffer>}
   */
  static defaultRunner(args, cwd, input) {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
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
      if (input) {
        proc.stdin.on('error', () => {});
        proc.stdin.end(input);
      }
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
    const pending = [];

    for (const entry of entries) {
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error('git ls-files returned an invalid staged entry');
      const metadata = entry.slice(0, separator).split(' ');
      const mode = metadata[0];
      const stage = metadata[2];
      if (stage !== '0') throw new Error('Cannot review an unmerged staged index');
      if (mode === '160000') continue;
      pending.push({
        path: entry.slice(separator + 1),
        mode,
        objectId: metadata[1],
      });
    }

    // One `cat-file --batch` process streams every blob: a per-file spawn
    // costs ~20-45ms each, which made every commit pay minutes on large
    // indexes and pushed users toward --no-verify.
    if (pending.length === 0) {
      return new StagedSnapshot([]);
    }
    const batchInput = Buffer.from(pending.map((f) => f.objectId).join('\n') + '\n', 'utf8');
    const batchOutput = await this.#runner(['cat-file', '--batch'], repoRoot, batchInput);
    const files = [];
    let offset = 0;
    for (const item of pending) {
      const headerEnd = batchOutput.indexOf(0x0a, offset);
      if (headerEnd < 0) throw new Error('git cat-file --batch returned a truncated stream');
      const header = batchOutput.toString('utf8', offset, headerEnd);
      const [headerId, headerType, headerSize] = header.split(' ');
      if (headerId !== item.objectId || headerType !== 'blob') {
        throw new Error(`git cat-file --batch returned ${header} for ${item.path}`);
      }
      const size = Number.parseInt(headerSize, 10);
      if (!Number.isInteger(size) || size < 0) {
        throw new Error(`git cat-file --batch returned an invalid size for ${item.path}`);
      }
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      if (contentEnd >= batchOutput.length || batchOutput[contentEnd] !== 0x0a) {
        throw new Error(`git cat-file --batch truncated the blob for ${item.path}`);
      }
      files.push({
        path: item.path,
        content: Buffer.from(batchOutput.subarray(contentStart, contentEnd)),
        mode: item.mode,
      });
      offset = contentEnd + 1;
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return new StagedSnapshot(files);
  }
}
