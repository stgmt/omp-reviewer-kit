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
