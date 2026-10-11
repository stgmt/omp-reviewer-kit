import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ReportStorePort } from '../application/ports.mjs';

/**
 * Root folder for saved review reports. It lies outside every repository: the
 * repository only references a report by its absolute path. Default:
 * `<home>/Documents/omp-reviewer-kit`; `OMP_REVIEW_KIT_REPORTS_DIR` overrides it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string}
 */
export function reportsRootDir({ env = process.env, home = homedir() } = {}) {
  const override = typeof env.OMP_REVIEW_KIT_REPORTS_DIR === 'string' ? env.OMP_REVIEW_KIT_REPORTS_DIR.trim() : '';
  if (override.length > 0) return path.resolve(override);
  return path.join(home, 'Documents', 'omp-reviewer-kit');
}

/**
 * Folder name of one repository's reports: its directory name plus a short hash of its
 * absolute path, so two checkouts that share a directory name (for example every task
 * worktree named `wt`) never share a reports folder.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function repoReportsFolderName(repoRoot) {
  const resolved = path.resolve(repoRoot);
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return `${path.basename(resolved)}-${digest}`;
}

/**
 * The folder holding one repository's reports: `<reports root>/<repository folder name>`.
 *
 * @param {string} repoRoot
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string}
 */
export function repoReportsDir(repoRoot, options = {}) {
  return path.join(reportsRootDir(options), repoReportsFolderName(repoRoot));
}

/**
 * Infrastructure adapter persisting audit reports to a folder outside the repository.
 */
export class FileSystemReportStoreAdapter extends ReportStorePort {
  #rootDir;

  /**
   * @param {{ rootDir?: string }} [options]
   */
  constructor({ rootDir = reportsRootDir() } = {}) {
    super();
    this.#rootDir = rootDir;
  }

  /**
   * @param {string} repoRoot
   * @param {import('../domain/review-report.mjs').ReviewReport} report
   * @returns {Promise<string>} absolute path of the written report
   */
  async saveReport(repoRoot, report) {
    const reportDir = path.join(this.#rootDir, repoReportsFolderName(repoRoot));
    await mkdir(reportDir, { recursive: true });

    const reportPath = path.join(reportDir, report.filename);
    await writeFile(reportPath, report.toMarkdown(), 'utf8');

    return reportPath;
  }
}
