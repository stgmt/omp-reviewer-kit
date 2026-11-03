// Configuration of the maintainability analysis: one place for every threshold the spec names.
// Values are documented defaults; the policy is the only switch read from the environment.

import { applyNumberOverrides } from '../../domain/config-overrides.mjs';
import { resolvePolicyFromEnv } from '../../domain/policy-env.mjs';

export const SCHEMA = 'maintainability@1';
export const POLICIES = Object.freeze(['off', 'advisory', 'block']);
export const POLICY_ENV = 'OMP_REVIEW_KIT_MAINTAINABILITY';

/** The analysis limits of MR-13. */
export const DEFAULT_CONFIG = Object.freeze({
  minSupport: 4,
  minSize: 2,
  maxGroupSize: 4,
  maxGroups: 200,
  maxFileBytes: 524288,
  maxScanFiles: 4000,
  maxScanMs: 5000,
  maxSignatureParams: 8,
});

/**
 * The blocking policy. Anything but a known policy name is the default `block`: a typo must not
 * silently downgrade the review to a recommendation.
 *
 * @param {object} [env]
 * @returns {'off'|'advisory'|'block'}
 */
export function resolvePolicy(env = {}) {
  return resolvePolicyFromEnv(env, { name: POLICY_ENV, policies: POLICIES, fallback: 'block' });
}

/**
 * @param {Partial<typeof DEFAULT_CONFIG>} [overrides]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(overrides = {}) {
  return applyNumberOverrides(DEFAULT_CONFIG, overrides, { label: 'maintainability', integer: true });
}
