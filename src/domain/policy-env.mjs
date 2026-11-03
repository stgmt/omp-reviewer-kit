// One policy switch read from the environment, for every analysis that has one. A value that is not
// a known policy keeps the caller's default: a typo must never silently downgrade a review, and it
// must never turn an advisory stage into a verdict.

/**
 * @param {object} env
 * @param {{ name: string, policies: readonly string[], fallback: string }} input
 * @returns {string}
 */
export function resolvePolicyFromEnv(env, { name, policies, fallback }) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  return policies.includes(raw) ? raw : fallback;
}
