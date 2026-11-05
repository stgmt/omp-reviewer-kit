// The installer for the host that has no marketplace: OpenCode. It writes the plugin entry into the
// config array (JSONC preserved), copies the components OpenCode only reads from a config directory
// (agents, skills, commands), records exactly what it copied, and can remove all of it again.
//
//   node scripts/host-install.mjs --host opencode [--apply] [--force]
//   node scripts/host-install.mjs --host opencode --remove [--apply]
//   node scripts/host-install.mjs --host omp|claude|codex        # prints the host's own commands
//
// Without --apply it is a dry run that prints the plan. Nothing here installs for OMP, Claude Code or
// Codex: those hosts install themselves, and re-implementing their install would create a second,
// divergent copy of their state.

import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
  planHostInstall,
  readPluginArray,
  writePluginArray,
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
 * Copies the components OpenCode only discovers in a config directory, and returns the list it
 * copied so a removal can delete exactly those files.
 *
 * @param {{ configDir: string, kitRoot?: string }} input
 * A destination that already exists belongs to the user: the installer never overwrites it and never
 * records it, so a later removal cannot delete content the kit did not create.
 *
 * @returns {Promise<{ copied: string[], conflicts: string[] }>} config-relative paths
 */
export async function copyComponents({ configDir, kitRoot = KIT_ROOT }) {
  const copied = [];
  const conflicts = [];
  for (const component of OPENCODE_COMPONENTS) {
    const source = path.join(kitRoot, component.from);
    let entries;
    try {
      entries = await readdir(source, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A directory is a skill; a Markdown file is an agent or a command. Both are what OpenCode
      // discovers in a config directory, and copying only directories silently drops the agents.
      if (!entry.isDirectory() && !entry.name.endsWith(component.pattern)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(configDir, component.to, entry.name);
      const relative = path.posix.join(component.to, entry.name);
      if (await exists(to)) {
        conflicts.push(relative);
        continue;
      }
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { recursive: true });
      copied.push(relative);
    }
  }
  return { copied, conflicts };
}

/** True when the path exists, whatever it is. */
async function exists(target) {
  try {
    await stat(target);
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
  const entry = `omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git`;
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
  if (!apply || plan.blocked) return { plan, changed, conflicts, ignored, configPath: configFile.path, entry };

  // Removing an installation never creates a config: with no file there is nothing to clean up in it.
  const shouldWrite = remove ? configFile.exists : (desiredItems.join('\n') !== current.items.join('\n') || !configFile.exists);
  if (shouldWrite) {
    const rewritten = writePluginItems(configFile.text, desiredItems);
    if (rewritten === null) {
      // The existing file cannot be preserved, so nothing is written: a broken config is the user's to
      // fix, and an install must never replace it with a fresh object.
      return { plan, changed, conflicts, ignored, configPath: configFile.path, entry, refused: 'the existing config has no closing brace' };
    }
    await mkdir(configDir, { recursive: true });
    await writeFileImpl(configFile.path, rewritten, 'utf8');
    changed.push(path.relative(process.cwd(), configFile.path) || configFile.path);
  }
  const manifestPath = path.join(configDir, INSTALL_MANIFEST);
  if (remove) {
    let recorded = [];
    try {
      recorded = JSON.parse(await readFileImpl(manifestPath, 'utf8')).files ?? [];
    } catch {
      recorded = [];
    }
    const root = path.resolve(configDir);
    const realRoot = await realpathOr(root);
    for (const relative of recorded) {
      // The manifest is a file on disk and can be edited: a path that escapes the config directory is
      // never deleted, and the refusal is reported instead.
      const target = path.resolve(root, String(relative));
      const realParent = await realpathOr(path.dirname(target));
      // Symlinks count: a component directory that points outside the config root is not ours to delete.
      if (target === root || !target.startsWith(root + path.sep)
        || !(realParent === realRoot || realParent.startsWith(realRoot + path.sep))) {
        ignored.push(String(relative));
        continue;
      }
      await rm(target, { recursive: true, force: true });
      changed.push(relative);
    }
    await rm(manifestPath, { force: true });
  } else {
    const result = await copyComponents({ configDir, kitRoot });
    conflicts.push(...result.conflicts);
    // The record is cumulative: a second apply skips what already exists, and replacing the record
    // with the files this invocation copied would forget the first install's components, which a
    // later removal then leaves behind.
    let previousFiles = [];
    try {
      previousFiles = JSON.parse(await readFileImpl(manifestPath, 'utf8')).files ?? [];
    } catch {
      previousFiles = [];
    }
    const record = installRecord({ version: pkg.version, files: [...previousFiles, ...result.copied] });
    await writeFileImpl(manifestPath, JSON.stringify(record, null, 2), 'utf8');
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
  const result = await applyOpenCode({ apply: flag('--apply'), remove: flag('--remove'), force: flag('--force') });
  process.stdout.write(`${flag('--apply') ? 'applied' : 'dry run'} — config ${result.configPath}, entry ${result.entry}\n`);
  for (const step of result.plan.steps) process.stdout.write(`  ${step.detail}${step.path ? ` (${step.path})` : ''}\n`);
  if (result.changed.length > 0) process.stdout.write(`changed: ${result.changed.join(', ')}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
