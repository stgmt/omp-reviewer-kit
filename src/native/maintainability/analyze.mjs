// One maintainability analysis over a staged snapshot: collect, extract, group, and write the
// candidate file the subagent reads. Deterministic from the snapshot content alone.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyFilePath } from '../../domain/file-class.mjs';
import { analysisHeader } from '../../domain/analysis-header.mjs';
import { SCHEMA, resolveConfig, resolvePolicy } from './config.mjs';
import { collectExecutableFiles, extractSignatures } from './extract.mjs';
import { groupClumps } from './group.mjs';

/** Where the candidate file lives inside the staged snapshot. */
export const ANALYSIS_RELATIVE_PATH = '.review/maintainability.json';

/**
 * @param {{
 *   rootDir: string,
 *   changedPaths: string[],
 *   diffHash: string,
 *   config: object,
 *   policy: string,
 *   now?: () => number,
 *   pythonBin?: string,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   spawnSync?: Function,
 * }} input
 * @returns {Promise<{ analysis: object, analysisPath: string, skipped: false } | { skipped: true, reason: string }>}
 */
export async function analyzeTree({
  rootDir,
  changedPaths,
  diffHash,
  config,
  policy,
  now = Date.now,
  pythonBin = 'python',
  loadParser,
  spawnSync,
}) {
  const changedExecutable = changedPaths.filter(file => classifyFilePath(file) === 'executable');
  if (changedExecutable.length === 0) return { skipped: true, reason: 'no-executable-change' };

  const started = now();
  const collected = await collectExecutableFiles({ rootDir, config, classify: classifyFilePath });
  const extracted = await extractSignatures({
    rootDir,
    paths: collected.paths,
    config,
    now,
    pythonBin,
    loadParser,
    spawnSync,
  });

  const supportComplete = extracted.truncated !== true;
  const grouped = extracted.status === 'failed'
    ? { groups: [], excluded: [], dropped: 0 }
    : groupClumps({
      signatures: extracted.signatures,
      classOf: classifyFilePath,
      changedPaths,
      config,
      supportComplete,
    });

  const unsupported = extracted.languages.length === 0 && extracted.unparsedFiles.length > 0;
  const status = extracted.status === 'failed'
    ? 'failed'
    : grouped.groups.length > 0
      ? 'analyzed'
      : unsupported
        ? 'unsupported'
        : 'no-candidates';

  // A file in a language the kit does not analyse is reported, but it does not make the analysis
  // partial: nothing was expected from it. A supported file that failed does.
  const unanalysed = extracted.unparsedFiles.filter(entry => entry.reason !== 'unsupported-syntax');

  const analysis = {
    ...analysisHeader({ schema: SCHEMA, diffHash, policy }),
    status,
    coverage: unanalysed.length > 0 || extracted.truncated || grouped.dropped > 0 ? 'partial' : 'full',
    scan: {
      filesRead: extracted.filesRead,
      filesSkipped: extracted.filesSkipped + collected.skipped.length,
      elapsedMs: now() - started,
      truncated: extracted.truncated === true,
    },
    config: {
      minSupport: config.minSupport,
      minSize: config.minSize,
      maxGroups: config.maxGroups,
      maxFileBytes: config.maxFileBytes,
      maxScanFiles: config.maxScanFiles,
      maxScanMs: config.maxScanMs,
      policy,
    },
    languages: extracted.languages,
    unparsedFiles: extracted.unparsedFiles,
    failures: extracted.failures,
    excluded: dedupeExcluded(grouped.excluded),
    droppedGroups: grouped.dropped,
    groups: grouped.groups,
  };

  return { skipped: false, analysis, analysisPath: path.join(rootDir, ANALYSIS_RELATIVE_PATH) };
}

/**
 * Writes the candidate file next to the other review inputs. A partial scan is still written:
 * the subagent must see what was and was not read.
 *
 * @param {string} analysisPath
 * @param {object} analysis
 */
export async function writeAnalysis(analysisPath, analysis) {
  await mkdir(path.dirname(analysisPath), { recursive: true });
  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
}

/**
 * Analysis of a staged snapshot, honouring the blocking policy. `off` writes nothing and returns
 * the reason the stage will not exist; every other policy produces the candidate file.
 *
 * @param {{
 *   snapshotDir: string,
 *   changedPaths: string[],
 *   diffHash: string,
 *   env?: object,
 *   config?: object,
 *   now?: () => number,
 *   pythonBin?: string,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   spawnSync?: Function,
 * }} input
 * @returns {Promise<{
 *   policy: string,
 *   skipped: boolean,
 *   reason: string|null,
 *   analysis: object|null,
 *   analysisPath: string|null,
 * }>}
 */
export async function runMaintainabilityAnalysis({
  context,
  env = {},
  config = resolveConfig(),
  now = Date.now,
  pythonBin = env?.OMP_REVIEW_KIT_PYTHON ?? 'python',
  loadParser,
  spawnSync,
}) {
  const { dir: snapshotDir, changedPaths, diffHash } = context.snapshot;
  const policy = resolvePolicy(env);
  if (policy === 'off') return { policy, skipped: true, reason: 'policy-off', analysis: null, analysisPath: null };
  let result;
  try {
    result = await analyzeTree({ rootDir: snapshotDir, changedPaths, diffHash, config, policy, now, pythonBin, loadParser, spawnSync });
  } catch (error) {
    const failure = failureAnalysis({ diffHash, config, policy, error });
    const analysisPath = path.join(snapshotDir, ANALYSIS_RELATIVE_PATH);
    await writeAnalysis(analysisPath, failure).catch(() => {});
    return { policy, skipped: false, reason: 'analysis-failed', analysis: failure, analysisPath };
  }
  if (result.skipped) return { policy, skipped: true, reason: result.reason, analysis: null, analysisPath: null };
  await writeAnalysis(result.analysisPath, result.analysis);
  return { policy, skipped: false, reason: null, analysis: result.analysis, analysisPath: result.analysisPath };
}

function failureAnalysis({ diffHash, config, policy, error }) {
  return {
    schema: SCHEMA,
    diffHash,
    status: 'failed',
    coverage: 'partial',
    scan: { filesRead: 0, filesSkipped: 0, elapsedMs: 0, truncated: false },
    config: {
      minSupport: config.minSupport,
      minSize: config.minSize,
      maxGroups: config.maxGroups,
      maxFileBytes: config.maxFileBytes,
      maxScanFiles: config.maxScanFiles,
      maxScanMs: config.maxScanMs,
      policy,
    },
    languages: [],
    unparsedFiles: [],
    failures: [{ path: null, reason: 'analysis-failed', message: String(error?.message ?? error) }],
    excluded: [],
    droppedGroups: 0,
    groups: [],
  };
}

function dedupeExcluded(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = `${entry.path}\u0000${entry.ground}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.ground < b.ground ? -1 : 1));
}
