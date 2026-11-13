// Configuration of the version census: the scan limits, the one switch, and the schema name.
// The census is additive evidence for the hunter — it lists which versions are produced, consumed
// and listed — so it never blocks a commit; `off` and `advisory` are the only policies.

import path from 'node:path';

import { applyNumberOverrides } from '../../domain/config-overrides.mjs';
import { resolvePolicyFromEnv } from '../../domain/policy-env.mjs';

export const SCHEMA = 'compat@1';
export const POLICIES = Object.freeze(['off', 'advisory']);
export const POLICY_ENV = 'OMP_REVIEW_KIT_COMPAT';
/** Where the census artifact lives inside the staged snapshot. */
export const COMPAT_FILE = path.join('.review', 'compat.json');

/** The scan limits. Bounded as a whole so a huge repository cannot buy the review's time. */
export const DEFAULT_CONFIG = Object.freeze({
  maxFiles: 40,
  maxFileBytes: 524288,
  maxSites: 200,
  maxFamilies: 40,
  maxScanFiles: 4000,
  maxScanMs: 4000,
});

/**
 * The policy switch. A value that is not a known policy keeps the default `advisory`: a typo must
 * never silently remove the census, and it must never turn evidence into a verdict.
 *
 * @param {object} [env]
 * @returns {'off'|'advisory'}
 */
export function resolveCompatPolicy(env = {}) {
  return resolvePolicyFromEnv(env, { name: POLICY_ENV, policies: POLICIES, fallback: 'advisory' });
}

/**
 * @param {Partial<typeof DEFAULT_CONFIG>} [overrides]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveCompatConfig(overrides = {}) {
  return applyNumberOverrides(DEFAULT_CONFIG, overrides, { label: 'compat', integer: true });
}
