import { createHash } from 'node:crypto';

// A safety net for git's default hooks directory. Another tool can point core.hooksPath at it (Claude Code
// Agent Teams does when it creates a worktree), which silently switches the review hook off. A shim stored
// there still starts the repository's own .githooks/pre-commit, so the review runs from any worktree.
//
// Line 2 carries the shim format version and a digest of every other line, like the hook template marker
// (src/domain/hook-template.mjs), but the version is the shim format, not the release: the shim body does
// not change between releases, so a release never rewrites it.
export const HOOK_SHIM_FORMAT = 1;

const SHIM_MARKER_RE = /^# omp-reviewer-kit hook-shim v(\d+) body-sha256:([0-9a-f]{64})$/;

const normalize = (text) => String(text).replace(/\r\n/g, '\n');

const SHIM_LINES = [
  '#!/bin/sh',
  '# Starts the repository review hook (.githooks/pre-commit) when git runs this file instead of it.',
  '# Git runs hooks in the root of the working tree, so the current directory is the checkout that is committing.',
  'root=$(pwd)',
  'if [ -f "$root/.githooks/pre-commit" ]; then',
  '  exec sh "$root/.githooks/pre-commit" "$@"',
  'fi',
  'echo "omp-reviewer-kit: $root has no .githooks/pre-commit; this commit was not reviewed" >&2',
  'exit 0',
];

function shimDigest(text) {
  const lines = normalize(text).split('\n');
  const body = SHIM_MARKER_RE.test(lines[1] ?? '') ? [lines[0], ...lines.slice(2)] : lines;
  return createHash('sha256').update(body.join('\n').trimEnd()).digest('hex');
}

/** The shim exactly as it is written to <git common dir>/hooks/pre-commit. */
export const HOOK_SHIM = (() => {
  const digest = shimDigest(SHIM_LINES.join('\n'));
  const [shebang, ...rest] = SHIM_LINES;
  return [shebang, `# omp-reviewer-kit hook-shim v${HOOK_SHIM_FORMAT} body-sha256:${digest}`, ...rest].join('\n') + '\n';
})();

/**
 * @param {string} text
 * @returns {{ format: number, digest: string }|null} null when the file carries no shim marker
 */
export function parseShimMarker(text) {
  const match = SHIM_MARKER_RE.exec(normalize(text).split('\n')[1] ?? '');
  return match ? { format: Number(match[1]), digest: match[2] } : null;
}

/** True when the marker is present and the body still matches it: an unedited kit shim of any format. */
export function isOwnedShim(text) {
  const marker = parseShimMarker(text);
  return marker !== null && marker.digest === shimDigest(text);
}

/** True when an installed shim must not be replaced by this release's: it is unedited and of a newer format. */
export function isShimNewer(text) {
  return isOwnedShim(text) && parseShimMarker(text).format > HOOK_SHIM_FORMAT;
}
