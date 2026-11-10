// The identity of the staged state. `git write-tree` names the exact tree the index holds, so two
// reviews of the same OID read the same bytes even when the working tree is full of junk. An ignored
// file that reaches the index changes the OID, so junk cannot hide behind an older verdict.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The tree object of the current index, or null when git cannot write one (an unmerged index, a
 * missing repository). A null identity disables reuse; it never blocks a review.
 *
 * @param {string} repo
 * @returns {Promise<string|null>}
 */
export async function readIndexTreeOid(repo) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'write-tree'], { encoding: 'utf8', windowsHide: true });
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/**
 * The staged paths that the repository's ignore rules would ignore. A file like that in the index is
 * usually junk that slipped past a `.gitignore`; the review names it instead of silently reviewing it.
 *
 * @param {string} repo
 * @param {string[]} paths
 * @returns {Promise<string[]>} the ignored subset, in input order
 */
export async function stagedIgnoredPaths(repo, paths) {
  const candidates = (Array.isArray(paths) ? paths : []).filter(entry => typeof entry === 'string' && entry.length > 0);
  if (candidates.length === 0) return [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'check-ignore', '--no-index', '--', ...candidates], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const ignored = new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
    return candidates.filter(entry => ignored.has(entry));
  } catch {
    // Exit code 1 means "nothing ignored", which is the common and healthy answer.
    return [];
  }
}
