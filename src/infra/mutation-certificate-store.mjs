// One certificate per certified byte state, outside every repository: `<root>/<digest>.json`. The
// store answers one question — "did a gate run already prove the whole catalog for exactly these
// bytes?" — so a release repeats a three-minute run instead of trusting a hash comparison. A failed
// write or an unreadable file is not an error the caller has to handle: the run simply happens again.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { CERTIFICATE_SCHEMA } from '../domain/mutation-certificate.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

const DIGEST = /^[0-9a-f]{64}$/;
const SUFFIX = '.json';

/**
 * Root folder of certificates. Default `<home>/.omp/review-kit-mutation`, so one machine keeps one
 * view across every repository; `OMP_REVIEW_KIT_MUTATION_CERT_DIR` overrides it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string}
 */
export function certificatesRootDir({ env = process.env, home = homedir() } = {}) {
  const override = typeof env.OMP_REVIEW_KIT_MUTATION_CERT_DIR === 'string'
    ? env.OMP_REVIEW_KIT_MUTATION_CERT_DIR.trim()
    : '';
  if (override.length > 0) return path.resolve(override);
  return path.join(home, '.omp', 'review-kit-mutation');
}

/**
 * @param {string} dir
 * @param {string} digest
 * @returns {string}
 */
export function certificateFile(dir, digest) {
  if (!DIGEST.test(String(digest ?? ''))) throw new Error(`invalid certificate digest: ${String(digest)}`);
  return path.join(dir, `${digest}${SUFFIX}`);
}

/**
 * Stores one certificate. Fail-open by contract: the caller decides whether a failure blocks.
 *
 * @param {object} certificate
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, renameFile?: (from: string, to: string) => Promise<void> }} [options]
 * @returns {Promise<string>} the certificate file
 */
export async function writeCertificate(certificate, options = {}) {
  const dir = options.dir ?? certificatesRootDir(options);
  return writeJsonAtomic(dir, `${certificate.digest}${SUFFIX}`, certificate, options);
}

/**
 * The certificate for these exact bytes, or null when it is missing, unreadable, of another schema
 * or about another digest.
 *
 * @param {string} digest
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {Promise<object|null>}
 */
export async function readCertificate(digest, options = {}) {
  if (!DIGEST.test(String(digest ?? ''))) return null;
  const dir = options.dir ?? certificatesRootDir(options);
  try {
    const parsed = JSON.parse(await readFile(certificateFile(dir, digest), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== CERTIFICATE_SCHEMA) return null;
    if (parsed.digest !== digest) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Keeps the newest `keep` certificates and drops files older than `keepDays`. Best effort: a file
 * that cannot be read or removed is left in place and retried on the next prune.
 *
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, keep?: number, keepDays?: number, now?: number }} [options]
 * @returns {Promise<number>} how many files were removed
 */
export async function pruneCertificates(options = {}) {
  const dir = options.dir ?? certificatesRootDir(options);
  const keep = Number.isInteger(options.keep) ? options.keep : 50;
  const keepDays = typeof options.keepDays === 'number' ? options.keepDays : 90;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(SUFFIX) || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let modified;
    try {
      modified = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    entries.push({ file, modified });
  }
  entries.sort((left, right) => right.modified - left.modified);
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (index === 0) continue;
    if (index < keep && entry.modified >= cutoff) continue;
    try {
      await rm(entry.file, { force: true });
      removed += 1;
    } catch {
      // Best effort: a locked certificate is retried on the next prune.
    }
  }
  return removed;
}
