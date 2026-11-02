// One JSON file written so a reader sees either the previous document or the new one, never a
// half-written file. The rename is retried because on Windows an antivirus or the indexer can hold
// the target for a few milliseconds; a failed write removes its temporary file and rethrows.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RENAME_ATTEMPTS = 20;
const RENAME_DELAY_MS = 25;
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

// The temporary name must be unique even for two writes in the same millisecond: the pid and the
// clock are not enough, because callers fire writes without awaiting them.
let tempSequence = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function renameWithRetry(from, to, renameFile) {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (!RETRYABLE.has(code) || attempt === RENAME_ATTEMPTS) throw error;
      await sleep(RENAME_DELAY_MS);
    }
  }
}

/**
 * Writes `value` as JSON to `<dir>/<name>` atomically and returns the file.
 *
 * @param {string} dir
 * @param {string} name
 * @param {unknown} value
 * @param {{ renameFile?: (from: string, to: string) => Promise<void> }} [options]
 * @returns {Promise<string>} the written file
 */
export async function writeJsonAtomic(dir, name, value, options = {}) {
  const renameFile = typeof options.renameFile === 'function' ? options.renameFile : rename;
  const file = path.join(dir, name);
  await mkdir(dir, { recursive: true });
  tempSequence = (tempSequence + 1) % 1_000_000;
  const temp = path.join(dir, `.${name}.${process.pid}.${Date.now().toString(36)}.${tempSequence.toString(36)}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await renameWithRetry(temp, file, renameFile);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}
