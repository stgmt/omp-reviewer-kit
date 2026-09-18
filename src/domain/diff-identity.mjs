import { createHash } from 'node:crypto';

/**
 * Unquote a Git-quoted path. Git quotes paths containing special characters and
 * represents non-ASCII bytes as C-style octal escapes (e.g. `\303\251` for é)
 * when `core.quotepath` is true (the default). Each `\ooo` sequence is one raw
 * byte; consecutive octal escapes form multi-byte UTF-8 sequences.
 */
export function unquoteGitPath(quoted) {
  const inner = quoted.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 3 < inner.length && /[0-7]/.test(inner[i + 1]) && /[0-7]/.test(inner[i + 2]) && /[0-7]/.test(inner[i + 3])) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (inner[i] === '\\' && inner[i + 1] === '\\') {
      bytes.push(0x5c);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === '"') {
      bytes.push(0x22);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === 't') {
      bytes.push(0x09);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === 'n') {
      bytes.push(0x0a);
      i += 1;
    } else {
      bytes.push(inner.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Extracts the old/new paths of one `diff --git` block. The
 * `diff --git a/<old> b/<new>` header is ambiguous for unquoted paths
 * containing ` b/`, so paths are read from single-path lines first:
 * `rename from/to`, `copy from/to`, then `---`/`+++`. The header is the
 * last resort for mode-only blocks that carry none of those lines.
 * `/dev/null` sides yield null.
 * @param {string} blockText - one diff block starting at `diff --git`
 * @returns {{ oldPath: string|null, newPath: string|null }}
 */
export function diffBlockPaths(blockText) {
  const decode = (side, stripPrefix) => {
    if (!side || side === '/dev/null') return null;
    const raw = side.startsWith('"') ? unquoteGitPath(side) : side;
    return stripPrefix ? raw.replace(/^[ab]\//, '') : raw;
  };
  const line = (re, stripPrefix) => {
    const match = re.exec(blockText);
    return match ? decode(match[1].trimEnd(), stripPrefix) : null;
  };
  // rename/copy lines carry bare paths; ---/+++ carry a//b/ prefixes.
  let oldPath = line(/^rename from (.+)$/m, false) ?? line(/^copy from (.+)$/m, false) ?? line(/^--- (.+)$/m, true);
  let newPath = line(/^rename to (.+)$/m, false) ?? line(/^copy to (.+)$/m, false) ?? line(/^\+\+\+ (.+)$/m, true);
  if (oldPath === null && newPath === null) {
    // blockText starts right after `diff --git ` — its first line is the header.
    const header = blockText.slice(0, blockText.indexOf('\n') === -1 ? undefined : blockText.indexOf('\n'));
    const sides = /^(?:"((?:[^"\\]|\\.)*)"|(a\/.*?)) (?:"((?:[^"\\]|\\.)*)"|(b\/.*))$/.exec(header.trimEnd());
    if (sides) {
      oldPath = decode(sides[1] !== undefined ? `"${sides[1]}"` : sides[2], true);
      newPath = decode(sides[3] !== undefined ? `"${sides[3]}"` : sides[4], true);
    }
  }
  return { oldPath, newPath };
}

/**
 * Value Object representing a staged Git diff and its deterministic cryptographic identity.
 */
export class DiffIdentity {
  #bytes;
  #hash;

  /**
   * @param {Buffer} buffer
   */
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('DiffIdentity expects a Buffer');
    }
    this.#bytes = buffer;
    this.#hash = createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * @param {Buffer} buffer
   * @returns {DiffIdentity}
   */
  static fromBuffer(buffer) {
    return new DiffIdentity(buffer);
  }

  /**
   * @param {string} text
   * @returns {DiffIdentity}
   */
  static fromString(text) {
    return new DiffIdentity(Buffer.from(text, 'utf8'));
  }

  /**
   * @returns {boolean}
   */
  isEmpty() {
    return this.#bytes.length === 0;
  }

  /**
   * @returns {string} SHA-256 hexadecimal digest
   */
  get hash() {
    return this.#hash;
  }

  /**
   * @returns {Buffer}
   */
  get bytes() {
    return this.#bytes;
  }

  /**
   * @returns {number}
   */
  get length() {
    return this.#bytes.length;
  }

  /**
   * Unique repository-relative paths touched by this diff, parsed from
   * each block's `---`/`+++` lines (both sides for renames).
   * @returns {string[]}
   */
  get changedPaths() {
    const text = this.#bytes.toString('utf8');
    const seen = new Set();
    for (const blockText of text.split(/^diff --git /m).slice(1)) {
      const { oldPath, newPath } = diffBlockPaths(blockText);
      if (oldPath) seen.add(oldPath);
      if (newPath) seen.add(newPath);
    }
    return [...seen];
  }
}
