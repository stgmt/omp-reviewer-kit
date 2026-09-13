import { createHash } from 'node:crypto';

/**
 * Immutable value object containing the complete staged index tree.
 */
export class StagedSnapshot {
  #files;
  #hash;

  /**
   * @param {{ path: string, content: Buffer }[]} files
   */
  constructor(files) {
    if (!Array.isArray(files)) {
      throw new TypeError('StagedSnapshot expects an array of files');
    }

    const normalizedFiles = files.map((file) => {
      if (!file || typeof file.path !== 'string' || !Buffer.isBuffer(file.content)) {
        throw new TypeError('StagedSnapshot files require a string path and Buffer content');
      }
      return Object.freeze({ path: file.path, content: Buffer.from(file.content) });
    });

    const hash = createHash('sha256');
    for (const file of normalizedFiles) {
      hash.update(file.path);
      hash.update('\0');
      hash.update(file.content);
      hash.update('\0');
    }

    this.#files = Object.freeze(normalizedFiles);
    this.#hash = hash.digest('hex');
  }

  /** @returns {readonly { path: string, content: Buffer }[]} */
  get files() {
    return this.#files;
  }

  /** @returns {string} */
  get hash() {
    return this.#hash;
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.#files.length === 0;
  }
}
