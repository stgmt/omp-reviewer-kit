import { createHash } from 'node:crypto';

// Husky (v9) owns core.hooksPath and generates "<hooksDir>/pre-commit" as a two-line shim that
// sources its sibling "h"; that "h" always ends with `exit`, so a block appended after the source
// line would never run. The kit therefore inserts a marked block *before* the host's lines: an EXIT
// trap that runs the review once the host hook has finished, with the host's exit code preserved.
// The host's own bytes are never rewritten, and the block is the only thing the kit ever replaces.
//
// The format changes when the block body changes in a way an older release cannot read; the release
// version never enters the file.
const START_RE = /^# >>> omp-reviewer-kit chain v(\d+) body-sha256:([0-9a-f]{64})$/;
const END_RE = /^# <<< omp-reviewer-kit chain v(\d+)$/;

/** The chain block format this release writes. */
export const CHAIN_FORMAT = 1;

const normalize = (text) => String(text).replace(/\r\n/g, '\n');

const BODY = [
  '# Runs the staged-change review after the host hook. This block is rewritten by omp-reviewer-kit; do not edit it.',
  '__omp_review_kit_exit() {',
  '  __omp_review_kit_rc=$?',
  '  if [ "$__omp_review_kit_rc" -eq 0 ]; then',
  '    __omp_review_kit_root=$(git rev-parse --show-toplevel 2>/dev/null) || __omp_review_kit_root=$(pwd)',
  '    if [ ! -f "$__omp_review_kit_root/.omp/review-kit/run-review.mjs" ]; then',
  '      echo "reviewer-kit: .omp/review-kit/run-review.mjs is missing; refusing to commit unreviewed" >&2',
  '      __omp_review_kit_rc=1',
  '    else',
  '      node "$__omp_review_kit_root/.omp/review-kit/run-review.mjs" || __omp_review_kit_rc=$?',
  '    fi',
  '  fi',
  '  exit "$__omp_review_kit_rc"',
  '}',
  'trap __omp_review_kit_exit EXIT',
];

function bodyDigest(body) {
  return createHash('sha256').update(body.join('\n').trimEnd()).digest('hex');
}

/**
 * The block exactly as it is inserted into a foreign hook.
 *
 * @param {'\n'|'\r\n'} [eol]
 * @returns {string}
 */
export function renderChainBlock(eol = '\n') {
  const digest = bodyDigest(BODY);
  return [
    `# >>> omp-reviewer-kit chain v${CHAIN_FORMAT} body-sha256:${digest}`,
    ...BODY,
    `# <<< omp-reviewer-kit chain v${CHAIN_FORMAT}`,
  ].join(eol) + eol;
}

/**
 * @param {string} text
 * @returns {{ format: number, digest: string, owned: boolean, start: number, end: number }|null}
 *   line indexes are inclusive; null when the file carries no chain marker
 */
export function readChainBlock(text) {
  const lines = normalize(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const start = START_RE.exec(lines[index]);
    if (!start) continue;
    for (let end = index + 1; end < lines.length; end += 1) {
      const close = END_RE.exec(lines[end]);
      if (!close) continue;
      const body = lines.slice(index + 1, end);
      return {
        format: Number(start[1]),
        digest: start[2],
        owned: close[1] === start[1] && bodyDigest(body) === start[2],
        start: index,
        end,
      };
    }
    return { format: Number(start[1]), digest: start[2], owned: false, start: index, end: -1 };
  }
  return null;
}

/** True when the block is present and its body still matches the marker: an unedited kit block. */
export function isOwnedChain(text) {
  return readChainBlock(text)?.owned === true;
}

/** True when an installed block must not be replaced by this release's: unedited and of a newer format. */
export function isChainNewer(text) {
  const block = readChainBlock(text);
  return block !== null && block.owned && block.format > CHAIN_FORMAT;
}

/**
 * Inserts the block into a foreign hook, or replaces an unedited block of this or an older format.
 * The block goes after the shebang so the host stays executable, and the host's lines are kept
 * byte-identical. An edited block is refused: the kit does not overwrite lines it did not write.
 *
 * @param {string} text
 * @returns {{ text: string, action: 'inserted'|'replaced'|'unchanged'|'newer' }}
 * @throws when a marker is present but its body no longer matches it
 */
export function withChainBlock(text) {
  const source = String(text);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const block = readChainBlock(source);
  if (block !== null && !block.owned) {
    throw new Error('edited omp-reviewer-kit chain block');
  }
  if (block !== null && block.format > CHAIN_FORMAT) return { text: source, action: 'newer' };

  const canonical = renderChainBlock(eol);
  const canonicalLines = canonical.slice(0, -eol.length).split(eol);
  const lines = source.split(/\r?\n/);

  if (block === null) {
    const at = lines.length > 0 && lines[0].startsWith('#!') ? 1 : 0;
    const next = [...lines.slice(0, at), ...canonicalLines, ...lines.slice(at)].join(eol);
    return { text: next, action: 'inserted' };
  }

  const current = lines.slice(block.start, block.end + 1).join(eol) + eol;
  if (current === canonical) return { text: source, action: 'unchanged' };
  const next = [...lines.slice(0, block.start), ...canonicalLines, ...lines.slice(block.end + 1)].join(eol);
  return { text: next, action: 'replaced' };
}

// A host hook that ends with `exec` replaces the shell: an EXIT trap installed before it never
// runs, so the review would be skipped silently. pre-commit's generated hook is this shape; so is
// any hook that execs its runner. The test deliberately looks anywhere in the text (a string or a
// comment included): refusing a chainable host is a stated conflict, while chaining into an exec
// host is an unreviewed commit.
const UNSAFE_EXEC_RE = /(^|[^A-Za-z0-9_])exec[ \t]/;
// A host that installs its own trap can replace the EXIT trap the review block relies on. The code
// cannot know which signal a trap names, so any trap is refused: a stated conflict is safe, a
// silently skipped review is not.
const EXIT_TRAP_RE = /(^|[^A-Za-z0-9_])trap[ \t]/;

/**
 * True when a hook replaces the shell, so a review block placed before its lines cannot run.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasUnsafeExec(text) {
  return UNSAFE_EXEC_RE.test(normalize(text));
}

/**
 * The host's own lines, with a block this kit inserted removed. A block the host already carries is
 * not part of what the host does: it must not make the host look unsafe to chain into.
 *
 * @param {string} text
 * @returns {string}
 */
export function hostText(text) {
  const source = normalize(text);
  const block = readChainBlock(source);
  if (block === null || !block.owned) return source;
  return source.split('\n').filter((_, index) => index < block.start || index > block.end).join('\n');
}

/**
 * True when a review block placed before the host's lines cannot be trusted to run: the host
 * replaces the shell with `exec`, or installs its own trap over the `EXIT` trap the block uses.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function unsafeHostControl(text) {
  const host = hostText(text);
  return UNSAFE_EXEC_RE.test(host) || EXIT_TRAP_RE.test(host);
}

// The review block is POSIX shell. A hook for another interpreter (python, node, ruby) runs the whole
// file as that language, so the block would be a syntax error there; git falls back to sh when the
// file has no shebang, and every common POSIX shell runs the block unchanged.
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'yash', 'posh']);

/**
 * The interpreter name of a hook's shebang, or "sh" for a hook without one (git runs it with sh).
 *
 * @param {string} text
 * @returns {string}
 */
export function hostShellName(text) {
  const first = normalize(text).split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) return 'sh';
  const words = first.slice(2).trim().split(/\s+/).filter(Boolean);
  const base = (value) => value.split(/[\\/]/).pop() ?? value;
  if (words.length === 0) return 'sh';
  let name = base(words[0]);
  if (name === 'env') {
    const rest = words.slice(1).filter((word) => !word.startsWith('-'));
    name = rest.length ? base(rest[0]) : 'env';
  }
  return name;
}

/** True when the hook runs under a POSIX shell (or has no shebang), so the review block can be inserted. */
export function isShellHost(text) {
  return SHELLS.has(hostShellName(text));
}
