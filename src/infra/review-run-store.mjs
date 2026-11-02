// One file per review run, outside every repository: `<runs root>/<runId>.json`. The record is an
// observation, never a gate input. Writes are atomic (temp file + rename with retries, because on
// Windows an antivirus or the indexer can hold the target for a few milliseconds), and every read
// ignores a file it cannot understand instead of failing the caller.

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { RUN_SCHEMA, normalizeRunRecord, isTerminalRun } from '../domain/review-run-summary.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { pruneFolder } from './retained-folder.mjs';
import { sameRepositoryPredicate } from './repo-identity.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const RECORD_SUFFIX = '.json';

/**
 * Root folder of run records. Default `<home>/.omp/review-kit-runs`, so one machine has one view
 * across every repository; `OMP_REVIEW_KIT_RUNS_DIR` overrides it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string}
 */
export function runsRootDir({ env = process.env, home = homedir() } = {}) {
  const override = typeof env.OMP_REVIEW_KIT_RUNS_DIR === 'string' ? env.OMP_REVIEW_KIT_RUNS_DIR.trim() : '';
  if (override.length > 0) return path.resolve(override);
  return path.join(home, '.omp', 'review-kit-runs');
}

/**
 * @param {string} dir
 * @param {string} runId
 * @returns {string}
 */
export function runRecordFile(dir, runId) {
  if (!RUN_ID.test(String(runId ?? ''))) throw new Error(`invalid run id: ${String(runId)}`);
  return path.join(dir, `${runId}${RECORD_SUFFIX}`);
}

/**
 * One repository is written down under many spellings: `E:/repo` and `E:\\repo`, a directory reached
 * through a junction or symlink, and on Windows any letter case. Identity is the real path, folded
 * for a case-insensitive file system, so `/reviewer-kit:runs` finds the history it wrote even when the
 * caller arrives through another spelling. A path that no longer exists keeps its resolved form.
 *
 * @param {string} value
 * @returns {string|null}
 */
/**
 * Writes one record atomically: a reader sees either the previous file or the new one, never a
 * half-written record. A partially written temporary file is removed on failure.
 *
 * @param {object} record
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, renameFile?: (from: string, to: string) => Promise<void> }} [options]
 * @returns {Promise<string>} the record file
 */
export async function writeRunRecord(record, options = {}) {
  const dir = options.dir ?? runsRootDir(options);
  const normalized = normalizeRunRecord(record);
  // The guard lives in `runRecordFile`: one rule for the reader and the writer, so a run id can never
  // escape the runs folder through the write path.
  return writeJsonAtomic(dir, path.basename(runRecordFile(dir, normalized.runId)), normalized, options);
}

/**
 * One record, or null when the file is missing, unreadable, of another schema or malformed. There
 * is no legacy format to fall back to: a record this reader cannot understand is simply absent.
 *
 * @param {string} file
 * @returns {Promise<object|null>}
 */
export async function readRunRecord(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== RUN_SCHEMA) return null;
    return normalizeRunRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * Records newest first, skipping anything unreadable. `repoRoot` limits the list to one repository.
 *
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, limit?: number, repoRoot?: string }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function readRunRecords(options = {}) {
  const dir = options.dir ?? runsRootDir(options);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records = [];
  const matchesRepo = options.repoRoot ? sameRepositoryPredicate(options.repoRoot) : null;
  for (const name of names) {
    if (!name.endsWith(RECORD_SUFFIX) || name.startsWith('.')) continue;
    const record = await readRunRecord(path.join(dir, name));
    if (!record) continue;
    if (matchesRepo && !matchesRepo(record.repoRoot)) continue;
    records.push(record);
  }
  records.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')));
  return typeof options.limit === 'number' ? records.slice(0, options.limit) : records;
}

/**
 * The newest record, optionally of one repository.
 *
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, repoRoot?: string }} [options]
 * @returns {Promise<object|null>}
 */
export async function latestRunRecord(options = {}) {
  const records = await readRunRecords({ ...options, limit: 1 });
  return records[0] ?? null;
}

/**
 * Whether the run that wrote the record is still running. A record whose runner process is gone is
 * reported as interrupted by the reader, so a killed review never looks alive forever.
 *
 * @param {object} record
 * @param {{ kill?: (pid: number, signal: 0) => boolean }} [options]
 * @returns {boolean}
 */
export function isRunAlive(record, { kill = pid => process.kill(pid, 0) } = {}) {
  if (!record || !isTerminalRun(record)) {
    const pid = record?.runnerPid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to someone else: still alive.
      return error?.code === 'EPERM';
    }
  }
  return false;
}

/**
 * Keeps the newest `keep` records, drops records older than `keepDays`, and never touches the
 * newest record or a run that is still alive. Best effort: an unreadable file is left in place.
 *
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, keep?: number, keepDays?: number, now?: number }} [options]
 * @returns {Promise<number>} how many files were removed
 */
export async function pruneRuns(options = {}) {
  return pruneFolder({
    dir: options.dir ?? runsRootDir(options),
    suffix: RECORD_SUFFIX,
    keep: Number.isInteger(options.keep) ? options.keep : 200,
    keepDays: typeof options.keepDays === 'number' ? options.keepDays : 30,
    ...(typeof options.now === 'number' ? { now: options.now } : {}),
    describe: file => readRunRecord(file),
    // A killed review is over; a live one is never pruned from under the process that writes it.
    isRetained: record => isRunAlive(record),
    at: (record, modified) => {
      const started = Date.parse(record.startedAt ?? '');
      return Number.isFinite(started) ? started : modified;
    },
  });
}
