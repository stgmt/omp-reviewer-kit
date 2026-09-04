import { createHash } from 'node:crypto';

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
}
