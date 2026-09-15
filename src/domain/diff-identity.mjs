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
   * `diff --git a/<old> b/<new>` headers (both sides for renames).
   * @returns {string[]}
   */
  get changedPaths() {
    const text = this.#bytes.toString('utf8');
    const seen = new Set();
    for (const header of text.matchAll(/^diff --git (.+)$/gm)) {
      for (const side of header[1].match(/"[^"]*"|\S+/g) ?? []) {
        const raw = side.startsWith('"') ? unquoteGitPath(side) : side;
        seen.add(raw.replace(/^[ab]\//, ''));
      }
    }
    return [...seen];
  }
}
