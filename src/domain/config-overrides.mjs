// One config override rule for every analysis that has one: an unknown key is an error, a value
// that is not a positive number is an error, and the defaults are never mutated. Two analyses that
// validate their overrides the same way must not keep two copies of that rule.

/**
 * @template {Record<string, number>} T
 * @param {T} defaults
 * @param {Partial<T>} overrides
 * @param {{ label: string, integer?: boolean }} rules
 * @returns {T}
 */
export function applyNumberOverrides(defaults, overrides, { label, integer = false }) {
  const config = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    // Owned keys only: `toString` and `constructor` are inherited on every object and are not
    // configuration a caller may set.
    if (!Object.hasOwn(defaults, key) || typeof defaults[key] !== 'number') throw new Error(`unknown ${label} config key: ${key}`);
    const valid = integer
      ? Number.isInteger(value) && value > 0
      : typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (!valid) throw new Error(`${label} config ${key} must be a positive ${integer ? 'integer' : 'number'}`);
    config[key] = value;
  }
  return config;
}
