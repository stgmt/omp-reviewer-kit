import { spawn } from 'node:child_process';
import { GitPort } from '../application/ports.mjs';
import { DiffIdentity } from '../domain/diff-identity.mjs';
import { StagedSnapshot } from '../domain/staged-snapshot.mjs';
import { VENDORED_RUNNER_MIRROR } from './vendored-kit-files.mjs';

/**
 * Infrastructure adapter executing Git via child processes.
 *
 * Uses streaming async `spawn` (no `maxBuffer`) so large staged diffs
 * cannot fail with ENOBUFS the way `spawnSync` does by default.
 */
export class SubprocessGitAdapter extends GitPort {
  #runner;
  #vendoredFiles;

  /**
   * @param {(args: string[], cwd: string) => Buffer|Promise<Buffer>} [runner]
   * @param {{ vendoredFiles?: () => Promise<Map<string, string>> }} [options]
   */
  constructor(runner, { vendoredFiles } = {}) {
    super();
    this.#runner = runner ?? SubprocessGitAdapter.defaultRunner;
    this.#vendoredFiles = vendoredFiles;
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
    const excluded = await this.#identicalVendoredPaths(repoRoot);
    // Pinned: the review diff must not depend on the committer's git configuration.
    // diff.mnemonicPrefix renames the a/ and b/ prefixes, color.diff adds escape codes.
    const args = ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--'];
    if (excluded.length > 0) args.push('.', ...excluded.map((p) => `:(exclude,literal)${p}`));
    const output = await this.#runner(args, repoRoot);
    return DiffIdentity.fromBuffer(output, { excludedPaths: excluded });
  }

  /**
   * Staged vendored kit files (runner, hook) that are byte-identical to the
   * installed kit's canonical copy: they are the review plugin, not the
   * committer's work, so the review diff leaves them out. In the kit repository
   * itself the self-hosted runner is a byte-identical mirror of the staged
   * `scripts/run-review.mjs`, which stays in review, so the mirror is left out
   * too. Any doubt (no canonical copy, unreadable blob, different bytes) keeps
   * the file in review.
   *
   * @param {string} repoRoot
   * @returns {Promise<string[]>}
   */
  async #identicalVendoredPaths(repoRoot) {
    let canonical = new Map();
    if (typeof this.#vendoredFiles === 'function') {
      try {
        const loaded = await this.#vendoredFiles();
        if (loaded instanceof Map) canonical = loaded;
      } catch {
        canonical = new Map();
      }
    }
    const fields = (await this.#runner(['diff', '--cached', '--raw', '--no-renames', '-z', '--'], repoRoot))
      .toString('utf8').split('\0');
    const normalize = (text) => String(text).replace(/\r\n/g, '\n');
    const regularModes = new Set(['100644', '100755']);
    const stagedText = async (name) => (await this.#runner(['show', `:${name}`], repoRoot)).toString('utf8');
    const identical = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(fields[i]);
      const name = fields[i + 1];
      if (!meta) continue;
      const isMirror = name === VENDORED_RUNNER_MIRROR.target;
      if (!canonical.has(name) && !isMirror) continue;
      // A mode change (the hook losing its executable bit, a symlink in place
      // of the file) changes behaviour even when the bytes are canonical.
      const [, oldMode, newMode, status] = meta;
      const modeOk = status === 'M' ? oldMode === newMode : status === 'A' && regularModes.has(newMode);
      if (!modeOk) continue;
      try {
        const staged = normalize(await stagedText(name));
        if (canonical.has(name) && staged === normalize(canonical.get(name))) {
          identical.push(name);
        } else if (isMirror && staged === normalize(await stagedText(VENDORED_RUNNER_MIRROR.source))) {
          identical.push(name);
        }
      } catch {
        // unreadable staged blob stays in review
      }
    }
    return identical;
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<string|null>}
   */
  async getIndexTree(repoRoot) {
    try {
      const id = (await this.#runner(['write-tree'], repoRoot)).toString('utf8').trim();
      return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * HEAD commit id, or null on an unborn branch. The commit under review is
   * HEAD's child, so this is the parent that `review-progress --commit` matches on.
   *
   * @param {string} repoRoot
   * @returns {Promise<string|null>}
   */
  async getHeadSha(repoRoot) {
    try {
      const id = (await this.#runner(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot)).toString('utf8').trim();
      return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
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
