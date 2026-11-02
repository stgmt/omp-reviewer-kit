import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isSkippedTarget } from '../domain/target-policy.mjs';
import { repoIdentity, sameRepository, sameRepositoryPredicate } from './repo-identity.mjs';
import { readRegistration, registrationOf } from './registration-record.mjs';

// A soft bound: concurrent registrations may overshoot it by a few entries.
const MAX_TARGETS = 200;

/** The registry file shared with `scripts/sync-targets.mjs`: a JSON array of repository paths. */
export function defaultTargetRegistryPath(env = process.env) {
  return env.OMP_REVIEW_KIT_TARGETS || path.join(os.homedir(), '.omp', 'review-kit-targets.json');
}

function realOf(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function insideTemp(target) {
  const relative = path.relative(realOf(os.tmpdir()), realOf(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Repositories where the review hook was set up, remembered so that a new runner
 * release reaches every one of them without hand-running a sync.
 *
 * The registry file itself is the owner's: a JSON array the kit only reads. Registrations made
 * by sessions go to one small file each in `<registry file>.d/`, named after a hash of the
 * path, so sessions in different repositories (OMP and Claude Code alike) never rewrite shared
 * state and cannot drop each other's entry.
 */
export class FileTargetRegistry {
  #filePath;
  #entriesDir;
  #ignoreTemp;

  /**
   * @param {{ filePath?: string, ignoreTemp?: boolean }} [options] `ignoreTemp` (on unless a registry
   *   file is configured through OMP_REVIEW_KIT_TARGETS) keeps
   *   throwaway repositories under the OS temp directory out of the default registry.
   */
  constructor({ filePath = defaultTargetRegistryPath(), ignoreTemp = !process.env.OMP_REVIEW_KIT_TARGETS } = {}) {
    this.#filePath = filePath;
    this.#entriesDir = `${filePath}.d`;
    this.#ignoreTemp = ignoreTemp;
  }

  #entryFile(repo) {
    // One registration per repository, keyed by identity, so two spellings of one checkout cannot
    // both be registered and a removal through either spelling finds the same file.
    const key = repoIdentity(repo) ?? repo;
    return path.join(this.#entriesDir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  /** @returns {Promise<string[]>} the owner's entries, then the session registrations oldest first; empty when nothing is readable */
  async list() {
    const listed = [];
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (typeof entry === 'string' && entry.length > 0) listed.push({ repo: path.resolve(entry), addedAt: 0 });
      }
    } catch {
      // a missing or malformed owner file contributes nothing
    }
    let names = [];
    try {
      names = (await readdir(this.#entriesDir)).filter((name) => name.endsWith('.json'));
    } catch {
      // no registrations yet
    }
    const registered = [];
    for (const name of names) {
      try {
        const entry = readRegistration(JSON.parse(await readFile(path.join(this.#entriesDir, name), 'utf8')));
        if (entry) registered.push(entry);
      } catch {
        // a half-written or foreign file is not a registration
      }
    }
    registered.sort((a, b) => a.addedAt - b.addedAt || (a.repo < b.repo ? -1 : 1));
    const repos = [];
    const seen = new Set();
    for (const { repo } of [...listed, ...registered]) {
      const identity = repoIdentity(repo) ?? repo;
      if (seen.has(identity)) continue;
      seen.add(identity);
      repos.push(repo);
    }
    return repos;
  }

  /** @returns {Promise<boolean>} true when the repository was newly added */
  async add(repoRoot) {
    const repo = path.resolve(String(repoRoot ?? ''));
    if (!existsSync(repo) || isSkippedTarget(repo) || (this.#ignoreTemp && insideTemp(repo))) return false;
    const current = await this.list();
    if (current.some((entry) => sameRepository(entry, repo))) return false;
    if (current.length >= MAX_TARGETS) return false;
    await mkdir(this.#entriesDir, { recursive: true });
    const temporary = path.join(this.#entriesDir, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(registrationOf(repo))}\n`, 'utf8');
      await rename(temporary, this.#entryFile(repo));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return true;
  }

  /**
   * Drops a registration made by a session. Entries of the owner's file are never rewritten.
   *
   * A registration is removed by repository identity, not by the file name it happens to carry: an
   * earlier release keyed the file by the written spelling, so an entry registered through an alias
   * lives under a name this release cannot compute from the real path. Every stored entry is read and
   * the matching one is unlinked, whichever spelling or format wrote it.
   *
   * @returns {Promise<boolean>} true when a registration was removed
   */
  async remove(repoRoot) {
    const repo = path.resolve(String(repoRoot ?? ''));
    const matches = sameRepositoryPredicate(repo);
    let names = [];
    try {
      names = (await readdir(this.#entriesDir)).filter((name) => name.endsWith('.json'));
    } catch {
      names = [];
    }
    let removed = false;
    for (const name of names) {
      const file = path.join(this.#entriesDir, name);
      let stored = null;
      try {
        stored = readRegistration(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        stored = null;
      }
      const keyedHere = file === this.#entryFile(repo);
      if (stored === null ? !keyedHere : !matches(stored.repo)) continue;
      try {
        await unlink(file);
        removed = true;
      } catch {
        // A file another session already removed is not a failure.
      }
    }
    return removed;
  }
}
