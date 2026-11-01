// How large a staged change may be before the review refuses to spend a model on it. One policy
// module: the configured limits, the verdict for one diff, and the human-readable sizes the host and
// the report print. A malformed configuration is refused, never replaced by a silent default.

export const DEFAULT_MAX_PATHS = 40;
export const DEFAULT_MAX_BYTES = 1_500_000;

/** The reasons a diff can be refused, as stable tokens a log line or a record can carry. */
export const BUDGET_REASONS = Object.freeze({
  paths: 'too-many-paths',
  bytes: 'patch-too-large',
  invalid: 'invalid-budget',
});

/**
 * The budget from `OMP_REVIEW_KIT_MAX_DIFF`: empty for the default, `off` to disable the check, or
 * `<paths>` and `<paths>/<megabytes>`. Anything else is refused with the offending value.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ ok: boolean, enabled?: boolean, maxPaths?: number|null, maxBytes?: number|null, raw?: string, error?: string }}
 */
export function readDiffBudget({ env = process.env } = {}) {
  const raw = typeof env.OMP_REVIEW_KIT_MAX_DIFF === 'string' ? env.OMP_REVIEW_KIT_MAX_DIFF.trim() : '';
  if (raw === '') return { ok: true, enabled: true, maxPaths: DEFAULT_MAX_PATHS, maxBytes: DEFAULT_MAX_BYTES, raw };
  if (raw.toLowerCase() === 'off') return { ok: true, enabled: false, maxPaths: null, maxBytes: null, raw };
  const match = /^(\d+)(?:\/(\d+(?:\.\d+)?))?$/.exec(raw);
  const maxPaths = match ? Number(match[1]) : 0;
  const megabytes = match && match[2] !== undefined ? Number(match[2]) : DEFAULT_MAX_BYTES / 1_000_000;
  if (!match || !(maxPaths > 0) || !(megabytes > 0)) return { ok: false, error: `diff budget invalid: ${raw}` };
  return { ok: true, enabled: true, maxPaths, maxBytes: Math.round(megabytes * 1_000_000), raw };
}

/**
 * One diff against one budget. With the check disabled nothing is refused, and the limits stay null
 * so no caller can mistake them for a real ceiling.
 *
 * @param {{ paths: number, bytes: number }} diff
 * @param {{ enabled: boolean, maxPaths?: number|null, maxBytes?: number|null }} budget
 * @returns {{ refused: boolean, reason: string|null, paths: number, bytes: number, maxPaths: number|null, maxBytes: number|null }}
 */
export function assessDiff({ paths, bytes }, budget) {
  const maxPaths = budget?.enabled ? budget.maxPaths ?? null : null;
  const maxBytes = budget?.enabled ? budget.maxBytes ?? null : null;
  const base = { refused: false, reason: null, paths, bytes, maxPaths, maxBytes };
  if (!budget?.enabled) return base;
  if (typeof maxPaths === 'number' && paths > maxPaths) return { ...base, refused: true, reason: BUDGET_REASONS.paths };
  if (typeof maxBytes === 'number' && bytes > maxBytes) return { ...base, refused: true, reason: BUDGET_REASONS.bytes };
  return base;
}

/**
 * A readable size for one log line: `512 B`, `2.0 KB`, `1.8 MB`. Unknown input is `unknown`.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatDiffSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
