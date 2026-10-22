import { constants, lstatSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isRunnerNewer } from '../domain/runner-version.mjs';
import { isSkippedTarget } from '../domain/target-policy.mjs';
import { hookBodyDigest, isHookNewer, isOwnedHook } from '../domain/hook-template.mjs';
import { HOOK_SHIM, isOwnedShim, isShimNewer } from '../domain/hook-shim.mjs';
import { FileTargetRegistry } from '../infra/target-registry.mjs';
import { repoReportsDir } from '../infra/filesystem-report-store-adapter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const GIT_HOOK_NAMES = new Set([
  'applypatch-msg',
  'commit-msg',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'p4-prepare-changelist',
  'post-applypatch',
  'post-checkout',
  'post-commit',
  'post-index-change',
  'post-merge',
  'post-receive',
  'post-rewrite',
  'post-update',
  'pre-applypatch',
  'pre-auto-gc',
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'pre-rebase',
  'pre-receive',
  'prepare-commit-msg',
  'proc-receive',
  'push-to-checkout',
  'reference-transaction',
  'sendemail-validate',
  'update',
]);
// Digests (src/domain/hook-template.mjs) of the hook templates that releases shipped before
// markers existed. Frozen: every release from 0.20.0 on carries a marker, so nothing is added here.
export const LEGACY_HOOK_DIGESTS = Object.freeze([
  '1f60aad321d840308d67438071f003e62d79277a78b0320ae1fc2c0a2af9eda8', // f50bc80, 0.4.0 era
  '5b2bf3606edba4342c0fc8d39b2f4b572c940e6c16629fef90b464edb9eb70c6', // cd6f1af, 0.4.0 release
  '979502496b2721d79966a5a48f3ce28c96aa78cd2ca7079bb8f294b4264d101a', // 566c59e, 0.13.0 to 0.19.1
]);
const CHAINED_HOOK_DIR = 'pre-commit.d';
const CHAINED_HOOK_PREFIX = '00-';
const CHAINED_HOOK_SUFFIX = '.chain';
const CHAINED_HOOK_MARKER = 'omp-reviewer-kit chained hook';
const CHAINED_HOOK_TEMPLATE = '#!/bin/sh\n# ' + CHAINED_HOOK_MARKER + '\nset -eu\nhook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nroot=$(CDPATH= cd -- "$hook_dir/../.." && pwd)\nexec node "$root/.omp/review-kit/run-review.mjs"\n';
const CHAINED_HOOK_NAME = CHAINED_HOOK_PREFIX + 'omp-reviewer-kit' + CHAINED_HOOK_SUFFIX;
const CHAINED_HOOK_PATH = CHAINED_HOOK_DIR + '/' + CHAINED_HOOK_NAME;
const CHAINED_HOOK_NAME_RE = CHAINED_HOOK_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHAINED_HOOK_DIR_RE = CHAINED_HOOK_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHAINED_HOOK_SUFFIX_RE = CHAINED_HOOK_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Adoption gate: the foreign hook must actually invoke our owned entry —
// either a literal call of pre-commit.d/00-omp-reviewer-kit.chain, or a
// directory-enumerating loop over pre-commit.d/*.chain (which picks up our
// entry once deployed). Anything else stays a fail-closed conflict.
const CHAINED_HOOK_RE = new RegExp(
  '(?:^|\\n)[ \\t]*(?:exec[ \\t]+)?(?:"?\\$\\{?hook_dir\\}?"?|"\\$0-dir"|\\$\\(dirname[^)]*\\))/' +
  CHAINED_HOOK_DIR_RE + '/' + CHAINED_HOOK_NAME_RE + '"?[ \\t]*(?:\\n|$)' +
  '|' +
  'for[ \\t]+\\w+[ \\t]+in[ \\t]+"?(?:\\$\\{?hook_dir\\}?|\\$0-dir|\\$\\(dirname[^)]*\\))(?:/' +
  CHAINED_HOOK_DIR_RE + ')?"?/\\*' + '(?:' + CHAINED_HOOK_SUFFIX_RE + ')?"?'
);

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
 * Splits `git config --show-origin --get <key>` output (`file:<path><TAB><value>`).
 *
 * @param {string} stdout
 * @returns {{ file: string|null, value: string }|null}
 */
export function parseConfigOrigin(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const tab = line.indexOf('\t');
  if (tab < 0) return { file: null, value: line.trim() };
  const origin = line.slice(0, tab).replace(/^file:/, '').replace(/^"(.*)"$/, '$1');
  return { file: origin || null, value: line.slice(tab + 1).trim() };
}

/**
 * Domain & Application service managing the installation and diagnostics of the Git review hook.
 */
export class PluginInstallerService {
  #pluginRoot;
  #targets;

  constructor({ pluginRoot = PLUGIN_ROOT, targetRegistry = new FileTargetRegistry() } = {}) {
    this.#pluginRoot = pluginRoot;
    this.#targets = targetRegistry;
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
   * Git's default hooks directory of the repository that owns this checkout. Worktrees share it.
   *
   * @param {string} repoRoot
   * @returns {string|null}
   */
  #commonHooksDir(repoRoot) {
    const res = this.runGit(['rev-parse', '--git-common-dir'], repoRoot);
    if (res.status !== 0 || !res.stdout.trim()) return null;
    return path.join(path.resolve(repoRoot, res.stdout.trim()), 'hooks');
  }

  /**
   * Names in a hooks directory that would run when git used it: everything except samples and the
   * kit's own shim. A missing directory holds none.
   *
   * @param {string} dir
   * @returns {Promise<string[]>}
   * @throws when the directory exists but cannot be read
   */
  async #foreignHooksIn(dir) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const foreign = [];
    for (const name of entries) {
      if (name.endsWith('.sample')) continue;
      if (name === 'pre-commit') {
        const text = await readFile(path.join(dir, name), 'utf8').catch(() => null);
        if (text !== null && isOwnedShim(text)) continue;
      }
      foreign.push(name);
    }
    return foreign;
  }

  /**
   * Stores the hook shim in the repository's default hooks directory, so that a stray core.hooksPath
   * pointing there still starts .githooks/pre-commit. Never replaces a hook it does not own, never
   * writes through a symlinked directory, and never throws.
   *
   * @param {string|null} hooksDir
   * @returns {Promise<'written'|'current'|'foreign'|'skipped'>}
   */
  async #ensureShim(hooksDir) {
    if (!hooksDir) return 'skipped';
    try {
      // A hooks directory shared between repositories (a symlink) would run this shim in repositories without .githooks.
      const real = await realpath(hooksDir).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
      if (real !== null && normalizePath(real) !== normalizePath(hooksDir)) return 'skipped';
      const target = path.join(hooksDir, 'pre-commit');
      let existing = null;
      try {
        const info = await lstat(target);
        if (!info.isFile()) return 'foreign';
        existing = await readFile(target, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') return 'skipped';
      }
      if (existing !== null) {
        if (!isOwnedShim(existing)) return 'foreign';
        if (existing === HOOK_SHIM || isShimNewer(existing)) return 'current';
      }
      await mkdir(hooksDir, { recursive: true });
      const tmpPath = path.join(hooksDir, '.tmp-pre-commit-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      try {
        await writeFile(tmpPath, HOOK_SHIM, { encoding: 'utf8', flag: 'wx', mode: 0o755 });
        if (process.platform !== 'win32') await verifyRegularFile(tmpPath, 0o755);
        await rename(tmpPath, target);
      } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
      }
      return 'written';
    } catch {
      return 'skipped';
    }
  }

  /**
   * Which pre-commit hook git runs for the next commit in this checkout, and whether it starts the review.
   * Independent of the installation state: it only reads what git would execute.
   *
   * @param {string} repoRoot
   * @returns {Promise<{
   *   hooksDir: string,
   *   hookPath: string,
   *   kind: 'kit'|'shim'|'chained'|'foreign'|'missing'|'not-executable',
   *   effective: boolean,
   *   hooksPath: string|null
   * }>}
   */
  async #effectiveHook(repoRoot) {
    const configured = this.runGit(['config', '--get', 'core.hooksPath'], repoRoot);
    const hooksPath = configured.status === 0 && configured.stdout.trim() ? configured.stdout.trim() : null;
    const res = this.runGit(['rev-parse', '--git-path', 'hooks'], repoRoot);
    const hooksDir = path.resolve(repoRoot, res.status === 0 && res.stdout.trim() ? res.stdout.trim() : path.join('.git', 'hooks'));
    const hookPath = path.join(hooksDir, 'pre-commit');
    const result = (kind) => ({ hooksDir, hookPath, kind, effective: kind === 'kit' || kind === 'shim' || kind === 'chained', hooksPath });
    let info;
    try {
      info = await stat(hookPath);
    } catch {
      return result('missing');
    }
    if (!info.isFile()) return result('missing');
    if (process.platform !== 'win32' && (info.mode & 0o111) === 0) return result('not-executable');
    const text = await readFile(hookPath, 'utf8').catch(() => null);
    if (text === null) return result('missing');
    if (isOwnedHook(text) || LEGACY_HOOK_DIGESTS.includes(hookBodyDigest(text))) return result('kit');
    if (isOwnedShim(text)) return result('shim');
    if (CHAINED_HOOK_RE.test(normalizeLineEndings(text))
        && await stat(path.join(hooksDir, CHAINED_HOOK_PATH)).then((s) => s.isFile(), () => false)) return result('chained');
    return result('foreign');
  }

  /**
   * True when the kit's review is expected to run in this checkout: it carries the kit's own hook (or a
   * foreign hook that chains into it). Repositories that never adopted the kit are not guarded.
   *
   * @param {string} repoRoot
   * @returns {Promise<boolean>}
   */
  async #kitExpected(repoRoot) {
    if (isSkippedTarget(repoRoot)) return false;
    const text = await readFile(path.join(repoRoot, '.githooks', 'pre-commit'), 'utf8').catch(() => null);
    if (text === null) return false;
    return isOwnedHook(text) || LEGACY_HOOK_DIGESTS.includes(hookBodyDigest(text))
      || CHAINED_HOOK_RE.test(normalizeLineEndings(text));
  }

  /**
   * Reports whether the next commit in a checkout would run the review hook. Read-only.
   *
   * @param {string} targetDir
   * @returns {Promise<null | {
   *   repoRoot: string,
   *   kitExpected: boolean,
   *   hooksDir: string,
   *   hookPath: string,
   *   kind: 'kit'|'shim'|'chained'|'foreign'|'missing'|'not-executable',
   *   effective: boolean,
   *   hooksPath: string|null
   * }>} null outside a Git repository
   */
  async assessHook(targetDir) {
    const repoRoot = this.getRepoRoot(targetDir);
    if (!repoRoot) return null;
    return { repoRoot, kitExpected: await this.#kitExpected(repoRoot), ...(await this.#effectiveHook(repoRoot)) };
  }

  /**
   * Commit-time guard: a commit in a checkout where the kit is installed must run the review hook.
   * When git would run something else (a stray core.hooksPath), the guard repairs the checkout through
   * setup() and lets the commit go on; when it cannot, it refuses the commit with the reason instead of
   * letting it through unreviewed. Never throws; an internal failure allows the commit, as before the guard.
   * OMP_REVIEW_KIT_GUARD=0 turns it off.
   *
   * @param {string} cwd
   * @returns {Promise<{ action: 'allow'|'block', repaired?: boolean, message?: string }>}
   */
  async guardCommit(cwd) {
    if (process.env.OMP_REVIEW_KIT_GUARD === '0') return { action: 'allow' };
    try {
      const repoRoot = this.getRepoRoot(cwd);
      if (!repoRoot || !(await this.#kitExpected(repoRoot))) return { action: 'allow' };
      let effective = await this.#effectiveHook(repoRoot);
      if (effective.effective) return { action: 'allow' };
      if (process.env.OMP_REVIEW_KIT_AUTO_SYNC !== '0') {
        await this.setup(repoRoot).catch(() => undefined);
        const again = await this.#effectiveHook(repoRoot);
        if (again.effective) {
          return { action: 'allow', repaired: true, message: `reviewer-kit repaired this checkout: git was set to run "${effective.hookPath}" (core.hooksPath ${effective.hooksPath ?? 'unset'}), which does not start the review; the commit is reviewed again.` };
        }
        effective = again;
      }
      const why = { missing: 'it does not exist', 'not-executable': 'it is not executable', foreign: 'it is another tool\'s hook that does not call the review' }[effective.kind];
      return {
        action: 'block',
        message: `reviewer-kit stopped this commit: git would run "${effective.hookPath}" (core.hooksPath ${effective.hooksPath ?? 'unset'}) and ${why}, so the staged change would not be reviewed. Fix it with: git -C "${repoRoot}" config core.hooksPath .githooks (or run /reviewer-kit:setup), then commit again. OMP_REVIEW_KIT_GUARD=0 turns this check off.`,
      };
    } catch {
      return { action: 'allow' };
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
   *   hookCurrent: boolean,
   *   runnerPresent: boolean,
   *   runnerCurrent: boolean,
   *   runnerNewer: boolean,
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
        hooksPathRepairable: false,
        hooksPathOrigin: null,
        commonHooksDir: null,
        hookFilePresent: false,
        hookOwned: false,
        hookCurrent: false,
        hookChained: false,
        chainedHookPresent: false,
        chainedHookCurrent: false,
        chainedHookExecutable: false,
        runnerPresent: false,
        runnerCurrent: false,
        runnerNewer: false,
        hookExecutable: false,
        conflictReason: null,
      };
    }

    const canonicalHookPath = path.join(this.#pluginRoot, 'templates', 'githooks', 'pre-commit');
    const canonicalRunnerPath = path.join(this.#pluginRoot, 'templates', 'review-kit', 'run-review.mjs');
    const pluginRunnerPath = path.join(this.#pluginRoot, 'scripts', 'run-review.mjs');
    const canonicalHookTemplate = await readFile(canonicalHookPath, 'utf8');
    const canonicalRunnerContent = await readFile(canonicalRunnerPath, 'utf8');
    // The release marker lives in the plugin's algorithm, not in the stub: it decides whether a vendored runner is newer.
    const pluginRunnerContent = await readFile(pluginRunnerPath, 'utf8');

    const expectedGithooksDir = path.join(repoRoot, '.githooks');
    let hooksPathConfigured = false;
    let conflictReason = null;
    // Hooks of other tools next to ours only matter while activating .githooks would start running them.
    let foreignHooksReason = null;

        try {
          const entries = await readdir(expectedGithooksDir);
          const foreignHooks = entries.filter((name) => name !== 'pre-commit' && GIT_HOOK_NAMES.has(name));
          if (foreignHooks.length > 0) {
            foreignHooksReason = 'Existing unrelated hooks found in .githooks (' + foreignHooks.join(', ') + '); refusing to activate them';
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            conflictReason = 'Unable to inspect .githooks directory; ' + (error?.message ?? error);
          }
        }

    const hookRes = this.runGit(['config', '--show-origin', '--get', 'core.hooksPath'], repoRoot);
    const configuredOrigin = hookRes.status === 0 ? parseConfigOrigin(hookRes.stdout) : null;
    const configuredHooksPath = configuredOrigin?.value ? configuredOrigin.value : null;
    const hooksPathOrigin = configuredHooksPath !== null ? configuredOrigin.file : null;
    const commonHooksDir = this.#commonHooksDir(repoRoot);
    // The standard hooks directory of this checkout: where git looks when core.hooksPath is unset.
    const gitPathRes = this.runGit(['rev-parse', '--git-path', 'hooks'], repoRoot);
    const standardHooksDir = path.resolve(repoRoot, gitPathRes.status === 0 && gitPathRes.stdout.trim()
      ? gitPathRes.stdout.trim()
      : path.join('.git', 'hooks'));
    // A core.hooksPath that names git's own default hooks directory is a stray value (Claude Code Agent Teams
    // writes it when it creates a worktree), not a deliberate choice of another hook system: the kit repairs it.
    let hooksPathRepairable = false;

    if (configuredHooksPath !== null) {
      const resolvedConfigured = path.resolve(repoRoot, configuredHooksPath);
      if (normalizePath(resolvedConfigured) === normalizePath(expectedGithooksDir)) {
        hooksPathConfigured = true;
      } else {
        const defaults = [commonHooksDir, path.join(repoRoot, '.git', 'hooks')].filter(Boolean);
        const isDefault = defaults.some((dir) => normalizePath(dir) === normalizePath(resolvedConfigured));
        const foreign = isDefault ? await this.#foreignHooksIn(resolvedConfigured).catch(() => null) : null;
        if (isDefault && Array.isArray(foreign) && foreign.length === 0) {
          hooksPathRepairable = true;
        } else {
          conflictReason = `core.hooksPath is configured to "${configuredHooksPath}" (expected ".githooks")`;
        }
      }
    } else {
      try {
        const foreign = await this.#foreignHooksIn(standardHooksDir);
        if (foreign.length > 0) {
          conflictReason = `Existing hooks found in standard hooks directory (${foreign.join(', ')}); switching core.hooksPath would bypass them`;
        }
      } catch (error) {
        if (!conflictReason) {
          conflictReason = 'Unable to inspect standard hooks directory: ' + (error?.message ?? error);
        }
      }
    }

    // A stray core.hooksPath (repairable) is judged after the kit's own hook is known: when the repository already
    // carries it, .githooks is the repository's chosen hooks directory and its other hooks were active before the stray value.
    if (foreignHooksReason && !hooksPathConfigured && !conflictReason && !hooksPathRepairable) conflictReason = foreignHooksReason;

    const hookPath = path.join(expectedGithooksDir, 'pre-commit');
    let hookFilePresent = false;
    let hookOwned = false;
    let hookCurrent = false;
    let hookNewer = false;
    let hookChained = false;
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
          const normalizedHook = normalizeLineEndings(hookContent);
          // An unedited hook of a newer release is ours and is left in place, as a newer runner is.
          hookNewer = isHookNewer(hookContent, canonicalHookTemplate);
          hookCurrent = hookNewer || normalizedHook === normalizeLineEndings(canonicalHookTemplate);
          hookOwned = hookCurrent || isOwnedHook(hookContent)
            || LEGACY_HOOK_DIGESTS.includes(hookBodyDigest(hookContent));
          if (!hookOwned) {
            hookChained = CHAINED_HOOK_RE.test(normalizedHook);
            if (!hookChained && !conflictReason) {
              conflictReason = 'Existing .githooks/pre-commit does not match omp-reviewer-kit template';
            }
          }
        }
      } catch (error) {
        hookOwned = false;
        if (error?.code !== 'ENOENT' && !conflictReason) {
          conflictReason = 'Unable to inspect existing .githooks/pre-commit: ' + (error?.message ?? error);
        }
      }
    }

    const chainedHookPath = path.join(expectedGithooksDir, CHAINED_HOOK_PATH);
    let chainedHookPresent = false;
    let chainedHookCurrent = false;
    let chainedHookExecutable = process.platform === 'win32';
    const chainedSymlinkPath = await this.#findSymlinkComponent(repoRoot, chainedHookPath);

    if (chainedSymlinkPath) {
      chainedHookPresent = true;
      if (!conflictReason) {
        conflictReason = 'Existing .githooks/' + CHAINED_HOOK_PATH + ' path contains symlink component: ' + chainedSymlinkPath;
      }
    } else {
      try {
        const chainedStat = await lstat(chainedHookPath);
        chainedHookPresent = true;
        chainedHookExecutable = process.platform === 'win32' || (chainedStat.mode & 0o111) !== 0;
        if (!chainedStat.isFile()) {
          if (!conflictReason) {
            conflictReason = 'Unable to inspect existing .githooks/' + CHAINED_HOOK_PATH + ': path is not a regular file';
          }
        } else {
          const chainedContent = await readFile(chainedHookPath, 'utf8');
          chainedHookCurrent = normalizeLineEndings(chainedContent) === normalizeLineEndings(CHAINED_HOOK_TEMPLATE);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && !conflictReason) {
          conflictReason = 'Unable to inspect existing .githooks/' + CHAINED_HOOK_PATH + ': ' + (error?.message ?? error);
        }
      }
    }

    const runnerPath = path.join(repoRoot, '.omp', 'review-kit', 'run-review.mjs');
    let runnerPresent = false;
    let runnerCurrent = false;
    // A vendored runner newer than this plugin's own is never downgraded: two
    // install channels (OMP user/project scope, Claude shell) must not
    // overwrite each other's runner in a shared repository.
    let runnerNewer = false;
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
          runnerNewer = runnerContent !== canonicalRunnerContent
            && isRunnerNewer(runnerContent, pluginRunnerContent);
          runnerCurrent = runnerNewer || runnerContent === canonicalRunnerContent;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && !conflictReason) {
          conflictReason = 'Unable to inspect existing .omp/review-kit/run-review.mjs: ' + (error?.message ?? error);
        }
      }
    }
    if (foreignHooksReason && hooksPathRepairable && !conflictReason && !hookOwned && !hookChained) conflictReason = foreignHooksReason;
    let state;
    const hookUsable = hookFilePresent && hookOwned && hookCurrent && hookExecutable;
    const chainUsable = hookChained && chainedHookPresent && chainedHookCurrent
        && chainedHookExecutable && hookExecutable;
    if (conflictReason) {
      state = 'conflict';
    } else if (hookChained && !hookExecutable) {
      // Foreign hook is not executable: git cannot run it, and we cannot chmod
      // a file we do not own. Report conflict instead of a false 'active'.
      state = 'conflict';
      conflictReason = 'Existing .githooks/pre-commit chains into ' + CHAINED_HOOK_PATH
        + ' but is not executable; fix its mode manually (chmod +x)';
    } else if (hooksPathConfigured && (hookUsable || chainUsable) && runnerPresent && runnerCurrent) {
      state = 'active';
    } else if (hooksPathConfigured && (hookOwned || hookChained) && runnerPresent
        && ((!hookUsable && !chainUsable) || !runnerCurrent)) {
      state = 'stale';
    } else if (hooksPathRepairable && (hookOwned || hookChained) && runnerPresent) {
      // Installed, but core.hooksPath was moved to git's default hooks directory: setup() puts it back.
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
      hooksPathRepairable,
      hooksPathOrigin,
      commonHooksDir,
      hookFilePresent,
      hookOwned,
      hookCurrent,
      hookNewer,
      hookChained,
      chainedHookPresent,
      chainedHookCurrent,
      chainedHookExecutable,
      runnerPresent,
      runnerCurrent,
      runnerNewer,
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
   *   state: 'installed'|'updated'|'active'|'conflict'|'skipped',
   *   repoRoot: string,
   *   message: string
   * }>}
   */
  async setup(targetDir) {
    const inspection = await this.#inspectInstallation(targetDir);
    if (!inspection.isGitRepo) {
      throw new Error('Directory is not inside a Git repository: ' + targetDir);
    }

    if (isSkippedTarget(inspection.repoRoot)) {
      return {
        success: false,
        state: 'skipped',
        repoRoot: inspection.repoRoot,
        message: 'Not set up: ' + inspection.repoRoot + ' is a disposable omp-tasks worker checkout, which reviewer-kit never writes to',
      };
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
      await this.#ensureShim(inspection.commonHooksDir);
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
    let hookWritten = false;
    if (inspection.hookChained) {
      // Existing foreign hook already chains into .githooks/pre-commit.d/:
      // repair the owned chain entry only, never touch the foreign hook file.
      const chainedPath = path.join(gitHooksDir, CHAINED_HOOK_PATH);
      const chainedWritten = await this.#writeIfChanged(repoRoot, chainedPath, CHAINED_HOOK_TEMPLATE, 0o755);
      if (chainedWritten) {
        if (!inspection.chainedHookPresent) {
          installed = true;
        } else {
          updated = true;
        }
      }
    } else {
      hookWritten = inspection.hookNewer ? false : await this.#writeIfChanged(repoRoot, hookPath, canonicalHookTemplate, 0o755);
      if (hookWritten) {
        if (!inspection.hookFilePresent) {
          installed = true;
        } else {
          updated = true;
        }
      }
    }

    // 2. Deploy / ensure runner script
    const canonicalRunnerPath = path.join(this.#pluginRoot, 'templates', 'review-kit', 'run-review.mjs');
    const canonicalRunnerContent = await readFile(canonicalRunnerPath, 'utf8');
    const targetRunnerPath = path.join(runnerDir, 'run-review.mjs');
    const runnerWritten = inspection.runnerNewer
      ? false
      : await this.#writeIfChanged(repoRoot, targetRunnerPath, canonicalRunnerContent);
    if (runnerWritten) {
      if (!inspection.runnerPresent) {
        installed = true;
      } else {
        updated = true;
      }
    }

    // 3. Configure repository-local core.hooksPath. A stray value in this worktree's own config (config.worktree)
    // would keep winning over the shared one, so it is replaced where it lives.
    let repairedFrom = null;
    if (!inspection.hooksPathConfigured) {
      const perWorktree = /(^|[\\/])config\.worktree$/.test(inspection.hooksPathOrigin ?? '');
      const configRes = this.runGit(['config', ...(perWorktree ? ['--worktree'] : []), 'core.hooksPath', '.githooks'], repoRoot);
      if (configRes.status !== 0) {
        throw new Error(`Failed to configure core.hooksPath: ${configRes.stderr.trim()}`);
      }
      if (inspection.hooksPathRepairable) repairedFrom = inspection.configuredHooksPath;
      installed = true;
    }

    // 4. Safety net for a later stray core.hooksPath (see src/domain/hook-shim.mjs)
    await this.#ensureShim(inspection.commonHooksDir);

    const finalState = repairedFrom !== null ? 'updated' : installed ? 'installed' : (updated ? 'updated' : 'active');
    const message = repairedFrom !== null
      ? `Repaired core.hooksPath in ${repoRoot}: it pointed at "${repairedFrom}", which does not start the review; it is .githooks again`
      : finalState === 'installed'
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
   * Remembers a repository whose review hook is installed so that later runner
   * releases reach it without a manual sync. Never throws.
   *
   * @param {string|null|undefined} repoRoot
   * @returns {Promise<boolean>} true when the repository was newly registered
   */
  async registerTarget(repoRoot) {
    if (!repoRoot) return false;
    try {
      return await this.#targets.add(repoRoot);
    } catch {
      return false;
    }
  }

  /**
   * Repairs every registered repository whose installed hook or runner went stale
   * (typically after this plugin was updated). Repositories that are not stale,
   * not installed, in conflict, or carry a newer runner are left alone; entries
   * that stopped being Git repositories are dropped. Never throws.
   *
   * @param {{ exceptRoot?: string|null, budgetMs?: number }} [options]
   * @returns {Promise<{ checked: number, healed: string[], failed: string[], pruned: string[] }>}
   */
  async healTargets({ exceptRoot = null, budgetMs = 8000 } = {}) {
    const summary = { checked: 0, healed: [], failed: [], pruned: [] };
    if (process.env.OMP_REVIEW_KIT_AUTO_SYNC === '0') return summary;
    let targets;
    try {
      targets = await this.#targets.list();
    } catch {
      return summary;
    }
    const except = exceptRoot ? path.resolve(exceptRoot) : null;
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const deadline = Date.now() + budgetMs;
    for (const repo of targets) {
      if (Date.now() > deadline) break;
      if (except && same(repo, except)) continue;
      if (isSkippedTarget(repo)) continue;
      try {
        const info = await this.#inspectInstallation(repo);
        if (!info.isGitRepo) {
          if (await this.#targets.remove(repo)) summary.pruned.push(repo);
          continue;
        }
        summary.checked += 1;
        if (info.state !== 'stale') continue;
        const result = await this.setup(repo);
        (result.success ? summary.healed : summary.failed).push(repo);
      } catch {
        summary.failed.push(repo);
      }
    }
    return summary;
  }

  /**
   * Session-start routine for hosts that do not run `setup()` themselves: repairs
   * the current repository when its installed hook is stale, registers it, and
   * heals every other registered repository.
   *
   * @param {string} cwd
   * @param {{ budgetMs?: number }} [options] time allowed for healing the other repositories
   * @returns {Promise<{ current: object|null, targets: { checked: number, healed: string[], failed: string[], pruned: string[] } }>}
   */
  async refreshAtSessionStart(cwd, { budgetMs = 8000 } = {}) {
    let current = null;
    let repoRoot = null;
    try {
      const info = await this.#inspectInstallation(cwd);
      if (info.isGitRepo && (info.state === 'stale' || info.state === 'active')) {
        repoRoot = info.repoRoot;
        if (info.state === 'stale' && process.env.OMP_REVIEW_KIT_AUTO_SYNC !== '0' && !isSkippedTarget(repoRoot)) current = await this.setup(cwd);
        await this.registerTarget(repoRoot);
      }
    } catch {
      // the other repositories are still worth healing
    }
    return { current, targets: await this.healTargets({ exceptRoot: repoRoot, budgetMs }) };
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
   *   hookCurrent: boolean,
   *   hookChained: boolean,
   *   chainedHookPresent: boolean,
   *   chainedHookCurrent: boolean,
   *   chainedHookExecutable: boolean,
   *   runnerPresent: boolean,
   *   runnerCurrent: boolean,
   *   runnerNewer: boolean,
   *   isFullyActive: boolean,
   *   conflictReason: string|null,
   *   latestReview?: { date: string, verdict: string, file: string },
   * }>}
   */
  async status(targetDir) {
    const inspection = await this.#inspectInstallation(targetDir);
    if (!inspection.isGitRepo) {
      return inspection;
    }

    // Scan for the latest review report (reports live outside the repository).
    let latestReview;
    const reportsDir = repoReportsDir(inspection.repoRoot);
    try {
      const files = await readdir(reportsDir);
      const mdFiles = files.filter((f) => f.endsWith('.md')).sort().reverse();
      if (mdFiles.length > 0) {
        const latestFile = mdFiles[0];
        const content = await readFile(path.join(reportsDir, latestFile), 'utf8');
        const verdictMatch = content.match(/^# reviewer-kit review: (PASS|BLOCK)/m);
        latestReview = {
          file: latestFile,
          path: path.join(reportsDir, latestFile),
          verdict: verdictMatch ? verdictMatch[1] : 'UNKNOWN',
          date: latestFile.slice(0, 24).replace(/-/g, (m, offset) => (offset > 18 ? '.' : offset > 10 ? ':' : '-')),
        };
      }
    } catch {
      // No reports directory yet
    }

    const effectiveHook = await this.assessHook(inspection.repoRoot).catch(() => null);

    return {
      ...inspection,
      latestReview,
      effectiveHook,
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
        // A skipped worker checkout is never written by the kit: say so instead of promising a repair.
        const notExecutable = hookStatus.hookExecutable === false;
        const message = isSkippedTarget(repoRoot)
          ? `This worker checkout is outside the kit's reach: ${notExecutable ? 'the pre-commit hook is not executable' : 'the review runner script is stale'}, and no session repairs it. Refresh it by hand.`
          : hookStatus.hooksPathRepairable
            ? `core.hooksPath points at git's default hooks directory ("${hookStatus.configuredHooksPath}"), so commits skip the review; it is repaired on the next session or commit.`
            : notExecutable
              ? 'Pre-commit hook is not executable and will be repaired on next session.'
              : 'Review runner script is stale and will be updated on next session.';
        checks.push({ name: 'Pre-commit hook', status: 'WARN', message });
      } else {
        checks.push({
          name: 'Pre-commit hook',
          status: 'WARN',
          message: 'Hook not configured in repository.',
        });
      }
    }

    if (repoRoot) {
      const hook = await this.assessHook(repoRoot).catch(() => null);
      if (hook?.kitExpected) {
        checks.push(hook.effective
          ? { name: 'Effective pre-commit hook', status: 'OK', message: `git runs ${hook.hookPath} (${hook.kind})` }
          : { name: 'Effective pre-commit hook', status: 'FAIL', message: `commits here are NOT reviewed: git runs "${hook.hookPath}" (core.hooksPath ${hook.hooksPath ?? 'unset'}), ${hook.kind === 'foreign' ? "another tool's hook that does not call the review" : hook.kind === 'not-executable' ? 'which is not executable' : 'which does not exist'}. Run /reviewer-kit:setup, or: git config core.hooksPath .githooks` });
      }
    }

    try {
      // Skipped worker checkouts are outside the kit's reach: nothing repairs a stale runner there, so none is reported.
      const targets = (await this.#targets.list()).filter((repo) => !isSkippedTarget(repo));
      if (targets.length > 0) {
        let stale = 0;
        const unreviewed = [];
        for (const repo of targets) {
          const info = await this.#inspectInstallation(repo).catch(() => null);
          if (info?.isGitRepo && info.state === 'stale') stale += 1;
          if (info?.isGitRepo) {
            const hook = await this.assessHook(repo).catch(() => null);
            if (hook?.kitExpected && !hook.effective) unreviewed.push(repo);
          }
        }
        checks.push({
          name: 'Registered repositories',
          status: stale > 0 || unreviewed.length > 0 ? 'WARN' : 'OK',
          message: stale > 0 || unreviewed.length > 0
            ? [
              stale > 0 ? `${stale} of ${targets.length} registered repositories carry a stale hook or runner; they are repaired when a session starts in any repository` : '',
              unreviewed.length > 0 ? `${unreviewed.length} would commit without the review (git does not run the kit hook): ${unreviewed.slice(0, 5).join(', ')}${unreviewed.length > 5 ? ', ...' : ''}` : '',
            ].filter(Boolean).join('; ')
            : `${targets.length} registered, all current`,
        });
      }
    } catch {
      // the registry is a convenience; an unreadable one is not a diagnosis
    }

    const hasFailure = checks.some((c) => c.status === 'FAIL');
    return {
      ok: !hasFailure,
      checks,
    };
  }
}
