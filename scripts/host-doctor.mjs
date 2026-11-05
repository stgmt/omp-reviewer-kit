// What is installed on this machine, per host, and where every byte of it lives.
//
//   node scripts/host-doctor.mjs [--json]
//
// Read-only: it never installs, updates or deletes. A host that is absent is reported as absent, and
// a host with two install modes for one name is reported as a conflict — the one state an operator
// has to resolve by hand.

import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from '../src/infra/main-module.mjs';
import { isKitPackageSpec, opencodeConfigDir, readPluginArray } from '../src/domain/host-install-plan.mjs';

const KIT = 'omp-reviewer-kit';

async function readJson(file, readFileImpl = readFile) {
  try {
    return JSON.parse(await readFileImpl(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(file, readFileImpl = readFile) {
  try {
    return await readFileImpl(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The OMP state: registry, lock and the two install modes.
 *
 * @param {{ home: string, readFileImpl?: Function, listDirImpl?: Function }} input
 * @returns {Promise<object>}
 */
export async function inspectOmp({ home, readFileImpl = readFile, listDirImpl = readdir }) {
  const root = path.join(home, '.omp', 'plugins');
  const registry = await readJson(path.join(root, 'installed_plugins.json'), readFileImpl);
  const lock = await readJson(path.join(root, 'omp-plugins.lock.json'), readFileImpl);
  let npmInstalled = false;
  try {
    await listDirImpl(path.join(root, 'node_modules', KIT));
    npmInstalled = true;
  } catch {
    npmInstalled = false;
  }
  const marketplaceEntries = Object.entries(registry?.plugins ?? {}).filter(([key]) => key.startsWith(`${KIT}@`));
  const marketplaces = await readJson(path.join(home, '.omp', 'marketplaces.json'), readFileImpl);
  const ourMarketplace = (marketplaces?.marketplaces ?? []).find(entry => entry?.name === KIT) ?? null;
  const lockVersion = lock?.plugins?.[KIT]?.version ?? null;
  const findings = [];
  if (npmInstalled && marketplaceEntries.length > 0) {
    findings.push({
      code: 'duplicate-install-mode',
      message: `two install modes for ${KIT}: npm form in ${path.join(root, 'node_modules', KIT)} and marketplace form in ${marketplaceEntries[0][1]?.[0]?.installPath ?? 'unknown'}. Run: omp plugin uninstall ${KIT} --scope user, then omp plugin marketplace add stgmt/omp-reviewer-kit and omp plugin install ${KIT}@${KIT}`,
    });
  }
  if (ourMarketplace && ourMarketplace.sourceType === 'local') {
    findings.push({
      code: 'local-marketplace',
      message: `the ${KIT} marketplace points at a local checkout (${ourMarketplace.sourceUri}); a machine that installs from GitHub should use it instead. Run: omp plugin marketplace remove ${KIT}, then omp plugin marketplace add stgmt/omp-reviewer-kit`,
    });
  }
  return {
    host: 'omp',
    installed: npmInstalled || marketplaceEntries.length > 0,
    version: lockVersion ?? marketplaceEntries[0]?.[1]?.[0]?.version ?? null,
    mode: npmInstalled ? 'npm' : marketplaceEntries.length > 0 ? 'marketplace' : 'absent',
    marketplaceSource: ourMarketplace ? `${ourMarketplace.sourceType}:${ourMarketplace.sourceUri}` : null,
    paths: [root, path.join(root, 'node_modules', KIT), path.join(root, 'cache', 'plugins'), path.join(home, '.omp', 'marketplaces.json')],
    findings,
  };
}

/**
 * The Claude Code state: enabled plugin + marketplace clone + cache directory.
 *
 * @param {{ home: string, readFileImpl?: Function, listDirImpl?: Function }} input
 * @returns {Promise<object>}
 */
export async function inspectClaude({ home, readFileImpl = readFile, listDirImpl = readdir }) {
  const root = path.join(home, '.claude', 'plugins');
  const settings = await readJson(path.join(home, '.claude', 'settings.json'), readFileImpl);
  const enabled = settings?.enabledPlugins?.[`${KIT}@${KIT}`] === true;
  const registry = await readJson(path.join(root, 'installed_plugins.json'), readFileImpl);
  const entry = registry?.plugins?.[`${KIT}@${KIT}`]?.[0] ?? null;
  let cacheVersions = [];
  try {
    cacheVersions = await listDirImpl(path.join(root, 'cache', KIT, KIT));
  } catch {
    cacheVersions = [];
  }
  return {
    host: 'claude',
    installed: enabled || entry !== null,
    version: entry?.version ?? (cacheVersions.length > 0 ? cacheVersions[cacheVersions.length - 1] : null),
    mode: entry === null ? 'absent' : 'marketplace',
    paths: [path.join(home, '.claude', 'settings.json'), path.join(root, 'marketplaces', KIT), path.join(root, 'cache', KIT, KIT), path.join(root, 'installed_plugins.json')],
    findings: enabled || entry !== null ? [] : [{ code: 'absent', message: `${KIT} is not installed for Claude Code` }],
  };
}

/**
 * The Codex state: config sections, marketplace snapshot and plugin cache.
 *
 * @param {{ home: string, readFileImpl?: Function, listDirImpl?: Function }} input
 * @returns {Promise<object>}
 */
export async function inspectCodex({ home, readFileImpl = readFile, listDirImpl = readdir }) {
  const root = path.join(home, '.codex');
  const config = activeToml((await readText(path.join(root, 'config.toml'), readFileImpl)) ?? '');
  const marketplaceBlock = new RegExp(`\\[marketplaces\\.${KIT}\\]`).test(config);
  const pluginLine = new RegExp(`\\[plugins\\."${KIT}@${KIT}"\\]`).test(config);
  const enabled = pluginLine && /enabled\s*=\s*true/.test(config.split(`[plugins."${KIT}@${KIT}"]`)[1]?.split('[')[0] ?? '');
  let cacheVersions = [];
  try {
    cacheVersions = await listDirImpl(path.join(root, 'plugins', 'cache', KIT, KIT));
  } catch {
    cacheVersions = [];
  }
  return {
    host: 'codex',
    installed: enabled || cacheVersions.length > 0,
    version: cacheVersions.length > 0 ? cacheVersions[cacheVersions.length - 1] : null,
    mode: marketplaceBlock ? 'marketplace' : 'absent',
    paths: [path.join(root, 'config.toml'), path.join(root, '.tmp', 'marketplaces', KIT), path.join(root, 'plugins', 'cache', KIT, KIT)],
    findings: marketplaceBlock ? [] : [{ code: 'absent', message: `${KIT} has no Codex marketplace entry` }],
  };
}

/**
 * The TOML a reader would honour: every comment removed, so `# [marketplaces.x]` is not configuration.
 * A `#` inside a quoted value is kept, because there it is data.
 *
 * @param {string} text
 * @returns {string}
 */
export function activeToml(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => {
      let quote = null;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote) {
          if (character === quote) quote = null;
          continue;
        }
        if (character === '"' || character === "'") { quote = character; continue; }
        if (character === '#') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

/**
 * The OpenCode state: plugin array entry, config dir manifest and the copied components.
 *
 * @param {{ env: object, home: string, readFileImpl?: Function }} input
 * @returns {Promise<object>}
 */
export async function inspectOpenCode({ env = process.env, home, readFileImpl = readFile }) {
  const dir = opencodeConfigDir(env, home);
  const config = (await readText(path.join(dir, 'opencode.json'), readFileImpl)) ?? (await readText(path.join(dir, 'opencode.jsonc'), readFileImpl)) ?? '';
  // Exact identity: a sibling package does not make this kit installed.
  const entries = readPluginArray(config).entries.filter(value => isKitPackageSpec(value));
  const manifest = await readJson(path.join(dir, '.omp-reviewer-kit-manifest.json'), readFileImpl);
  return {
    host: 'opencode',
    installed: entries.length > 0,
    version: manifest?.version ?? null,
    mode: entries.length > 0 ? 'plugin' : 'absent',
    paths: [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc'), path.join(dir, '.omp-reviewer-kit-manifest.json')],
    findings: entries.length > 0 ? [] : [{ code: 'absent', message: `${KIT} is not in the OpenCode plugin array` }],
  };
}

/**
 * Every host in one report.
 *
 * @param {{ home?: string, env?: object, readFileImpl?: Function, listDirImpl?: Function }} [input]
 * @returns {Promise<Array<object>>}
 */
export async function inspectHosts({ home = os.homedir(), env = process.env, readFileImpl = readFile, listDirImpl = readdir } = {}) {
  return [
    await inspectOmp({ home, readFileImpl, listDirImpl }),
    await inspectClaude({ home, readFileImpl, listDirImpl }),
    await inspectCodex({ home, readFileImpl, listDirImpl }),
    await inspectOpenCode({ env, home, readFileImpl }),
  ];
}

/**
 * One line per host: version, mode, and what has to be resolved.
 *
 * @param {Array<object>} hosts
 * @returns {string[]}
 */
export function renderHostReport(hosts) {
  const lines = [];
  for (const host of hosts) {
    const version = host.version ?? 'not installed';
    lines.push(`${host.host.padEnd(9)} ${version.padEnd(12)} mode=${host.mode}`);
    for (const finding of host.findings) lines.push(`  ${finding.code}: ${finding.message}`);
  }
  const blocking = hosts.filter(host => host.findings.some(finding => finding.code === 'duplicate-install-mode'));
  if (blocking.length > 0) lines.push(`conflict: ${blocking.map(host => host.host).join(', ')} has two install modes for ${KIT}`);
  return lines;
}

async function main(argv) {
  const hosts = await inspectHosts();
  const conflicted = hosts.some(host => host.findings.some(finding => finding.code === 'duplicate-install-mode'));
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ kit: KIT, conflicted, hosts }, null, 2)}\n`);
    return conflicted ? 1 : 0;
  }
  for (const line of renderHostReport(hosts)) process.stdout.write(`${line}\n`);
  return conflicted ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
