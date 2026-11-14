// The version census of one staged diff. Deterministic and additive: it reads the changed code,
// groups the schema literals by family, and answers who produces, who consumes and who merely lists
// each version. A version that is read or listed but produced nowhere in the snapshot is the shape a
// dead compatibility branch takes — the census names it, the hunter decides what it means.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { analysisHeader } from '../../domain/analysis-header.mjs';
import { classifyFilePath } from '../../domain/file-class.mjs';
import { isTestPath } from '../../domain/suspicion-map.mjs';
import { COMPAT_FILE, SCHEMA, resolveCompatConfig, resolveCompatPolicy } from './config.mjs';
import { extractCompat, familyOf } from './extract.mjs';

export const COMPAT_SCHEMA = SCHEMA;

/**
 * @param {{
 *   context: { snapshot: { dir: string, changedPaths: string[], diffHash: string } },
 *   env?: object,
 *   config?: object,
 *   now?: () => number,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   pythonBin?: string,
 *   spawnSync?: Function,
 * }} input
 * @returns {Promise<{
 *   skipped: boolean, policy: string, reason: string|null,
 *   analysis: object|null, analysisPath: string|null, artifactError?: string|null,
 * }>}
 */
export async function runCompatAnalysis({ context, env = {}, config = resolveCompatConfig(), now = Date.now, loadParser, pythonBin, spawnSync = null }) {
  const policy = resolveCompatPolicy(env);
  const { dir: snapshotDir, changedPaths, diffHash } = context.snapshot;
  if (policy === 'off') return { skipped: true, reason: 'policy-off', policy, analysis: null, analysisPath: null };
  const interpreter = pythonBin ?? env?.OMP_REVIEW_KIT_PYTHON ?? 'python';
  // A test that enumerates versions is a fixture, not a producer: the census reads product code.
  const executable = changedPaths.filter(file => classifyFilePath(file) === 'executable' && !isTestPath(file));
  if (executable.length === 0) return { skipped: true, reason: 'no-code-change', policy, analysis: null, analysisPath: null };
  const analysisPath = path.join(snapshotDir, COMPAT_FILE);
  let extracted;
  try {
    extracted = await extractCompat({ rootDir: snapshotDir, paths: executable, config, now, loadParser, pythonBin: interpreter, spawnSync });
  } catch (error) {
    const analysis = failureAnalysis({ diffHash, policy, error });
    const artifactError = await writeCompat(analysisPath, analysis);
    return { skipped: false, policy, reason: 'analysis-failed', analysis, analysisPath, artifactError };
  }
  const analysis = buildAnalysis({ diffHash, policy, config, changed: executable.length, extracted });
  const artifactError = await writeCompat(analysisPath, analysis);
  return { skipped: false, policy, reason: null, analysis, analysisPath, artifactError };
}

/**
 * Groups the extracted sites by family and version. Every site keeps its file and line; the caps
 * drop sites rather than inventing a clean result, and a dropped site sets `truncated`.
 *
 * @param {{ diffHash: string, policy: string, config: object, changed: number, extracted: object }} input
 * @returns {object}
 */
export function buildAnalysis({ diffHash, policy, config, changed, extracted }) {
  const families = new Map();
  const seen = new Set();
  let sites = 0;
  let truncated = extracted.truncated === true;
  const record = (file, site, kind) => {
    if (!site || typeof site.version !== 'string' || site.version.length === 0) return;
    if (sites >= config.maxSites) {
      truncated = true;
      return;
    }
    const family = familyOf(site.version);
    const entry = families.get(family) ?? { family, versions: new Map() };
    const version = entry.versions.get(site.version) ?? { version: site.version, produced: [], consumed: [], listed: [] };
    const key = `${kind}\u0000${site.version}\u0000${file}\u0000${site.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      sites += 1;
      const where = { path: file, line: site.line };
      if (kind === 'consumed') {
        where.guard = site.guard ?? null;
        where.constant = site.constant ?? null;
      }
      if (kind === 'listed') where.table = site.table ?? null;
      version[kind].push(where);
    }
    entry.versions.set(site.version, version);
    families.set(family, entry);
  };

  for (const file of extracted.files) {
    for (const site of file.produced) record(file.path, site, 'produced');
    for (const site of file.consumed) record(file.path, site, 'consumed');
    for (const site of file.listed) record(file.path, site, 'listed');
  }

  // A reader may import the version constant its producer defines. The name is resolved against the
  // constants of every changed module, so `SCHEMA_V8` used in another file still names v8.
  const known = new Map();
  for (const file of extracted.files) {
    for (const constant of file.constants ?? []) {
      if (!constant || typeof constant.name !== 'string' || typeof constant.version !== 'string') continue;
      const versions = known.get(constant.name) ?? [];
      if (!versions.includes(constant.version)) versions.push(constant.version);
      known.set(constant.name, versions);
    }
  }
  // A supported list is a list of versions, not a single constant: `SUPPORTED.includes(schema)` in
  // JavaScript and `schema in SUPPORTED` in Python consume every member the list declares.
  const knownLists = new Map();
  for (const file of extracted.files) {
    for (const list of file.lists ?? []) {
      if (!list || typeof list.name !== 'string' || !Array.isArray(list.versions)) continue;
      const versions = knownLists.get(list.name) ?? [];
      for (const version of list.versions) if (!versions.includes(version)) versions.push(version);
      knownLists.set(list.name, versions);
    }
  }
  for (const file of extracted.files) {
    for (const entry of file.pending ?? []) {
      const versions = entry.list === true ? (knownLists.get(entry.name) ?? []) : (known.get(entry.name) ?? []);
      for (const version of versions) {
        record(file.path, { version, line: entry.line, guard: entry.guard, constant: entry.name, table: entry.table }, entry.kind);
      }
    }
  }

  const ordered = [...families.values()]
    .map(entry => ({
      family: entry.family,
      versions: [...entry.versions.values()].sort((a, b) => compareVersion(a.version, b.version)),
    }))
    .sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));

  const deadVersions = [];
  const unproducedVersions = [];
  const deadBranches = [];
  const elsewhereByVersion = new Map();
  for (const site of extracted.elsewhere ?? []) {
    const list = elsewhereByVersion.get(site.version) ?? [];
    list.push(site);
    elsewhereByVersion.set(site.version, list);
  }
  for (const family of ordered) {
    for (const version of family.versions) {
      if (version.produced.length > 0) continue;
      if (version.consumed.length === 0 && version.listed.length === 0) continue;
      const elsewhere = elsewhereByVersion.get(version.version) ?? [];
      if (elsewhere.length === 0 && (extracted.elsewhereTruncated === true || truncated)) {
        // Either the walk that looks for producers elsewhere, or the site scan itself, was cut off:
        // a version with no recorded producer is not proven dead, only not found.
        unproducedVersions.push({
          family: family.family,
          version: version.version,
          consumed: version.consumed,
          listed: version.listed,
          elsewhere: [],
          reason: extracted.elsewhereTruncated === true ? 'snapshot-scan-truncated' : 'site-scan-truncated',
        });
        continue;
      }
      if (elsewhere.length > 0) {
        // The change only reads this version; an unchanged module still writes the literal. That is
        // not a dead format, so the census says where the producer may live instead of claiming one
        // does not exist.
        unproducedVersions.push({
          family: family.family,
          version: version.version,
          consumed: version.consumed,
          listed: version.listed,
          elsewhere: elsewhere.slice(0, 4),
          reason: 'not-produced-by-this-change',
        });
        continue;
      }
      deadVersions.push({
        family: family.family,
        version: version.version,
        consumed: version.consumed,
        listed: version.listed,
        reason: 'never-produced-in-snapshot',
      });
      for (const site of version.consumed) {
        deadBranches.push({ file: site.path, line: site.line, version: version.version, guard: site.guard ?? null, constant: site.constant ?? null });
      }
    }
  }

  const shownFamilies = ordered.slice(0, config.maxFamilies);
  const droppedFamilies = ordered.length - shownFamilies.length;
  const tables = [];
  for (const file of extracted.files) {
    for (const site of file.listed) tables.push({ path: file.path, line: site.line, name: site.table ?? null, version: site.version });
  }

  return {
    ...analysisHeader({ schema: SCHEMA, diffHash, policy }),
    status: extracted.failures.length > 0 ? 'failed' : 'ok',
    coverage: truncated || extracted.elsewhereTruncated === true || extracted.unparsed.length > 0 || droppedFamilies > 0 ? 'partial' : 'full',
    scan: {
      changed,
      files: extracted.scanned,
      parsed: extracted.files.length,
      sites,
      elapsedMs: extracted.elapsedMs,
      truncated: truncated || extracted.elsewhereTruncated === true,
      droppedFamilies,
      unparsed: extracted.unparsed.slice(0, 20),
      unparsedTotal: extracted.unparsed.length,
    },
    failures: extracted.failures,
    families: shownFamilies,
    deadVersions,
    unproducedVersions,
    deadBranches,
    tables,
  };
}

/**
 * Orders `v2` before `v10`; a literal without a numeric tail sorts after the numbered ones.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersion(left, right) {
  const a = /\/v(\d+)$/.exec(left);
  const b = /\/v(\d+)$/.exec(right);
  if (a && b) return Number(a[1]) - Number(b[1]);
  if (a) return -1;
  if (b) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function failureAnalysis({ diffHash, policy, error }) {
  return {
    ...analysisHeader({ schema: SCHEMA, diffHash, policy }),
    status: 'failed',
    coverage: 'failed',
    scan: {
      changed: 0,
      files: 0,
      parsed: 0,
      sites: 0,
      elapsedMs: 0,
      truncated: false,
      droppedFamilies: 0,
      unparsed: [],
      unparsedTotal: 0,
    },
    failures: [{ path: null, reason: 'analysis-failed', message: String(error?.message ?? error) }],
    families: [],
    deadVersions: [],
    unproducedVersions: [],
    deadBranches: [],
    tables: [],
  };
}

/**
 * The artifact is a convenience for the reviewer: a snapshot that cannot be written costs the
 * artifact, never the census, and the failure is reported instead of thrown.
 *
 * @param {string} analysisPath
 * @param {object} analysis
 * @returns {Promise<string|null>}
 */
async function writeCompat(analysisPath, analysis) {
  try {
    await mkdir(path.dirname(analysisPath), { recursive: true });
    await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
