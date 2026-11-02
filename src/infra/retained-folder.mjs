// Retention for the two folders this kit keeps outside a repository: review run records and mutation
// certificates. One owner for the rule, so a fix to it cannot reach one folder and miss the other.
//
// The rule, in order: the newest file always stays; an entry the caller marks as retained stays too
// (a live review, for example); a file nobody can read is left alone rather than deleted by guesswork;
// everything past `keep` or older than `keepDays` is removed, best effort.

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {{ file: string, modified: number }} FolderEntry
 */

/**
 * @param {{
 *   dir: string,
 *   suffix: string,
 *   keep?: number,
 *   keepDays?: number,
 *   now?: number,
 *   describe?: (file: string) => Promise<object|null>,
 *   isRetained?: (meta: object) => boolean,
 *   at?: (meta: object, modified: number) => number,
 * }} options
 * @returns {Promise<number>} how many files were removed
 */
export async function pruneFolder({ dir, suffix, keep = 50, keepDays = 90, now = Date.now(), describe, isRetained, at }) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  /** @type {Array<FolderEntry & { meta: object|null }>} */
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(suffix) || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let modified;
    try {
      modified = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    // An unreadable document is left in place: deleting what nobody could parse is not retention.
    const meta = describe ? await describe(file) : {};
    if (meta === null) continue;
    const age = at ? at(meta, modified) : modified;
    entries.push({ file, modified, meta, age: Number.isFinite(age) ? age : modified });
  }
  entries.sort((left, right) => right.age - left.age);
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (index === 0) continue;
    if (isRetained && isRetained(entry.meta)) continue;
    const tooMany = index >= keep;
    const tooOld = entry.age < cutoff;
    if (!tooMany && !tooOld) continue;
    try {
      await rm(entry.file, { force: true });
      removed += 1;
    } catch {
      // Best effort: a locked file is retried on the next prune.
    }
  }
  return removed;
}
