const MARKER_RE = /^\/\/ omp-reviewer-kit runner v(\d+)\.(\d+)\.(\d+)\r?\n/;

/**
 * Reads the version marker from the first line of a vendored runner.
 *
 * @param {string} content
 * @returns {[number, number, number]|null} null for legacy runners without a marker
 */
export function parseRunnerVersion(content) {
  const match = MARKER_RE.exec(String(content).slice(0, 120));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * True when the installed runner must not be overwritten by the canonical one:
 * it carries a marker and is strictly newer, or the canonical copy has none.
 *
 * @param {string} installedContent
 * @param {string} canonicalContent
 * @returns {boolean}
 */
export function isRunnerNewer(installedContent, canonicalContent) {
  const installed = parseRunnerVersion(installedContent);
  if (!installed) return false;
  const canonical = parseRunnerVersion(canonicalContent);
  if (!canonical) return true;
  for (let i = 0; i < 3; i += 1) {
    if (installed[i] !== canonical[i]) return installed[i] > canonical[i];
  }
  return false;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The 'x.y.z' string of the marker on the first line of a runner.
 *
 * @param {string} content
 * @returns {string|null} null when the content carries no marker
 */
export function runnerVersionString(content) {
  const parsed = parseRunnerVersion(content);
  return parsed ? parsed.join('.') : null;
}

/**
 * Orders two 'x.y.z' version strings.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1|0|1|null} null when either side is not a plain 'x.y.z' version
 */
export function compareRunnerVersions(a, b) {
  const left = typeof a === 'string' ? VERSION_RE.exec(a) : null;
  const right = typeof b === 'string' ? VERSION_RE.exec(b) : null;
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
