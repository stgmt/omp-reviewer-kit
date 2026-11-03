import { createHash } from 'node:crypto';

// Line 2 of every hook template the kit ships: the hook *format*, and a digest of every other line.
// The format changes when the hook body changes in a way an older release cannot read; it does not
// change with a release. That is the whole point: a release that leaves the hook alone rewrites
// nothing in any repository, so delivering an update never patches the files of the repositories that
// use the kit. The release version lives in the plugin (package.json, marketplace catalogs) and is the
// only thing an update has to move.
const MARKER_RE = /^# omp-reviewer-kit hook-format v(\d+) body-sha256:([0-9a-f]{64})$/;
// Releases up to 0.26.3 wrote the release version into the same place. The digest still has to ignore
// that line, otherwise every hook those releases installed would look like a foreign file and the
// migration would have to touch them by hand.
const LEGACY_RE = /^# omp-reviewer-kit hook v(\d+)\.(\d+)\.(\d+) body-sha256:([0-9a-f]{64})$/;

/** The hook format this release writes. Bump only when the hook body itself must change. */
export const HOOK_FORMAT = 1;

const normalize = (text) => String(text).replace(/\r\n/g, '\n');

/**
 * Digest of a hook without its marker line. Line endings and trailing blank lines do not count.
 * Hooks written before any marker existed have no marker, so this is also their digest.
 *
 * @param {string} text
 * @returns {string} hex SHA-256
 */
export function hookBodyDigest(text) {
  const lines = normalize(text).split('\n');
  const isMarker = (line) => MARKER_RE.test(line ?? '') || LEGACY_RE.test(line ?? '');
  const body = isMarker(lines[1]) ? [lines[0], ...lines.slice(2)] : lines;
  return createHash('sha256').update(body.join('\n').trimEnd()).digest('hex');
}

/**
 * @param {string} text
 * @returns {{ format: number, digest: string }|null} null when the file has no marker
 */
export function parseHookFormat(text) {
  const line = normalize(text).split('\n')[1] ?? '';
  const current = MARKER_RE.exec(line);
  if (current) return { format: Number(current[1]), digest: current[2] };
  // A hook written by a release before formats existed belongs to us as well, and is the oldest format
  // there is: it stays owned, and the next sync replaces it once with the format marker.
  const legacy = LEGACY_RE.exec(line);
  return legacy ? { format: 0, digest: legacy[4] } : null;
}

/** True when the marker is present and the body still matches it: an unedited kit hook of any format. */
export function isOwnedHook(text) {
  const marker = parseHookFormat(text);
  return marker !== null && marker.digest === hookBodyDigest(text);
}

/**
 * True when an installed hook must not be overwritten by the canonical template: it is an unedited kit
 * hook written in a newer format, or the canonical template carries no marker at all.
 *
 * @param {string} installedText
 * @param {string} canonicalText
 * @returns {boolean}
 */
export function isHookNewer(installedText, canonicalText) {
  if (!isOwnedHook(installedText)) return false;
  const canonical = parseHookFormat(canonicalText);
  if (!canonical) return true;
  return parseHookFormat(installedText).format > canonical.format;
}

/**
 * Writes the marker of this format into a hook template, replacing an existing one. Run after every
 * edit of templates/githooks/pre-commit (scripts/stamp-hook.mjs). No release version enters the file.
 *
 * @param {string} text template body, with or without a marker
 * @param {number} [format]
 * @returns {string}
 */
export function stampHookTemplate(text, format = HOOK_FORMAT) {
  const lines = normalize(text).split('\n');
  // Only the canonical marker line is replaced. A marker-shaped line anywhere else is body data — a
  // here-document that documents the marker, for instance — and must survive being stamped.
  const hasMarker = MARKER_RE.test(lines[1] ?? '') || LEGACY_RE.test(lines[1] ?? '');
  const body = (hasMarker ? [lines[0], ...lines.slice(2)] : lines).join('\n');
  const digest = hookBodyDigest(body);
  const [shebang, ...rest] = body.split('\n');
  return [shebang, `# omp-reviewer-kit hook-format v${format} body-sha256:${digest}`, ...rest].join('\n').trimEnd() + '\n';
}
