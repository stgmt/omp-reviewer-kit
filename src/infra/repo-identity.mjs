// One repository has one identity on one platform. The same checkout is written down under many
// spellings: `E:/repo` and `E:\\repo`, a directory reached through a junction or a symlink, an 8.3
// short name, and on Windows any letter case. Three consumers compare repository paths - the run
// history, the target registry and the session heal - so the rule lives here once instead of being
// re-derived (and re-broken) in each of them.

import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The identity of a repository path: its real path, folded for a case-insensitive file system. A
 * path that does not exist keeps its resolved form, because a deleted checkout still owns the
 * records and registrations it wrote.
 *
 * @param {unknown} value
 * @returns {string|null} null when the value is not a usable path
 */
export function repoIdentity(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let resolved;
  try {
    resolved = path.resolve(value);
  } catch {
    return null;
  }
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Keep the resolved spelling: the checkout may be gone while its state is still readable.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Whether two spellings name the same repository.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameRepository(left, right) {
  const identity = repoIdentity(left);
  if (identity === null) return false;
  return identity === repoIdentity(right);
}

/**
 * Compares one repository against many candidates, resolving each distinct spelling once instead of
 * one system call per comparison. `resolve` is the identity function by default; a caller may replace
 * it to observe how many resolutions a comparison really performs.
 *
 * @param {unknown} repoRoot
 * @param {{ resolve?: (value: unknown) => string|null }} [options]
 * @returns {(candidate: unknown) => boolean}
 */
export function sameRepositoryPredicate(repoRoot, { resolve = repoIdentity } = {}) {
  const expected = resolve(repoRoot);
  const seen = new Map();
  return candidate => {
    if (expected === null || typeof candidate !== 'string' || candidate.length === 0) return false;
    if (!seen.has(candidate)) seen.set(candidate, resolve(candidate));
    return seen.get(candidate) === expected;
  };
}
