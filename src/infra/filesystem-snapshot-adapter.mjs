import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SnapshotStorePort } from '../application/ports.mjs';


function assertSafeSnapshotPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(filePath) ||
    filePath.split('/').includes('..')
  ) {
    throw new Error(`Unsafe staged path in snapshot: ${filePath}`);
  }
}

/**
 * Infrastructure adapter materializing a StagedSnapshot onto the filesystem.
 *
 * The returned directory is only a read source for the reviewer. The caller
 * keeps the real repository as its working directory so Git and OMP discovery
 * continue to work normally.
 */
export class FileSystemSnapshotAdapter extends SnapshotStorePort {
  constructor() {
    super();
  }

  /**
   * @param {import('../domain/staged-snapshot.mjs').StagedSnapshot} snapshot
   * @param {{ diffBytes?: Buffer, changedPaths?: string[] }} [artifacts]
   * @returns {Promise<string>}
   */
  async create(snapshot, artifacts) {
    const targetDir = await mkdtemp(path.join(tmpdir(), 'reviewer-kit-snapshot-'));
    try {
      await this.materialize(snapshot, targetDir);
      await this.#writeReviewArtifacts(targetDir, artifacts);
      return targetDir;
    } catch (error) {
      await this.remove(targetDir);
      throw error;
    }
  }

  /**
   * @param {string} snapshotDir
   * @returns {Promise<void>}
   */
  async remove(snapshotDir) {
    await rm(snapshotDir, { recursive: true, force: true });
  }

  /**
   * @param {import('../domain/staged-snapshot.mjs').StagedSnapshot} snapshot
   * @param {string} targetDir
   * @returns {Promise<void>}
   */
  async materialize(snapshot, targetDir) {
    for (const file of snapshot.files) {
      assertSafeSnapshotPath(file.path);
      const normalized = file.path.replace(/\\/g, '/').toLowerCase();
      if (normalized === '.review' || normalized.startsWith('.review/')) {
        throw new Error(`Staged path collides with reserved snapshot artifacts directory: ${file.path}`);
      }
      const destination = path.resolve(targetDir, ...file.path.split('/'));
      const root = path.resolve(targetDir) + path.sep;
      if (!destination.startsWith(root)) {
        throw new Error(`Staged path escapes snapshot directory: ${file.path}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
  }

  async #writeReviewArtifacts(targetDir, artifacts) {
    if (!artifacts || artifacts.artifacts === false || artifacts.diffBytes === undefined) {
      return;
    }
    const reviewDir = path.join(targetDir, '.review');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'diff.patch'), artifacts.diffBytes);
    const manifest = (artifacts.changedPaths ?? []).join('\n') + '\n';
    await writeFile(path.join(reviewDir, 'changed-files.txt'), manifest, 'utf8');
  }
}
