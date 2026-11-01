// Configuration of the maintainability analysis: one place for every threshold the spec names.
// Values are documented defaults; the policy is the only switch read from the environment.

export const SCHEMA = 'maintainability@1';
export const POLICIES = Object.freeze(['off', 'advisory', 'block']);
export const POLICY_ENV = 'OMP_REVIEW_KIT_MAINTAINABILITY';

/** The analysis limits of MR-13 and the review budget of MR-07. */
export const DEFAULT_CONFIG = Object.freeze({
  minSupport: 4,
  minSize: 2,
  maxGroupSize: 4,
  maxGroups: 10,
  maxCandidates: 5,
  maxToolCalls: 20,
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
  const raw = String(env?.[POLICY_ENV] ?? '').trim().toLowerCase();
  return POLICIES.includes(raw) ? raw : 'block';
}

/**
 * @param {Partial<typeof DEFAULT_CONFIG>} [overrides]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`unknown maintainability config key: ${key}`);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`maintainability config ${key} must be a positive integer`);
    config[key] = value;
  }
  return config;
}
