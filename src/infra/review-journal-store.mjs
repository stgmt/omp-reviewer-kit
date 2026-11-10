// The journal of one review on disk: every finished stage and the final verdict, outside the
// repository, so a killed run continues instead of starting over. Every write is atomic; every read
// and write is fail-open, because a journal that cannot be stored costs reuse, never a verdict.

import { homedir } from 'node:os';
import path from 'node:path';
import { readdir, readFile, rm, stat } from 'node:fs/promises';

import { writeJsonAtomic } from './atomic-json-file.mjs';
import { JOURNAL_DIR_ENV, JOURNAL_SCHEMA } from '../domain/review-journal.mjs';

/** How many reviews the journal keeps. The newest review is never pruned. */
export const KEEP_JOURNALS = 100;
/** How long a review stays reusable. */
export const MAX_AGE_DAYS = 30;

/**
 * Where journals live: `OMP_REVIEW_KIT_JOURNAL_DIR` when set, else `<home>/.omp/review-kit-journal`.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [input]
 * @returns {string}
 */
export function journalRootDir({ env = process.env, home = homedir() } = {}) {
  const configured = typeof env?.[JOURNAL_DIR_ENV] === 'string' ? env[JOURNAL_DIR_ENV].trim() : '';
  return configured.length > 0 ? configured : path.join(home, '.omp', 'review-kit-journal');
}

/** The directory of one review. */
export function journalDir(root, key) {
  return path.join(root, key);
}

/** A stage id made safe for a file name. */
export function stageFileName(id) {
  return `${String(id).replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`;
}

/**
 * The stored journal of one review, or null when there is none or it cannot be read.
 *
 * @param {string} root
 * @param {string} key
 * @returns {Promise<object|null>}
 */
export async function readJournal(root, key) {
  if (typeof root !== 'string' || typeof key !== 'string' || key.length === 0) return null;
  try {
    return JSON.parse(await readFile(path.join(journalDir(root, key), 'journal.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Writes the journal of one review. The caller owns the schema and the key.
 *
 * @param {string} root
 * @param {string} key
 * @param {object} record
 * @returns {Promise<string|null>} the written file, or null when the write failed
 */
export async function writeJournal(root, key, record) {
  try {
    return await writeJsonAtomic(journalDir(root, key), 'journal.json', record);
  } catch {
    return null;
  }
}

/**
 * Writes one stage entry of one review.
 *
 * @param {string} root
 * @param {string} key
 * @param {string} id
 * @param {object} entry
 * @returns {Promise<string|null>}
 */
export async function writeStageEntry(root, key, id, entry) {
  try {
    return await writeJsonAtomic(path.join(journalDir(root, key), 'stages'), stageFileName(id), entry);
  } catch {
    return null;
  }
}

/**
 * One stored stage entry, or null when it is missing or unreadable.
 *
 * @param {string} root
 * @param {string} key
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function readStageEntry(root, key, id) {
  if (typeof root !== 'string' || typeof key !== 'string' || typeof id !== 'string') return null;
  try {
    return JSON.parse(await readFile(path.join(journalDir(root, key), 'stages', stageFileName(id)), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Removes journals beyond the retention limits: the newest `keep` and everything younger than
 * `maxAgeDays` stay. A directory that does not hold this kit's journal is never touched — the root
 * may be a folder the owner shares with something else — and a journal that cannot be inspected is
 * left alone, so pruning never deletes what it cannot read.
 *
 * @param {string} root
 * @param {{ keep?: number, maxAgeDays?: number, now?: () => number }} [options]
 * @returns {Promise<number>} how many journals were removed
 */
export async function pruneJournals(root, { keep = KEEP_JOURNALS, maxAgeDays = MAX_AGE_DAYS, now = Date.now } = {}) {
  let names;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const entries = [];
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    // Only a directory that carries a readable journal of this schema is a candidate: an unrelated
    // folder under a configured root must survive a review.
    let record;
    try {
      record = JSON.parse(await readFile(path.join(dir, 'journal.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!record || record.schema !== JOURNAL_SCHEMA) continue;
    try {
      const info = await stat(dir);
      entries.push({ dir, name: dirent.name, mtimeMs: info.mtimeMs });
    } catch {
      // An unreadable entry is not a candidate for deletion.
    }
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const cutoff = now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (index === 0) continue;
    if (index < keep && entry.mtimeMs >= cutoff) continue;
    try {
      await rm(entry.dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Windows keeps a file open for a moment; the next review prunes again.
    }
  }
  return removed;
}
