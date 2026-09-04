import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReportStorePort } from '../application/ports.mjs';

/**
 * Infrastructure adapter persisting audit reports to the local filesystem.
 */
export class FileSystemReportStoreAdapter extends ReportStorePort {
  #relativeDir;

  /**
   * @param {string} [relativeDir='audit-reports/commit-reviews']
   */
  constructor(relativeDir = path.join('audit-reports', 'commit-reviews')) {
    super();
    this.#relativeDir = relativeDir;
  }

  /**
   * @param {string} repoRoot
   * @param {import('../domain/review-report.mjs').ReviewReport} report
   * @returns {Promise<string>}
   */
  async saveReport(repoRoot, report) {
    const reportDir = path.join(repoRoot, this.#relativeDir);
    await mkdir(reportDir, { recursive: true });

    const reportPath = path.join(reportDir, report.filename);
    await writeFile(reportPath, report.toMarkdown(), 'utf8');

    return reportPath;
  }
}
