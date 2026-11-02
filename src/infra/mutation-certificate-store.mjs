// One certificate per certified byte state, outside every repository: `<root>/<digest>.json`. The
// store answers one question — "did a gate run already prove the whole catalog for exactly these
// bytes?" — so a release repeats a three-minute run instead of trusting a hash comparison. A failed
// write or an unreadable file is not an error the caller has to handle: the run simply happens again.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { CERTIFICATE_SCHEMA } from '../domain/mutation-certificate.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { pruneFolder } from './retained-folder.mjs';

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
  // `certificateFile` validates the digest, so a certificate can never be written outside its folder.
  return writeJsonAtomic(dir, path.basename(certificateFile(dir, certificate.digest)), certificate, options);
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
 * Keeps the newest `keep` certificates and drops files older than `keepDays`. A file nobody can read
 * as a certificate is left in place: deleting what the tool cannot parse is not retention.
 *
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, home?: string, keep?: number, keepDays?: number, now?: number }} [options]
 * @returns {Promise<number>} how many files were removed
 */
export async function pruneCertificates(options = {}) {
  const dir = options.dir ?? certificatesRootDir(options);
  return pruneFolder({
    dir,
    suffix: SUFFIX,
    keep: Number.isInteger(options.keep) ? options.keep : 50,
    keepDays: typeof options.keepDays === 'number' ? options.keepDays : 90,
    ...(typeof options.now === 'number' ? { now: options.now } : {}),
    describe: async (file) => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return parsed && typeof parsed === 'object' && parsed.schema === CERTIFICATE_SCHEMA ? parsed : null;
      } catch {
        return null;
      }
    },
  });
}
