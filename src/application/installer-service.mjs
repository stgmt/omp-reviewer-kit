import { constants, lstatSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function normalizePath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeLineEndings(str) {
  return str.replace(/\r\n/g, '\n').trimEnd();
}

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pinnedDirectoryPath(handle) {
  if (process.platform === 'linux') return '/proc/self/fd/' + handle.fd;
  if (process.platform === 'darwin') return '/dev/fd/' + handle.fd;
  throw new Error('Refusing POSIX installation on unsupported platform: ' + process.platform);
}

async function createSafeDirectory(repoRoot, directoryPath) {
  const relativePath = path.relative(repoRoot, directoryPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Refusing to write outside repository root: ' + directoryPath);
  }

  if (process.platform === 'win32') {
    let safePath = await realpath(repoRoot);
    for (const component of relativePath.split(path.sep).filter(Boolean)) {
      safePath = path.join(safePath, component);
      try {
        await mkdir(safePath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const directoryStat = await lstat(safePath);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error('Refusing to write through non-directory component: ' + safePath);
      }
    }
    return { path: safePath, handle: null };
  }

  const directoryFlags = constants.O_RDONLY
    | (constants.O_DIRECTORY ?? 0)
    | (constants.O_NOFOLLOW ?? 0);
  let currentHandle;
  try {
    currentHandle = await open(await realpath(repoRoot), directoryFlags);
    let currentPath = pinnedDirectoryPath(currentHandle);
    for (const component of relativePath.split(path.sep).filter(Boolean)) {
      const childPath = path.join(currentPath, component);
      try {
        await mkdir(childPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const nextHandle = await open(childPath, directoryFlags);
      await currentHandle.close();
      currentHandle = nextHandle;
      currentPath = pinnedDirectoryPath(currentHandle);
    }
    const directoryStat = await currentHandle.stat();
    if (!directoryStat.isDirectory()) {
      throw new Error('Refusing to write through non-directory component: ' + directoryPath);
    }
    return { path: currentPath, handle: currentHandle };
  } catch (error) {
    await currentHandle?.close().catch(() => {});
    throw error;
  }
}

async function readRegularFile(filePath) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error('Unable to inspect existing file ' + filePath + ': path is not a regular file');
    }
    return {
      content: await handle.readFile({ encoding: 'utf8' }),
      mode: fileStat.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function verifyRegularFile(filePath, mode) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error('Refusing to install a non-regular file: ' + filePath);
    }
    if (mode !== undefined && process.platform !== 'win32') {
      await handle.chmod(mode);
    }
    return fileStat;
  } finally {
    await handle.close();
  }
}

function resolveGitExecutable(cwd) {
  if (process.platform !== 'win32') return 'git';

  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, 'Git', 'cmd', 'git.exe'),
    path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'),
  ]);
  const trustedCandidate = candidates.find(isRegularFile);
  if (trustedCandidate) return trustedCandidate;

  // Resolve PATH from a trusted working directory, never from the repository
  // being inspected. Reject a repository-local result and fail closed if no
  // trusted Git executable is available.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const where = path.join(system32, 'where.exe');
  const result = spawnSync(where, ['git.exe'], {
    cwd: system32,
    encoding: 'utf8',
    windowsHide: true,
  });
  const normalizedCwd = normalizePath(cwd);
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const candidate = line.trim();
    if (!path.isAbsolute(candidate) || !isRegularFile(candidate)) continue;
    const normalizedCandidate = normalizePath(candidate);
    if (normalizedCandidate === normalizedCwd || normalizedCandidate.startsWith(normalizedCwd + path.sep)) continue;
    return candidate;
  }

  return path.join(system32, 'git.exe');
}

function quotePowerShellString(value) {
  return "'" + String(value).replaceAll('\\', '/').replaceAll("'", "''") + "'";
}

function writeFileAtomicallyOnWindows(directoryPath, destinationPath, content) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const typeDefinition = "using System; using System.Text; using System.Runtime.InteropServices; public static class AtomicMove { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle); [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint capacity, uint flags); [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existingFileName, string newFileName, uint flags); public static string FinalPath(IntPtr handle) { var path = new StringBuilder(32768); var length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0); return length == 0 ? null : path.ToString(); } public static bool IsSamePath(IntPtr handle, string expected) { var actual = FinalPath(handle); if (actual == null) return false; if (actual.Length >= 4 && actual[0] == (char)92 && actual[1] == (char)92 && actual[2] == '?' && actual[3] == (char)92) actual = actual.Substring(4); actual = actual.Replace((char)92, (char)47).TrimEnd((char)47); expected = System.IO.Path.GetFullPath(expected).Replace((char)92, (char)47).TrimEnd((char)47); return String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase); } }";
  const command = 'Add-Type -TypeDefinition ' + quotePowerShellString(typeDefinition)
    + '; $handle = [AtomicMove]::CreateFile(' + quotePowerShellString(directoryPath) + ', 2147483648, 3, [IntPtr]::Zero, 3, 35651584, [IntPtr]::Zero);'
    + ' if ($handle -eq [IntPtr]::Zero -or $handle.ToInt64() -eq -1) { throw "Unable to pin installer directory" };'
    + ' try { $expected = ' + quotePowerShellString(directoryPath) + ';'
    + ' if (-not [AtomicMove]::IsSamePath($handle, $expected)) { throw ("Installer directory changed during validation: " + [AtomicMove]::FinalPath($handle) + " expected " + $expected) };'
    + ' $temp = [IO.Path]::Combine($expected, ".tmp-" + [IO.Path]::GetRandomFileName());'
    + ' try { $contentStream = New-Object System.IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($contentStream); [IO.File]::WriteAllBytes($temp, $contentStream.ToArray()); $contentStream.Dispose();'
    + ' if (-not [AtomicMove]::MoveFileEx($temp, ' + quotePowerShellString(destinationPath) + ', 9)) { throw "Atomic Windows file replacement failed" } }'
    + ' finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } } } finally { [AtomicMove]::CloseHandle($handle) | Out-Null }';
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync(powershellPath, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedCommand,
  ], { encoding: 'utf8', windowsHide: true, input: Buffer.from(content, 'utf8') });
  if (result.error || result.status !== 0) {
    throw new Error('Atomic Windows file replacement failed: ' + destinationPath);
  }
}

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
    const result = spawnSync(resolveGitExecutable(cwd), args, { cwd, encoding: 'utf8', windowsHide: true });
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
   * Atomically writes content to filePath only if content or permissions differ.
   *
   * @param {string} filePath
   * @param {string} content
   * @param {number} [mode]
   * @returns {Promise<boolean>} True if file was written/updated, false if unchanged.
   */
  async #writeIfChanged(repoRoot, filePath, content, mode) {
    await this.#assertNoSymlinkComponents(repoRoot, filePath);

    const dir = path.dirname(filePath);
    await this.#assertNoSymlinkComponents(repoRoot, dir);
    const safeDirectory = await createSafeDirectory(repoRoot, dir);
    const safeDir = safeDirectory.path;
    const safeFilePath = path.join(safeDir, path.basename(filePath));

    try {
      let existingContent;
      let existingMode;
      try {
        const existing = await readRegularFile(safeFilePath);
        existingContent = existing.content;
        existingMode = existing.mode;
        if (existingContent === content) {
          if (mode !== undefined && process.platform !== 'win32' && existingMode !== mode) {
            await verifyRegularFile(safeFilePath, mode);
            return true;
          }
          return false;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      if (process.platform === 'win32') {
        writeFileAtomicallyOnWindows(safeDir, safeFilePath, content);
        return true;
      }

      const suffix = Date.now() + '-' + Math.random().toString(36).slice(2);
      const tmpPath = path.join(safeDir, '.tmp-' + path.basename(safeFilePath) + '-' + suffix);
      let temporaryCreated = false;

      const removeNonDirectory = async (targetPath) => {
        try {
          const targetStat = await lstat(targetPath);
          if (!targetStat.isDirectory()) await unlink(targetPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };

      try {
        await writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
        temporaryCreated = true;
        await verifyRegularFile(tmpPath, mode);
        const verifiedTemporaryStat = await lstat(tmpPath);
        if (!verifiedTemporaryStat.isFile()) {
          throw new Error('Refusing to install a non-regular temporary file: ' + tmpPath);
        }

        await rename(tmpPath, safeFilePath);
        temporaryCreated = false;
        return true;
      } catch (error) {
        if (temporaryCreated) await removeNonDirectory(tmpPath);
        throw error;
      }
    } finally {
      await safeDirectory.handle?.close();
    }
  }

  async #findSymlinkComponent(repoRoot, targetPath) {
    const relativePath = path.relative(repoRoot, targetPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return targetPath;
    }

    let currentPath = repoRoot;
    for (const component of relativePath.split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, component);
      try {
        const currentStat = await lstat(currentPath);
        if (currentStat.isSymbolicLink()) {
          return currentPath;
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    }
    return null;
  }

  async #assertNoSymlinkComponents(repoRoot, targetPath) {
    const symlinkPath = await this.#findSymlinkComponent(repoRoot, targetPath);
    if (symlinkPath) {
      throw new Error('Refusing to write through symlink component: ' + symlinkPath);
    }
  }

  /**
   * Inspects repository hook state without performing mutations.
   *
   * @param {string} targetDir
   * @returns {Promise<{
   *   isGitRepo: boolean,
   *   repoRoot: string|null,
   *   state: 'not-git'|'inactive'|'stale'|'active'|'conflict',
   *   configuredHooksPath: string|null,
   *   hooksPathConfigured: boolean,
   *   hookFilePresent: boolean,
   *   hookOwned: boolean,
   *   runnerPresent: boolean,
   *   runnerCurrent: boolean,
   *   isFullyActive: boolean,
   *   conflictReason: string|null
   * }>}
   */
  async #inspectInstallation(targetDir) {
    const repoRoot = this.getRepoRoot(targetDir);
    if (!repoRoot) {
      return {
        isGitRepo: false,
        repoRoot: null,
        state: 'not-git',
        configuredHooksPath: null,
        hooksPathConfigured: false,
        hookFilePresent: false,
        hookOwned: false,
        runnerPresent: false,
        runnerCurrent: false,
        isFullyActive: false,
        conflictReason: null,
      };
    }

    const canonicalHookPath = path.join(this.#pluginRoot, 'templates', 'githooks', 'pre-commit');
    const canonicalRunnerPath = path.join(this.#pluginRoot, 'scripts', 'run-review.mjs');
    const canonicalHookTemplate = await readFile(canonicalHookPath, 'utf8');
    const canonicalRunnerContent = await readFile(canonicalRunnerPath, 'utf8');

    const expectedGithooksDir = path.join(repoRoot, '.githooks');
    let hooksPathConfigured = false;
    let conflictReason = null;

    const hookRes = this.runGit(['config', '--get', 'core.hooksPath'], repoRoot);
    const configuredHooksPath = hookRes.status === 0 && hookRes.stdout.trim() ? hookRes.stdout.trim() : null;

    if (configuredHooksPath !== null) {
      const resolvedConfigured = path.resolve(repoRoot, configuredHooksPath);
      if (normalizePath(resolvedConfigured) === normalizePath(expectedGithooksDir)) {
        hooksPathConfigured = true;
      } else {
        conflictReason = `core.hooksPath is configured to "${configuredHooksPath}" (expected ".githooks")`;
      }
    } else {
      const gitPathRes = this.runGit(['rev-parse', '--git-path', 'hooks'], repoRoot);
      const standardHooksRelative = gitPathRes.status === 0 && gitPathRes.stdout.trim()
        ? gitPathRes.stdout.trim()
        : path.join('.git', 'hooks');
      const standardHooksDir = path.resolve(repoRoot, standardHooksRelative);

      try {
        const entries = await readdir(standardHooksDir);
        const activeHooks = entries.filter((name) => !name.endsWith('.sample'));
        if (activeHooks.length > 0) {
          conflictReason = `Existing hooks found in standard hooks directory (${activeHooks.join(', ')}); switching core.hooksPath would bypass them`;
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // Standard hooks directory does not exist.
        } else if (!conflictReason) {
          conflictReason = 'Unable to inspect standard hooks directory: ' + (error?.message ?? error);
        }
      }
    }

    const hookPath = path.join(expectedGithooksDir, 'pre-commit');
    let hookFilePresent = false;
    let hookOwned = false;
    let hookExecutable = process.platform === 'win32';
    const hookSymlinkPath = await this.#findSymlinkComponent(repoRoot, hookPath);

    if (hookSymlinkPath) {
      hookFilePresent = true;
      if (!conflictReason) {
        conflictReason = 'Existing .githooks/pre-commit path contains symlink component: ' + hookSymlinkPath;
      }
    } else {
      try {
        const hookStat = await lstat(hookPath);
        hookFilePresent = true;
        hookExecutable = process.platform === 'win32' || (hookStat.mode & 0o111) !== 0;
        if (!hookStat.isFile()) {
          if (!conflictReason) {
            conflictReason = 'Unable to inspect existing .githooks/pre-commit: path is not a regular file';
          }
        } else {
          const hookContent = await readFile(hookPath, 'utf8');
          if (normalizeLineEndings(hookContent) === normalizeLineEndings(canonicalHookTemplate)) {
            hookOwned = true;
          } else if (!conflictReason) {
            conflictReason = 'Existing .githooks/pre-commit does not match omp-reviewer-kit template';
          }
        }
      } catch (error) {
        hookOwned = false;
        if (error?.code !== 'ENOENT' && !conflictReason) {
          conflictReason = 'Unable to inspect existing .githooks/pre-commit: ' + (error?.message ?? error);
        }
      }
    }

    const runnerPath = path.join(repoRoot, '.omp', 'review-kit', 'run-review.mjs');
    let runnerPresent = false;
    let runnerCurrent = false;
    const runnerSymlinkPath = await this.#findSymlinkComponent(repoRoot, runnerPath);

    if (runnerSymlinkPath) {
      runnerPresent = true;
      if (!conflictReason) {
        conflictReason = 'Existing .omp/review-kit runner path contains symlink component: ' + runnerSymlinkPath;
      }
    } else {
      try {
        const runnerStat = await lstat(runnerPath);
        runnerPresent = true;
        if (!runnerStat.isFile()) {
          if (!conflictReason) {
            conflictReason = 'Unable to inspect existing .omp/review-kit/run-review.mjs: path is not a regular file';
          }
        } else {
          const runnerContent = await readFile(runnerPath, 'utf8');
          runnerCurrent = runnerContent === canonicalRunnerContent;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && !conflictReason) {
          conflictReason = 'Unable to inspect existing .omp/review-kit/run-review.mjs: ' + (error?.message ?? error);
        }
      }
    }

    let state;
    const hookUsable = hookFilePresent && hookOwned && hookExecutable;
    if (conflictReason) {
      state = 'conflict';
    } else if (hooksPathConfigured && hookUsable && runnerPresent && runnerCurrent) {
      state = 'active';
    } else if (hooksPathConfigured && hookOwned && runnerPresent && (!runnerCurrent || !hookExecutable)) {
      state = 'stale';
    } else {
      state = 'inactive';
    }

    return {
      isGitRepo: true,
      repoRoot,
      state,
      configuredHooksPath,
      hooksPathConfigured,
      hookFilePresent,
      hookOwned,
      runnerPresent,
      runnerCurrent,
      hookExecutable,
      isFullyActive: state === 'active',
      conflictReason,
    };
  }

  /**
   * Installs or repairs the pre-commit review hook in the target repository.
   *
   * @param {string} targetDir
   * @returns {Promise<{
   *   success: boolean,
   *   state: 'installed'|'updated'|'active'|'conflict',
   *   repoRoot: string,
   *   message: string
   * }>}
   */
  async setup(targetDir) {
    const inspection = await this.#inspectInstallation(targetDir);
    if (!inspection.isGitRepo) {
      throw new Error('Directory is not inside a Git repository: ' + targetDir);
    }

    if (inspection.state === 'conflict') {
      return {
        success: false,
        state: 'conflict',
        repoRoot: inspection.repoRoot,
        message: inspection.conflictReason ?? 'Pre-commit hook conflict detected',
      };
    }

    if (inspection.state === 'active') {
      return {
        success: true,
        state: 'active',
        repoRoot: inspection.repoRoot,
        message: 'Pre-commit hook already active in ' + inspection.repoRoot,
      };
    }

    const repoRoot = inspection.repoRoot;
    const gitHooksDir = path.join(repoRoot, '.githooks');
    const runnerDir = path.join(repoRoot, '.omp', 'review-kit');
    await this.#assertNoSymlinkComponents(repoRoot, gitHooksDir);
    await this.#assertNoSymlinkComponents(repoRoot, runnerDir);
    await mkdir(gitHooksDir, { recursive: true });
    await mkdir(runnerDir, { recursive: true });

    let installed = false;
    let updated = false;

    // 1. Deploy / ensure pre-commit hook
    const canonicalHookPath = path.join(this.#pluginRoot, 'templates', 'githooks', 'pre-commit');
    const canonicalHookTemplate = await readFile(canonicalHookPath, 'utf8');
    const hookPath = path.join(gitHooksDir, 'pre-commit');
    const hookWritten = await this.#writeIfChanged(repoRoot, hookPath, canonicalHookTemplate, 0o755);
    if (hookWritten) {
      if (!inspection.hookFilePresent) {
        installed = true;
      } else {
        updated = true;
      }
    }

    // 2. Deploy / ensure runner script
    const canonicalRunnerPath = path.join(this.#pluginRoot, 'scripts', 'run-review.mjs');
    const canonicalRunnerContent = await readFile(canonicalRunnerPath, 'utf8');
    const targetRunnerPath = path.join(runnerDir, 'run-review.mjs');
    const runnerWritten = await this.#writeIfChanged(repoRoot, targetRunnerPath, canonicalRunnerContent);
    if (runnerWritten) {
      if (!inspection.runnerPresent) {
        installed = true;
      } else {
        updated = true;
      }
    }

    // 3. Configure repository-local core.hooksPath
    if (!inspection.hooksPathConfigured) {
      const configRes = this.runGit(['config', 'core.hooksPath', '.githooks'], repoRoot);
      if (configRes.status !== 0) {
        throw new Error(`Failed to configure core.hooksPath: ${configRes.stderr.trim()}`);
      }
      installed = true;
    }

    const finalState = installed ? 'installed' : (updated ? 'updated' : 'active');
    const message = finalState === 'installed'
      ? `Configured pre-commit hook in ${repoRoot} (core.hooksPath .githooks)`
      : (finalState === 'updated'
        ? `Updated pre-commit hook runner in ${repoRoot}`
        : `Pre-commit hook active in ${repoRoot}`);

    return {
      success: true,
      state: finalState,
      repoRoot,
      message,
    };
  }

  /**
   * Inspects the current review hook status in a repository.
   *
   * @param {string} targetDir
   * @returns {Promise<{
   *   isGitRepo: boolean,
   *   repoRoot: string|null,
   *   state: 'not-git'|'inactive'|'stale'|'active'|'conflict',
   *   configuredHooksPath: string|null,
   *   hooksPathConfigured: boolean,
   *   hookFilePresent: boolean,
   *   hookOwned: boolean,
   *   runnerPresent: boolean,
   *   runnerCurrent: boolean,
   *   isFullyActive: boolean,
   *   conflictReason: string|null,
   *   latestReview?: { date: string, verdict: string, file: string }
   * }>}
   */
  async status(targetDir) {
    const inspection = await this.#inspectInstallation(targetDir);
    if (!inspection.isGitRepo) {
      return inspection;
    }

    // Scan for latest review report
    let latestReview;
    const reportsDir = path.join(inspection.repoRoot, 'audit-reports', 'commit-reviews');
    try {
      const files = await readdir(reportsDir);
      const mdFiles = files.filter((f) => f.endsWith('.md')).sort().reverse();
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
      // No reports directory yet
    }

    return {
      ...inspection,
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
      if (hookStatus.state === 'active') {
        checks.push({ name: 'Pre-commit hook', status: 'OK', message: 'Configured and active in .githooks/' });
      } else if (hookStatus.state === 'conflict') {
        checks.push({
          name: 'Pre-commit hook conflict',
          status: 'WARN',
          message: hookStatus.conflictReason ?? 'Pre-commit hook conflict detected',
        });
      } else if (hookStatus.state === 'stale') {
        checks.push({
          name: 'Pre-commit hook',
          status: 'WARN',
          message: hookStatus.hookExecutable === false
            ? 'Pre-commit hook is not executable and will be repaired on next session.'
            : 'Review runner script is stale and will be updated on next session.',
        });
      } else {
        checks.push({
          name: 'Pre-commit hook',
          status: 'WARN',
          message: 'Hook not configured in repository.',
        });
      }
    }

    const hasFailure = checks.some((c) => c.status === 'FAIL');
    return {
      ok: !hasFailure,
      checks,
    };
  }
}
