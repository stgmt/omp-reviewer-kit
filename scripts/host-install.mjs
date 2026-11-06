// The installer for the host that has no marketplace: OpenCode. It writes the plugin entry into the
// config array (JSONC preserved), installs native agents/commands plus the shared skills, and records
// per-file hashes so upgrades/removals only replace or delete unchanged kit-owned bytes.
//
//   node scripts/host-install.mjs --host opencode [--apply] [--force]
//   node scripts/host-install.mjs --host opencode --remove [--apply]
//   node scripts/host-install.mjs --host omp|claude|codex        # prints the host's own commands
//
// Without --apply it is a dry run that prints the plan. Nothing here installs for OMP, Claude Code or
// Codex: those hosts install themselves, and re-implementing their install would create a second,
// divergent copy of their state.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/infra/main-module.mjs';
import {
  INSTALL_MANIFEST,
  installRecord,
  isKitPackageSpec,
  OPENCODE_COMPONENTS,
  opencodeConfigDir,
  opencodePluginEntry,
  planHostInstall,
  readPluginArray,
  writePluginItems,
} from '../src/domain/host-install-plan.mjs';

const KIT_PACKAGE = 'omp-reviewer-kit';
const SUPPORTED_HOSTS = ['opencode', 'omp', 'claude', 'codex'];
const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The config file OpenCode reads in a directory: `opencode.json`, else `opencode.jsonc`, else a new
 * `opencode.json`.
 *
 * @param {string} dir
 * @param {Function} readFileImpl
 * @returns {Promise<{ path: string, text: string, exists: boolean }>}
 */
export async function openCodeConfigFile(dir, readFileImpl = readFile) {
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const candidate = path.join(dir, name);
    try {
      return { path: candidate, text: await readFileImpl(candidate, 'utf8'), exists: true };
    } catch {
      continue;
    }
  }
  return { path: path.join(dir, 'opencode.json'), text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', exists: false };
}

/**
 * Plans the native OpenCode asset copy without writing config or user files.
 *
 * @param {{ configDir: string, kitRoot?: string, previousFiles?: Array<string|{path:string,sha256:string}> }} input
 * @returns {Promise<{ copies: Array<{relative:string,from:string,to:string,sha256:string}>, conflicts: string[], files: Array<string|{path:string,sha256:string}> }>}
 */
async function planComponentCopy({ configDir, kitRoot = KIT_ROOT, previousFiles = [] }) {
  const copies = [];
  const conflicts = [];
  const previousHashes = new Map(previousFiles
    .filter(file => file && typeof file === 'object' && typeof file.path === 'string' && /^[a-f0-9]{64}$/i.test(String(file.sha256 ?? '')))
    .map(file => [file.path, String(file.sha256).toLowerCase()]));
  const legacyHashes = await legacyOwnedHashes({ configDir, kitRoot, previousFiles });
  const next = new Map();
  for (const file of previousFiles) {
    if (typeof file === 'string') next.set(file, file);
    else if (file && typeof file.path === 'string' && /^[a-f0-9]{64}$/i.test(String(file.sha256 ?? ''))) {
      next.set(file.path, { path: file.path, sha256: String(file.sha256).toLowerCase() });
    }
  }

  for (const component of OPENCODE_COMPONENTS) {
    const sourceRoot = path.join(kitRoot, component.from);
    let entries;
    try {
      entries = await readdir(sourceRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(sourceRoot, entry.name);
      let sources = [];
      if (component.pattern === '/SKILL.md' && entry.isDirectory()) {
        const tree = await walkFiles(entryPath);
        if (tree.some(file => file.relative === 'SKILL.md')) sources = tree;
      } else if (entry.isFile() && entry.name.endsWith(component.pattern)) {
        sources = [{ from: entryPath, relative: entry.name }];
      }
      for (const source of sources) {
        const relative = component.pattern === '/SKILL.md'
          ? path.posix.join(component.to, entry.name, source.relative)
          : path.posix.join(component.to, source.relative);
        const destination = path.join(configDir, ...relative.split('/'));
        const sourceHash = await fileHash(source.from);
        if (sourceHash === null) {
          conflicts.push(relative);
          continue;
        }
        const destinationHash = await fileHash(destination);
        const hasDestination = await exists(destination);
        const ownedUnmodified = destinationHash !== null
          && (previousHashes.get(relative) === destinationHash || legacyHashes.get(relative) === destinationHash);

        if (hasDestination && !ownedUnmodified) {
          conflicts.push(relative);
          continue;
        }
        if (!hasDestination || destinationHash !== sourceHash) {
          if (!await safeParent(configDir, destination)) {
            conflicts.push(relative);
            continue;
          }
          copies.push({
            relative,
            from: source.from,
            to: destination,
            sha256: sourceHash,
            // The bytes a failed install must put back: a replacement is only safe if the old copy can
            // be restored, because the previous manifest keeps naming the hash of the old copy.
            previous: hasDestination ? await readFile(destination) : null,
          });
        }
        next.set(relative, { path: relative, sha256: sourceHash });
      }
    }
  }
  return { copies, conflicts, files: [...next.values()] };
}

/**
 * Copies native OpenCode assets after checking every destination for ownership conflicts.
 *
 * @param {{ configDir: string, kitRoot?: string, previousFiles?: Array<string|{path:string,sha256:string}> }} input
 * @returns {Promise<{ copied: string[], conflicts: string[], files: Array<string|{path:string,sha256:string}> }>}
 */
export async function copyComponents(input) {
  const plan = await planComponentCopy(input);
  if (plan.conflicts.length > 0) return { copied: [], undo: [], conflicts: plan.conflicts, files: plan.files };
  const contentWrites = [];
  for (const item of plan.copies) {
    const content = await readFile(item.from);
    if (sha256(content) !== item.sha256 || !await safeParent(input.configDir, item.to)) {
      return { copied: [], undo: [], conflicts: [item.relative], files: plan.files };
    }
    contentWrites.push({ item, content });
  }
  const copied = [];
  const undo = [];
  for (const { item, content } of contentWrites) {
    await mkdir(path.dirname(item.to), { recursive: true });
    await writeFile(item.to, content);
    copied.push(item.relative);
    undo.push({ target: item.to, previous: item.previous });
  }
  return { copied, undo, conflicts: [], files: plan.files };
}

/** Lists regular files below a skill directory without following symlinks. */
async function walkFiles(root, prefix = '') {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath, relative));
    else if (entry.isFile()) files.push({ from: fullPath, relative });
  }
  return files;
}

/** Resolves a legacy manifest path to the source used by the old OpenCode asset copier. */
function legacySourcePath(parts, kitRoot) {
  if (parts[0] === 'agents' && parts.length === 2) return path.join(kitRoot, 'agents', ...parts.slice(1));
  if (parts[0] === 'commands' && parts.length === 2) return path.join(kitRoot, 'claude-plugin', 'commands', ...parts.slice(1));
  if (parts[0] === 'skills' && parts.length >= 2) return path.join(kitRoot, 'skills', ...parts.slice(1));
  return null;
}

/** Compares exact directory inventories, including empty directories; links and special entries are unsafe. */
async function sameTree(source, destination) {
  const sourceEntries = await treeInventory(source);
  const destinationEntries = await treeInventory(destination);
  if (!sourceEntries || !destinationEntries || sourceEntries.length !== destinationEntries.length) return false;
  const destinationByPath = new Map(destinationEntries.map(entry => [entry.relative, entry]));
  for (const entry of sourceEntries) {
    const other = destinationByPath.get(entry.relative);
    if (!other || entry.type !== other.type) return false;
    if (entry.type === 'file') {
      const sourceHash = await fileHash(entry.path);
      const destinationHash = await fileHash(other.path);
      if (sourceHash === null || destinationHash === null || sourceHash !== destinationHash) return false;
    }
  }
  return true;
}

/** Returns null for inaccessible roots, symbolic links, and non-file/non-directory entries. */
async function treeInventory(root, prefix = '') {
  let rootInfo;
  let entries;
  try {
    rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const inventory = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const fullPath = path.join(root, entry.name);
    let info;
    try {
      info = await lstat(fullPath);
    } catch {
      return null;
    }
    if (info.isSymbolicLink()) return null;
    if (info.isDirectory()) {
      inventory.push({ relative, type: 'directory', path: fullPath });
      const nested = await treeInventory(fullPath, relative);
      if (!nested) return null;
      inventory.push(...nested);
    } else if (info.isFile()) {
      inventory.push({ relative, type: 'file', path: fullPath });
    } else {
      return null;
    }
  }
  return inventory;
}
/** Hashes legacy string entries only when the destination still exactly matches its old source. */
async function legacyOwnedHashes({ configDir, kitRoot, previousFiles }) {
  const owned = new Map();
  for (const relative of previousFiles.filter(file => typeof file === 'string')) {
    const parts = relative.replaceAll(String.fromCharCode(92), '/').split('/');
    if (parts.length < 2 || parts.includes('..') || parts[0] === '') continue;
    const destination = path.join(configDir, ...parts);
    const source = legacySourcePath(parts, kitRoot);
    if (!source) continue;
    if (parts[0] === 'skills' && parts.length === 2) {
      if (await sameTree(source, destination)) {
        for (const file of await walkFiles(destination)) {
          const pathInConfig = path.posix.join(relative, file.relative);
          owned.set(pathInConfig, await fileHash(path.join(source, file.relative)));
        }
      }
      continue;
    }
    const sourceHash = await fileHash(source);
    if (sourceHash !== null && sourceHash === await fileHash(destination)) owned.set(relative, sourceHash);
  }
  return owned;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function fileHash(file) {
  try {
    if (!(await lstat(file)).isFile()) return null;
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

/** Refuses to write through a symlink below the user's selected config root. */
async function safeParent(configDir, target) {
  const root = path.resolve(configDir);
  const parent = path.resolve(path.dirname(target));
  const relative = path.relative(root, parent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/** True when the path exists, including a broken symlink. */
async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies or removes the OpenCode install.
 *
 * @param {{ apply: boolean, remove: boolean, force: boolean, env?: object, home?: string, kitRoot?: string, readFileImpl?: Function, writeFileImpl?: Function }} input
 * @returns {Promise<{ plan: object, changed: string[], configPath: string, entry: string }>}
 */
export async function applyOpenCode({ apply, remove, force, env = process.env, home = os.homedir(), kitRoot = KIT_ROOT, readFileImpl = readFile, writeFileImpl = writeFile }) {
  const pkg = JSON.parse(await readFileImpl(path.join(kitRoot, 'package.json'), 'utf8'));
  const configDir = opencodeConfigDir(env, home);
  const entry = opencodePluginEntry(pkg.version);
  const configFile = await openCodeConfigFile(configDir, readFileImpl);
  const current = readPluginArray(configFile.text);
  // Work on the raw elements so a `[spec, options]` tuple keeps its options; identity is exact, never a
  // prefix, so a sibling package such as `omp-reviewer-kit-helper` survives both install and removal.
  const keptItems = current.items.filter((item, index) => !isKitPackageSpec(current.entries[index]));
  const kitItem = JSON.stringify(entry);
  const desiredItems = remove
    ? keptItems
    : (current.entries.includes(entry) && !force ? current.items : [...keptItems, kitItem]);
  const plan = planHostInstall({ host: 'opencode', version: pkg.version, action: remove ? 'remove' : 'install', kitRoot, configDir, pluginEntry: entry });
  const changed = [];
  const conflicts = [];
  const ignored = [];
  if (plan.blocked) return { plan, changed, conflicts, ignored, configPath: configFile.path, entry };

  const manifestPath = path.join(configDir, INSTALL_MANIFEST);
  let previousFiles = [];
  if (await exists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFileImpl(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.files)) throw new Error('manifest files is not an array');
      previousFiles = manifest.files;
    } catch {
      return { plan, changed, conflicts, ignored, configPath: configFile.path, entry, refused: 'the install manifest is unreadable; no files were changed' };
    }
  }

  if (!remove) {
    const preflight = await planComponentCopy({ configDir, kitRoot, previousFiles });
    conflicts.push(...preflight.conflicts);
    if (conflicts.length > 0) {
      return { plan, changed, conflicts, ignored, configPath: configFile.path, entry, refused: 'asset conflicts prevent enabling the plugin; no files were changed' };
    }
  }

  // Removing an installation never creates a config: with no file there is nothing to clean up in it.
  const shouldWrite = remove ? configFile.exists : (desiredItems.join('\n') !== current.items.join('\n') || !configFile.exists);
  const rewritten = shouldWrite ? writePluginItems(configFile.text, desiredItems) : null;
  if (shouldWrite && rewritten === null) {
    return { plan, changed, conflicts, ignored, configPath: configFile.path, entry, refused: 'the existing config has no closing brace' };
  }
  if (!apply) return { plan, changed, conflicts, ignored, configPath: configFile.path, entry };

  if (remove) {
    if (shouldWrite) {
      await mkdir(configDir, { recursive: true });
      await writeFileImpl(configFile.path, rewritten, 'utf8');
      changed.push(path.relative(process.cwd(), configFile.path) || configFile.path);
    }
    const root = path.resolve(configDir);
    const realRoot = await realpathOr(root);
    for (const record of previousFiles) {
      const relative = typeof record === 'string' ? record : record?.path;
      if (typeof relative !== 'string') {
        ignored.push(String(relative));
        continue;
      }
      const parts = relative.replaceAll(String.fromCharCode(92), '/').split('/');
      const target = path.resolve(root, ...parts);
      const realParent = await realpathOr(path.dirname(target));
      if (parts.length < 2 || parts.includes('..') || parts[0] === ''
        || target === root || !target.startsWith(root + path.sep)
        || !(realParent === realRoot || realParent.startsWith(realRoot + path.sep))
        || !await safeParent(root, target)) {
        ignored.push(relative);
        continue;
      }
      const targetHash = await fileHash(target);
      let ownedUnmodified = false;
      if (typeof record === 'string') {
        const source = legacySourcePath(parts, kitRoot);
        if (source && parts[0] === 'skills' && parts.length === 2) {
          ownedUnmodified = await sameTree(source, target);
        } else if (source && targetHash !== null) {
          ownedUnmodified = targetHash === await fileHash(source);
        }
      } else if (/^[a-f0-9]{64}$/i.test(String(record.sha256 ?? ''))) {
        ownedUnmodified = targetHash !== null && targetHash === String(record.sha256).toLowerCase();
      }
      if (!ownedUnmodified) {
        ignored.push(relative);
        continue;
      }
      const info = await lstat(target);
      await rm(target, { recursive: info.isDirectory(), force: true, maxRetries: 20, retryDelay: 250 });
      changed.push(relative);
    }
    await rm(manifestPath, { force: true });
  } else {
    const result = await copyComponents({ configDir, kitRoot, previousFiles });
    conflicts.push(...result.conflicts);
    if (conflicts.length > 0) {
      return { plan, changed, conflicts, ignored, configPath: configFile.path, entry, refused: 'asset conflicts prevent enabling the plugin; no files were changed' };
    }
    // Ownership is recorded before the config enables the plugin: a config write that fails leaves the
    // copied files recoverable, where the reverse order would strand them as unowned and then read them
    // as conflicts on every retry. If even the record cannot be written, every copy this run made is
    // undone — created files are removed and replaced files get their previous bytes back — because the
    // manifest still on disk describes exactly that earlier state.
    const record = installRecord({ version: pkg.version, files: result.files });
    try {
      await mkdir(configDir, { recursive: true });
      await writeFileImpl(manifestPath, JSON.stringify(record, null, 2), 'utf8');
    } catch (error) {
      for (const { target, previous } of result.undo) {
        if (previous === null) await rm(target, { force: true, maxRetries: 20, retryDelay: 250 });
        else await writeFile(target, previous);
      }
      throw error;
    }
    if (shouldWrite) {
      await writeFileImpl(configFile.path, rewritten, 'utf8');
      changed.push(path.relative(process.cwd(), configFile.path) || configFile.path);
    }
    changed.push(...result.copied.map(relative => path.posix.join('.', relative)));
  }
  return { plan, changed, conflicts, ignored, configPath: configFile.path, entry };
}


/** The real path of an existing path, or the resolved path when it does not exist. */
async function realpathOr(target) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function main(argv) {
  const flag = name => argv.includes(name);
  const hostArg = argv.findIndex(value => value === '--host');
  const host = hostArg >= 0 ? String(argv[hostArg + 1] ?? '') : '';
  if (!SUPPORTED_HOSTS.includes(host)) {
    process.stderr.write('usage: node scripts/host-install.mjs --host <opencode|omp|claude|codex> [--apply] [--remove] [--force]\n');
    return 2;
  }
  if (host !== 'opencode') {
    const plan = planHostInstall({ host, version: 'unknown', action: 'report', kitRoot: KIT_ROOT });
    process.stdout.write(`${host} installs itself; run:\n`);
    for (const step of plan.steps) process.stdout.write(`  ${step.detail}\n`);
    return 0;
  }
  const applying = flag('--apply');
  const removing = flag('--remove');
  const result = await applyOpenCode({ apply: applying, remove: removing, force: flag('--force') });
  const blocked = result.plan.blocked === true;
  const refused = Boolean(result.refused);
  const hasConflicts = result.conflicts.length > 0;
  const status = blocked ? 'blocked'
    : refused ? 'refused'
      : hasConflicts ? (applying ? 'applied with conflicts' : 'dry run with conflicts')
        : !applying ? 'dry run' : removing ? 'removed' : 'applied';
  process.stdout.write(`${status} — config ${result.configPath}, entry ${result.entry}\n`);
  for (const step of result.plan.steps) process.stdout.write(`  ${step.detail}${step.path ? ` (${step.path})` : ''}\n`);
  if (blocked) {
    for (const blocker of result.plan.blockers) process.stderr.write(`blocked: ${blocker.code}: ${blocker.message}\n`);
    if (result.plan.blockers.length === 0) process.stderr.write('blocked: the install plan is blocked\n');
  }
  if (refused) process.stderr.write(`refused: ${result.refused}\n`);
  if (hasConflicts) process.stderr.write(`conflicts (preserved): ${result.conflicts.join(', ')}\n`);
  if (removing) process.stdout.write(`preserved (ignored): ${result.ignored.length ? result.ignored.join(', ') : 'none'}\n`);
  if (result.changed.length > 0) process.stdout.write(`changed: ${result.changed.join(', ')}\n`);
  return blocked || refused || hasConflicts ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
