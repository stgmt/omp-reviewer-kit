// One reuse analysis over a staged snapshot: scan, index, and write the artifact the orchestrator
// reads. Additive by construction — it produces hints and evidence, never a verdict, and a skipped
// analysis states its reason instead of leaving the stage implicit.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyFilePath } from '../../domain/file-class.mjs';
import { resolveReuseConfig, resolveReusePolicy } from './config.mjs';
import { findReuseCandidates } from './index.mjs';
import { buildReuseAnalysis, REUSE_RELATIVE_PATH } from './report.mjs';
import { createFileCache, scanUnits } from './scan.mjs';

/**
 * @param {{
 *   context: { snapshot: { dir: string, changedPaths: string[], diffHash: string } },
 *   env?: object,
 *   now?: () => number,
 *   config?: Partial<ReturnType<typeof resolveReuseConfig>>,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   spawnSync?: Function,
 *   pythonBin?: string,
 *   cache?: object|null,
 * }} input
 * @returns {Promise<
 *   { skipped: true, reason: string, policy: string } |
 *   { skipped: false, policy: string, analysisPath: string|null, artifactWritten: boolean, artifactError: string|null, analysis: object }
 * >}
 */
export async function runReuseAnalysis({
  context,
  env = process.env,
  now = Date.now,
  config = undefined,
  loadParser,
  spawnSync = null,
  pythonBin = undefined,
  cache = undefined,
}) {
  const { dir: snapshotDir, changedPaths, diffHash } = context.snapshot;
  // The interpreter is configuration, not a constant: a machine that reaches Python as `python3` or
  // through a virtual environment declares it once and both scans honour it.
  const interpreter = pythonBin ?? env?.OMP_REVIEW_KIT_PYTHON ?? 'python';
  const policy = resolveReusePolicy(env);
  if (policy === 'off') return { skipped: true, reason: 'policy-off', policy };
  const changedExecutable = changedPaths.filter(file => classifyFilePath(file) === 'executable');
  if (changedExecutable.length === 0) return { skipped: true, reason: 'no-executable-change', policy };

  let scan;
  let candidates;
  let considered;
  try {
    ({ scan, candidates, considered } = await computeHints());
  } catch (error) {
    // The stage is advisory: a defect in it costs the hints, never the review.
    return { skipped: true, reason: `analysis-failed: ${error instanceof Error ? error.message : String(error)}`, policy };
  }

  async function computeHints() {
  const resolved = resolveReuseConfig(config ?? {});
  const scan = await scanUnits({
    snapshotDir,
    config: resolved,
    now,
    loadParser,
    spawnSync,
    pythonBin: interpreter,
    cache: cache === undefined ? createFileCache({ env }) : cache,
  });
  const found = findReuseCandidates({ units: scan.units, changedPaths: changedExecutable, config: resolved });
  return { scan, candidates: found.candidates, considered: found.considered };
  }

  const analysis = buildReuseAnalysis({
    diffHash,
    policy,
    scan: { ...scan, units: scan.units.length },
    considered,
    candidates,
  });
  // The artifact is a convenience for the reviewer: a snapshot that cannot be written must cost
  // the hints, never the review. The failure is reported, and the assignment still carries the
  // rendered lines, which are already in memory.
  const analysisPath = path.join(snapshotDir, REUSE_RELATIVE_PATH);
  let artifactWritten = false;
  let artifactError = null;
  try {
    await mkdir(path.dirname(analysisPath), { recursive: true });
    await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
    artifactWritten = true;
  } catch (error) {
    artifactError = error instanceof Error ? error.message : String(error);
  }
  return {
    skipped: false,
    policy,
    analysisPath: artifactWritten ? REUSE_RELATIVE_PATH : null,
    artifactWritten,
    artifactError,
    analysis,
  };
}
