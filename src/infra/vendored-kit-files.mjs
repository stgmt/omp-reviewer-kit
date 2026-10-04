import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Files the kit vendors into target repositories. They are the review plugin
 * itself, not the committer's work: a staged copy that is byte-identical to the
 * installed kit's canonical file is not reviewed.
 */
export const VENDORED_KIT_FILES = Object.freeze([
  Object.freeze({ target: '.omp/review-kit/run-review.mjs', source: 'scripts/run-review.mjs' }),
  Object.freeze({ target: '.githooks/pre-commit', source: 'templates/githooks/pre-commit' }),
]);

/**
 * Reads the canonical vendored files from the installed OMP plugin
 * (OMP_REVIEW_KIT_PLUGIN_DIR first, then ~/.omp/plugins/node_modules).
 * Any problem yields an empty map, so nothing is exempted from review.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {Promise<Map<string, string>>} target path -> canonical content
 */
export async function loadCanonicalVendoredFiles({ env = process.env, home = homedir() } = {}) {
  const candidates = [
    env.OMP_REVIEW_KIT_PLUGIN_DIR,
    path.join(home, '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (manifest.name !== 'omp-reviewer-kit') continue;
      const files = new Map();
      for (const { target, source } of VENDORED_KIT_FILES) {
        files.set(target, await readFile(path.join(dir, source), 'utf8'));
      }
      return files;
    } catch {
      // try the next candidate
    }
  }
  return new Map();
}
