// What one gate run proved, and for which bytes. The certificate is evidence a reader may trust to
// skip a repeat run on byte-identical code; it is never a verdict of its own and never turns a FAIL
// into a PASS. A certificate the reader cannot understand is simply absent.

/** The document this module writes and reads. Another schema is ignored, never migrated. */
export const CERTIFICATE_SCHEMA = 'mutation-certificate@1';

const DIGEST = /^[0-9a-f]{64}$/;

const count = value => Number.isInteger(value) && value >= 0;

/**
 * The record a successful gate run leaves behind.
 *
 * A kill proof is runtime-scoped: the gate itself hashes `process.version` and `process.platform` into
 * its own fingerprint, so a proof obtained under one runtime says nothing about another.
 *
 * @param {{ digest: string, mutants: number, killed: number, durationMs: number, createdAt?: string, nodeVersion?: string, platform?: string }} input
 * @returns {object}
 */
export function createCertificate({
  digest,
  mutants,
  killed,
  durationMs,
  createdAt = new Date().toISOString(),
  nodeVersion = process.version,
  platform = process.platform,
}) {
  return {
    schema: CERTIFICATE_SCHEMA,
    digest,
    mutants,
    killed,
    durationMs: Math.max(0, Math.round(durationMs)),
    createdAt,
    nodeVersion,
    platform,
  };
}

/**
 * Whether this document certifies the given bytes for the whole curated catalog on this runtime. A
 * partial kill, a different catalog size, another runtime or platform, a missing digest or another
 * schema is not a certificate.
 *
 * @param {unknown} value
 * @param {{ digest: string, mutants: number, nodeVersion?: string, platform?: string }} expected
 * @returns {boolean}
 */
export function isUsableCertificate(value, { digest, mutants, nodeVersion = process.version, platform = process.platform }) {
  if (!value || typeof value !== 'object') return false;
  if (value.schema !== CERTIFICATE_SCHEMA) return false;
  if (typeof value.digest !== 'string' || !DIGEST.test(value.digest)) return false;
  if (value.digest !== digest) return false;
  if (!count(value.mutants) || value.mutants !== mutants) return false;
  if (!count(value.killed) || value.killed !== value.mutants) return false;
  // The kill was observed on one runtime; another one is another experiment.
  if (value.nodeVersion !== nodeVersion) return false;
  if (value.platform !== platform) return false;
  return true;
}

/**
 * One line for the preflight: what was proved, how long it took and how old the proof is.
 *
 * @param {{ mutants: number, killed: number, durationMs: number, createdAt: string }} certificate
 * @param {number} [now]
 * @returns {string}
 */
export function describeCertificate(certificate, now = Date.now()) {
  const started = Date.parse(certificate.createdAt ?? '');
  const ageMs = Number.isFinite(started) ? Math.max(0, now - started) : null;
  const age = ageMs === null
    ? 'age unknown'
    : ageMs < 60_000
      ? `${Math.round(ageMs / 1000)}s old`
      : ageMs < 3_600_000
        ? `${Math.round(ageMs / 60_000)} min old`
        : `${Math.round(ageMs / 3_600_000)} h old`;
  return `${certificate.killed}/${certificate.mutants} mutants proved in ${Math.round((certificate.durationMs ?? 0) / 1000)}s, ${age}`;
}
