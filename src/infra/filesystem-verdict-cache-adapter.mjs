import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { VerdictCachePort } from '../application/ports.mjs';

const CACHE_SCHEMA = 'review-verdict-cache@1';
const CACHE_FILE = 'verdict-cache.jsonl';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Infrastructure adapter remembering PASS verdicts by (index tree, diff hash).
 * Only PASS is reusable: a BLOCK is always re-reviewed. A hit is honored only
 * when the referenced report still exists inside the repository and states the
 * same diff hash and `result: PASS`, so a stale or tampered index line fails closed
 * into a normal full review.
 */
export class FileSystemVerdictCacheAdapter extends VerdictCachePort {
  #relativeDir;
  #ttlMs;
  #clock;

  constructor({ relativeDir = path.join('audit-reports', 'commit-reviews'), ttlMs = DEFAULT_TTL_MS, clock = () => new Date() } = {}) {
    super();
    this.#relativeDir = relativeDir;
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string }} key
   * @returns {Promise<{ reportPath: string, at: string } | null>}
   */
  async lookup({ repoRoot, treeSha, diffHash }) {
    if (!OBJECT_ID.test(String(treeSha)) || !/^[0-9a-f]{64}$/.test(String(diffHash))) return null;
    let text;
    try {
      text = await readFile(path.join(repoRoot, this.#relativeDir, CACHE_FILE), 'utf8');
    } catch {
      return null;
    }
    const now = this.#clock().getTime();
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (entry?.schema !== CACHE_SCHEMA || entry.verdict !== 'PASS') continue;
      if (entry.treeSha !== treeSha || entry.diffHash !== diffHash) continue;
      const age = now - Date.parse(entry.at);
      if (!Number.isFinite(age) || age < 0 || age > this.#ttlMs) continue;
      const reportPath = path.resolve(repoRoot, String(entry.reportPath ?? ''));
      const relative = path.relative(repoRoot, reportPath);
      if (!entry.reportPath || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      let report;
      try {
        report = await readFile(reportPath, 'utf8');
      } catch {
        continue;
      }
      if (report.split(/\r?\n/).includes(`- staged diff hash: ${diffHash}`)
        && report.split(/\r?\n/).includes('- result: PASS')) {
        return { reportPath, at: entry.at };
      }
    }
    return null;
  }

  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string, reportPath: string }} entry
   * @returns {Promise<void>}
   */
  async record({ repoRoot, treeSha, diffHash, reportPath }) {
    if (!OBJECT_ID.test(String(treeSha))) return;
    const dir = path.join(repoRoot, this.#relativeDir);
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      schema: CACHE_SCHEMA,
      treeSha,
      diffHash,
      verdict: 'PASS',
      reportPath: path.relative(repoRoot, reportPath).split(path.sep).join('/'),
      at: this.#clock().toISOString(),
    });
    await appendFile(path.join(dir, CACHE_FILE), `${line}\n`, 'utf8');
  }
}
