// One persisted session registration: which repository a session registered, and when. The shape is
// produced and read here once, so a change to it is one edit instead of a coordinated one in the
// writer, the listing, the retention order, the removal and every fixture.

import path from 'node:path';

/**
 * @param {string} repoRoot
 * @param {number} [addedAt]
 * @returns {{ path: string, addedAt: number }}
 */
export function registrationOf(repoRoot, addedAt = Date.now()) {
  return { path: path.resolve(String(repoRoot)), addedAt: Number(addedAt) || 0 };
}

/**
 * Reads one stored registration. A foreign, half-written or malformed record is null: it is never
 * half-trusted, and it never makes the reader throw.
 *
 * @param {unknown} value
 * @returns {{ repo: string, addedAt: number } | null}
 */
export function readRegistration(value) {
  const stored = value !== null && typeof value === 'object' ? value.path : undefined;
  if (typeof stored !== 'string' || stored.length === 0) return null;
  const addedAt = Number(value.addedAt);
  return { repo: path.resolve(stored), addedAt: Number.isFinite(addedAt) ? addedAt : 0 };
}
