// The kit's own identity: its version and a digest of the agent prompts. A journal entry written by
// another version or another prompt is not reusable — the review that produced it asked a different
// question, even when the diff bytes are identical.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The version declared by the kit's `package.json`, or null when it cannot be read.
 *
 * @param {string} kitRoot
 * @returns {Promise<string|null>}
 */
export async function readKitVersion(kitRoot) {
  try {
    const parsed = JSON.parse(await readFile(path.join(kitRoot, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * A digest over every agent prompt of the kit, sorted by file name. Two kits with the same version
 * but an edited prompt produce different digests, so a stored stage is never reused across a prompt
 * change.
 *
 * @param {string} kitRoot
 * @returns {Promise<string|null>}
 */
export async function readAgentsDigest(kitRoot) {
  try {
    const dir = path.join(kitRoot, 'agents');
    const names = (await readdir(dir)).filter(name => name.endsWith('.md')).sort();
    if (names.length === 0) return null;
    const hash = createHash('sha256');
    for (const name of names) {
      const body = await readFile(path.join(dir, name), 'utf8');
      hash.update(name);
      hash.update('\u0000');
      hash.update(body.replace(/\r\n/g, '\n'));
      hash.update('\u0000');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
