// "Was this module started as a program?" — answered once, for every script.
//
// Decode file URLs and compare their real paths when an installed script is reached through a link.
// The direct comparison also supports paths that no longer exist and Node's preserve-symlinks mode.

import { realpathSync } from 'node:fs';
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
    const modulePath = path.resolve(fileURLToPath(importMetaUrl));
    const entryPath = path.resolve(argv1);
    return modulePath === entryPath || realpathSync.native(modulePath) === realpathSync.native(entryPath);
  } catch {
    return false;
  }
}
