// What one gate run proved, and for which bytes. The certificate is evidence a reader may trust to
// skip a repeat run on byte-identical code; it is never a verdict of its own and never turns a FAIL
// into a PASS. A certificate the reader cannot understand is simply absent.
//
// A run is one value: which bytes, how many mutants, how long it took. A run that killed every
// curated mutant is a proof; a partial run is not recorded at all, so "killed" is not a field that
// could ever contradict "mutants" — a complete kill is the only thing a certificate can describe.

/** The document this module writes and reads. Another schema is ignored, never migrated. */
export const CERTIFICATE_SCHEMA = 'mutation-certificate@2';

const DIGEST = /^[0-9a-f]{64}$/;

const count = value => Number.isInteger(value) && value >= 0;

/**
 * One gate run over one state of the bytes.
 *
 * @param {{ digest: string, mutants: number, durationMs: number }} input
 * @returns {{ digest: string, mutants: number, durationMs: number }}
 */
export function gateRun({ digest, mutants, durationMs }) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error(`invalid gate run digest: ${String(digest)}`);
  if (!Number.isInteger(mutants) || mutants <= 0) throw new Error(`invalid gate run mutant count: ${String(mutants)}`);
  return { digest, mutants, durationMs: Math.max(0, Math.round(durationMs)) };
}

/**
 * The record a successful gate run leaves behind.
 *
 * A kill proof is runtime-scoped: the gate itself hashes `process.version` and `process.platform` into
 * its own fingerprint, so a proof obtained under one runtime says nothing about another.
 *
 * @param {{ digest: string, mutants: number, durationMs: number }} run
 * @param {{ createdAt?: string, nodeVersion?: string, platform?: string }} [options]
 * @returns {object}
 */
export function createCertificate(run, { createdAt = new Date().toISOString(), nodeVersion = process.version, platform = process.platform } = {}) {
  return { schema: CERTIFICATE_SCHEMA, run: gateRun(run), createdAt, nodeVersion, platform };
}

/**
 * Whether this document certifies the given bytes for the whole curated catalog on this runtime.
 * Another digest, another catalog size, another runtime or platform, or another schema is not a
 * certificate.
 *
 * @param {unknown} value
 * @param {{ digest: string, mutants: number, nodeVersion?: string, platform?: string }} expected
 * @returns {boolean}
 */
export function isUsableCertificate(value, { digest, mutants, nodeVersion = process.version, platform = process.platform }) {
  if (!value || typeof value !== 'object') return false;
  if (value.schema !== CERTIFICATE_SCHEMA) return false;
  const run = value.run;
  if (!run || typeof run !== 'object') return false;
  if (typeof run.digest !== 'string' || !DIGEST.test(run.digest)) return false;
  if (run.digest !== digest) return false;
  if (!count(run.mutants) || run.mutants !== mutants) return false;
  // The kill was observed on one runtime; another one is another experiment.
  if (value.nodeVersion !== nodeVersion) return false;
  if (value.platform !== platform) return false;
  return true;
}

/**
 * One line for the preflight: what was proved, how long it took and how old the proof is.
 *
 * @param {{ run: { mutants: number, durationMs: number }, createdAt: string }} certificate
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
  const mutants = certificate.run?.mutants ?? 0;
  const durationMs = certificate.run?.durationMs ?? 0;
  return `${mutants}/${mutants} mutants proved in ${Math.round(durationMs / 1000)}s, ${age}`;
}
