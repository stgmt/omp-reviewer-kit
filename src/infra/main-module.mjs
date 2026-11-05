// "Was this module started as a program?" — answered once, for every script.
//
// `new URL(import.meta.url).pathname` is percent-encoded: an installation under a path with a space
// compares unequal to the literal `process.argv[1]` and the script silently does nothing. `fileURLToPath`
// decodes it, which is the only correct comparison on Windows and on POSIX.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} importMetaUrl `import.meta.url` of the calling module
 * @param {string|undefined} [argv1] defaults to the process entry path
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return path.resolve(fileURLToPath(importMetaUrl)) === path.resolve(argv1);
  } catch {
    return false;
  }
}
