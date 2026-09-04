import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

const PRE_COMMIT_HOOK_TEMPLATE = `#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
exec node "$root/.omp/review-kit/run-review.mjs"
`;

/**
 * Domain & Application service managing the installation and diagnostics of the Git review hook.
 */
export class PluginInstallerService {
  #pluginRoot;

  constructor({ pluginRoot = PLUGIN_ROOT } = {}) {
    this.#pluginRoot = pluginRoot;
  }

  /**
   * Safe git command execution helper.
   *
   * @param {string[]} args
   * @param {string} cwd
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  runGit(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  /**
   * Resolves top-level git directory for a path.
   *
   * @param {string} cwd
   * @returns {string|null}
   */
  getRepoRoot(cwd) {
    const res = this.runGit(['rev-parse', '--show-toplevel'], cwd);
    if (res.status !== 0 || !res.stdout.trim()) {
      return null;
    }
    return res.stdout.trim();
  }

  /**
   * Installs or repairs the pre-commit review hook in the target repository.
   *
   * @param {string} targetDir
   * @returns {Promise<{ success: boolean, repoRoot: string, message: string }>}
   */
  async setup(targetDir) {
    const repoRoot = this.getRepoRoot(targetDir);
    if (!repoRoot) {
      throw new Error(`Directory is not inside a Git repository: ${targetDir}`);
    }

    const gitHooksDir = path.join(repoRoot, '.githooks');
    const runnerDir = path.join(repoRoot, '.omp', 'review-kit');
    await mkdir(gitHooksDir, { recursive: true });
    await mkdir(runnerDir, { recursive: true });

    // Deploy pre-commit hook
    const hookPath = path.join(gitHooksDir, 'pre-commit');
    await writeFile(hookPath, PRE_COMMIT_HOOK_TEMPLATE, 'utf8');
    if (process.platform !== 'win32') {
      await chmod(hookPath, 0o755);
    }

    // Deploy runner script
    const runnerSourcePath = path.join(this.#pluginRoot, 'scripts', 'run-review.mjs');
    const runnerContent = await readFile(runnerSourcePath, 'utf8');
    const targetRunnerPath = path.join(runnerDir, 'run-review.mjs');
    await writeFile(targetRunnerPath, runnerContent, 'utf8');

    // Configure repository-local core.hooksPath
    const configRes = this.runGit(['config', 'core.hooksPath', '.githooks'], repoRoot);
    if (configRes.status !== 0) {
      throw new Error(`Failed to configure core.hooksPath: ${configRes.stderr.trim()}`);
    }

    return {
      success: true,
      repoRoot,
      message: `Configured pre-commit hook in ${repoRoot} (core.hooksPath .githooks)`,
    };
  }

  /**
   * Inspects the current review hook status in a repository.
   *
   * @param {string} targetDir
   * @returns {Promise<{
   *   isGitRepo: boolean,
   *   repoRoot: string|null,
   *   hooksPathConfigured: boolean,
   *   hookFilePresent: boolean,
   *   runnerPresent: boolean,
   *   isFullyActive: boolean,
   *   latestReview?: { date: string, verdict: string, file: string }
   * }>}
   */
  async status(targetDir) {
    const repoRoot = this.getRepoRoot(targetDir);
    if (!repoRoot) {
      return {
        isGitRepo: false,
        repoRoot: null,
        hooksPathConfigured: false,
        hookFilePresent: false,
        runnerPresent: false,
        isFullyActive: false,
      };
    }

    const hookRes = this.runGit(['config', '--get', 'core.hooksPath'], repoRoot);
    const configuredPath = hookRes.stdout.trim();
    const hooksPathConfigured = hookRes.status === 0 && (configuredPath === '.githooks' || configuredPath.endsWith('.githooks'));

    const hookPath = path.join(repoRoot, '.githooks', 'pre-commit');
    const hookFilePresent = await stat(hookPath).then(() => true).catch(() => false);

    const runnerPath = path.join(repoRoot, '.omp', 'review-kit', 'run-review.mjs');
    const runnerPresent = await stat(runnerPath).then(() => true).catch(() => false);

    const isFullyActive = hooksPathConfigured && hookFilePresent && runnerPresent;

    // Scan for latest review report
    let latestReview;
    const reportsDir = path.join(repoRoot, 'audit-reports', 'commit-reviews');
    try {
      const files = await readdir(reportsDir);
      const mdFiles = files.filter(f => f.endsWith('.md')).sort().reverse();
      if (mdFiles.length > 0) {
        const latestFile = mdFiles[0];
        const content = await readFile(path.join(reportsDir, latestFile), 'utf8');
        const verdictMatch = content.match(/- result: (PASS|BLOCK)/);
        latestReview = {
          file: latestFile,
          verdict: verdictMatch ? verdictMatch[1] : 'UNKNOWN',
          date: latestFile.slice(0, 24).replace(/-/g, (m, offset) => (offset > 18 ? '.' : offset > 10 ? ':' : '-')),
        };
      }
    } catch {
      // No reports yet
    }

    return {
      isGitRepo: true,
      repoRoot,
      hooksPathConfigured,
      hookFilePresent,
      runnerPresent,
      isFullyActive,
      latestReview,
    };
  }

  /**
   * Runs diagnostic health checks on the environment and repository setup.
   *
   * @param {string} targetDir
   * @returns {Promise<{
   *   ok: boolean,
   *   checks: Array<{ name: string, status: 'OK'|'WARN'|'FAIL', message: string }>
   * }>}
   */
  async doctor(targetDir) {
    const checks = [];

    // Check 1: Node.js version
    const nodeVer = process.version;
    const major = parseInt(nodeVer.replace(/^v/, '').split('.')[0], 10);
    if (major >= 18) {
      checks.push({ name: 'Node.js runtime', status: 'OK', message: `${nodeVer} (compatible with >=18)` });
    } else {
      checks.push({ name: 'Node.js runtime', status: 'FAIL', message: `${nodeVer} (requires >=18.0.0)` });
    }

    // Check 2: Git availability
    const gitCheck = this.runGit(['--version'], targetDir);
    if (gitCheck.status === 0) {
      checks.push({ name: 'Git executable', status: 'OK', message: gitCheck.stdout.trim() });
    } else {
      checks.push({ name: 'Git executable', status: 'FAIL', message: 'git command not found on PATH' });
    }

    // Check 3: Repository root
    const repoRoot = this.getRepoRoot(targetDir);
    if (repoRoot) {
      checks.push({ name: 'Git repository', status: 'OK', message: `Root: ${repoRoot}` });
    } else {
      checks.push({ name: 'Git repository', status: 'WARN', message: 'Current directory is not inside a Git repository' });
    }

    // Check 4: OMP CLI availability
    const customOmp = process.env.OMP_REVIEW_KIT_OMP;
    const ompCommand = customOmp || 'omp';
    const isWinWrapper = /\.(cmd|bat)$/i.test(ompCommand);
    const execName = isWinWrapper ? (process.env.ComSpec ?? 'cmd.exe') : ompCommand;
    const execArgs = isWinWrapper ? ['/d', '/c', 'call', ompCommand, '--version'] : ['--version'];

    const ompRes = spawnSync(execName, execArgs, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (ompRes.status === 0 && ompRes.stdout.trim()) {
      checks.push({
        name: 'OMP executable',
        status: 'OK',
        message: `${customOmp ? '(custom) ' : ''}${ompRes.stdout.trim()}`,
      });
    } else {
      checks.push({
        name: 'OMP executable',
        status: 'WARN',
        message: customOmp
          ? `Configured OMP_REVIEW_KIT_OMP ("${customOmp}") did not respond to --version`
          : 'omp command not responding in current environment',
      });
    }

    // Check 5: Hook configuration if in repo
    if (repoRoot) {
      const hookStatus = await this.status(repoRoot);
      if (hookStatus.isFullyActive) {
        checks.push({ name: 'Pre-commit hook', status: 'OK', message: 'Configured and active in .githooks/' });
      } else {
        checks.push({
          name: 'Pre-commit hook',
          status: 'WARN',
          message: 'Hook not fully active. Run /reviewer-kit:setup to initialize.',
        });
      }
    }

    const hasFailure = checks.some(c => c.status === 'FAIL');
    return {
      ok: !hasFailure,
      checks,
    };
  }
}
