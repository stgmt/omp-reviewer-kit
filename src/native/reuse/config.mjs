// Configuration of the reuse hints: the thresholds of one deterministic scan, and the only switch
// that comes from the environment. The hints are additive — they can add an input to the review,
// never take one away — so the default is `advisory` and `off` is the only other value.

import { applyNumberOverrides } from '../../domain/config-overrides.mjs';
import { resolvePolicyFromEnv } from '../../domain/policy-env.mjs';

export const SCHEMA = 'reuse@1';
export const POLICIES = Object.freeze(['off', 'advisory']);
export const POLICY_ENV = 'OMP_REVIEW_KIT_REUSE';
export const CACHE_DIR_ENV = 'OMP_REVIEW_KIT_REUSE_CACHE_DIR';

/** The scan limits. The whole scan is bounded, so a huge repository cannot buy the review's time. */
export const DEFAULT_CONFIG = Object.freeze({
  maxFiles: 4000,
  maxFileBytes: 524288,
  maxUnits: 6000,
  maxScanMs: 4000,
  minShapeTokens: 40,
  minDistinctiveShingles: 12,
  minSharedShingles: 6,
  minSimilarity: 0.55,
  maxCandidates: 12,
});

/**
 * The policy switch. A value that is not a known policy keeps the default `advisory`: a typo must
 * not silently remove the hints, and it must never turn them into a verdict.
 *
 * @param {object} [env]
 * @returns {'off'|'advisory'}
 */
export function resolveReusePolicy(env = {}) {
  return resolvePolicyFromEnv(env, { name: POLICY_ENV, policies: POLICIES, fallback: 'advisory' });
}

/**
 * @param {Partial<typeof DEFAULT_CONFIG>} [overrides]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveReuseConfig(overrides = {}) {
  return applyNumberOverrides(DEFAULT_CONFIG, overrides, { label: 'reuse' });
}
