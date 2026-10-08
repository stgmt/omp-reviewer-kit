import { createHash } from 'node:crypto';

// Line 2 of every hook template a release ships: the release version, and a digest of
// every other line. A file that carries a valid marker was written by a kit release and
// has not been edited since, so it is ours whichever release wrote it.
const MARKER_RE = /^# omp-reviewer-kit hook v(\d+\.\d+\.\d+) body-sha256:([0-9a-f]{64})$/;

const normalize = (text) => String(text).replace(/\r\n/g, '\n');

/**
 * Digest of a hook without its marker line. Line endings and trailing blank lines do not count.
 * Hooks written before markers existed have no marker, so this is also their digest.
 *
 * @param {string} text
 * @returns {string} hex SHA-256
 */
export function hookBodyDigest(text) {
  const lines = normalize(text).split('\n');
  const body = MARKER_RE.test(lines[1] ?? '') ? [lines[0], ...lines.slice(2)] : lines;
  return createHash('sha256').update(body.join('\n').trimEnd()).digest('hex');
}

/**
 * @param {string} text
 * @returns {{ version: string, digest: string }|null} null when the file has no marker
 */
export function parseHookMarker(text) {
  const match = MARKER_RE.exec(normalize(text).split('\n')[1] ?? '');
  return match ? { version: match[1], digest: match[2] } : null;
}

/** True when the marker is present and the body still matches it: an unedited kit hook of any release. */
export function isOwnedHook(text) {
  const marker = parseHookMarker(text);
  return marker !== null && marker.digest === hookBodyDigest(text);
}

const compareVersions = (a, b) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
};

/**
 * True when an installed hook must not be overwritten by the canonical template: it is an
 * unedited kit hook from a strictly newer release, or the canonical template carries no marker.
 * Mirrors isRunnerNewer for the runner.
 *
 * @param {string} installedText
 * @param {string} canonicalText
 * @returns {boolean}
 */
export function isHookNewer(installedText, canonicalText) {
  if (!isOwnedHook(installedText)) return false;
  const canonical = parseHookMarker(canonicalText);
  if (!canonical) return true;
  return compareVersions(parseHookMarker(installedText).version, canonical.version) > 0;
}

/**
 * Writes the marker of a release into a hook template, replacing an existing one. Run after
 * every edit of templates/githooks/pre-commit (scripts/stamp-hook.mjs).
 *
 * @param {string} text template body, with or without a marker
 * @param {string} version release version, without the leading v
 * @returns {string}
 */
export function stampHookTemplate(text, version) {
  const lines = normalize(text).split('\n');
  const body = (MARKER_RE.test(lines[1] ?? '') ? [lines[0], ...lines.slice(2)] : lines).join('\n');
  const digest = hookBodyDigest(body);
  const [shebang, ...rest] = body.split('\n');
  return [shebang, `# omp-reviewer-kit hook v${version} body-sha256:${digest}`, ...rest].join('\n').trimEnd() + '\n';
}
