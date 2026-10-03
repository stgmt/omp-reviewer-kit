import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RoundStorePort } from '../application/ports.mjs';

const ROUND_FILE = 'last-block.json';

/**
 * Infrastructure adapter keeping the single most recent BLOCKed round
 * (findings plus the diff text) so the next review of the same repository can
 * verify those findings and restrict new P2 candidates to the round delta.
 */
export class FileSystemRoundStoreAdapter extends RoundStorePort {
  #relativeDir;

  constructor({ relativeDir = path.join('audit-reports', 'commit-reviews') } = {}) {
    super();
    this.#relativeDir = relativeDir;
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<object|null>}
   */
  async load(repoRoot) {
    try {
      return JSON.parse(await readFile(path.join(repoRoot, this.#relativeDir, ROUND_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * @param {string} repoRoot
   * @param {object} record
   * @returns {Promise<void>}
   */
  async save(repoRoot, record) {
    const dir = path.join(repoRoot, this.#relativeDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ROUND_FILE), `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<void>}
   */
  async clear(repoRoot) {
    await rm(path.join(repoRoot, this.#relativeDir, ROUND_FILE), { force: true });
  }
}
