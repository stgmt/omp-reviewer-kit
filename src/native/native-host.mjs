#!/usr/bin/env bun
// Entry point of the native review. Run by the Node launcher (`scripts/run-review.mjs`) under Bun,
// because OMP's library runs on Bun. Usage: bun native-host.mjs <repository>
// Exit 0 only when the reviewer's single verdict marker is PASS; any other outcome exits 1.
// The run record and the live stage lines are observations: neither can change that exit code.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoReportsDir } from '../infra/filesystem-report-store-adapter.mjs';
import { formatDuration } from '../domain/review-run-summary.mjs';
import { createRunRecorder, formatStageEvent } from './review-telemetry.mjs';
import { formatDiffSize } from '../domain/diff-budget.mjs';
import { runNativeReview } from './native-review.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { env = process.env, stderr = process.stderr, stdout = process.stdout, runReview = runNativeReview, recorder = null } = {}) {
  const repo = path.resolve(argv[0] ?? process.cwd());
  let lastProgress = '';
  const log = line => {
    if (line === lastProgress) return;
    lastProgress = line;
    stderr.write(`${line}\n`);
  };
  // Live stage lines are on by default — the point of them is to see the review working — and
  // `OMP_REVIEW_KIT_PROGRESS=0` silences them for CI. The final summary line stays either way.
  const live = env.OMP_REVIEW_KIT_PROGRESS !== '0';
  const run = recorder ?? createRunRecorder({ repo, env, kitVersion: await kitVersion() });
  const observe = async work => {
    try {
      await work();
    } catch {
      // Observation is fail-open by construction: a record that cannot be written, or a recorder
      // that throws, must never reach the verdict or the exit code.
    }
  };
  const seenStages = new Map();
  const observeEvent = event => {
    try {
      const pending = run.event?.(event);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // A broken recorder never reaches the review.
    }
  };
  await observe(() => run.start());
  log(`review: run ${run.runId} started`);
  try {
    const result = await runReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env,
      onProgress: log,
      onEvent: event => {
        if (!event || !event.agent) return;
        observeEvent(event);
        if (!live) return;
        const key = `${event.agent}|${event.lane ?? ''}`;
        const status = event.status ?? 'running';
        if (seenStages.get(key) === status) return;
        seenStages.set(key, status);
        log(formatStageEvent(status === 'running' ? { agent: event.agent, lane: event.lane, status } : event));
      },
    });
    if (!result.staged) {
      log('review: SKIPPED (no staged changes)');
      await observe(() => run.complete({ result }));
      logRunRecord(log, run);
      return 0;
    }

    if (result.refused) {
      const refused = result.refused;
      log(refused.reason === 'invalid-budget'
        ? `review: ${refused.error ?? 'diff budget invalid'}; the diff was not reviewed`
        : `review: diff too large (${refused.paths} paths, ${formatDiffSize(refused.bytes)}; budget ${refused.maxPaths} paths, ${formatDiffSize(refused.maxBytes)})`);
      await observe(() => run.complete({ result }));
      logRunRecord(log, run);
      return 1;
    }
    const { verdict, provenance, stages, fallback, budget } = result;
    log(budget && budget.maxPaths !== null
      ? `review: diff ${budget.paths} paths, ${formatDiffSize(budget.bytes)} (budget ${budget.maxPaths} paths, ${formatDiffSize(budget.maxBytes)})`
      : `review: diff ${budget?.paths ?? 'unknown'} paths, ${formatDiffSize(budget?.bytes)} (budget off)`);
    log(`review: reviewer role=${provenance.role ?? 'none'} model=${provenance.model ?? 'none'}`);
    log(`review: reviewer fallback=${fallback?.applied ? 'applied' : 'not-applied'} candidates=${fallback?.chainLength ?? 'unknown'}`);
    for (const stage of stages) {
      log(`review: stage ${stage.agent} role=${stage.role ?? 'none'} model=${stage.model ?? 'none'} exit=${stage.exitCode} structured=${stage.structuredStatus ?? 'none'}`);
    }
    const reportStarted = Date.now();
    const reportPath = await saveReport(repo, result, env);
    const reportMs = Date.now() - reportStarted;
    await observe(() => run.complete({ result, reportPath, reportMs }));
    stdout.write(result.text ? `${result.text}\n` : '');
    log(verdict.pass ? 'review: PASS' : `review: BLOCK (${verdict.reasons.join('; ')})`);
    log(`review: report ${reportPath}`);
    // In context on purpose: the tempting mistake after a BLOCK is to recalibrate an expensive
    // mutation gate for a diff that is about to change again. The gate belongs after the PASS.
    log('review: mutation gate - not part of this hook; run it once after PASS on the frozen diff, never per review round');
    logRunRecord(log, run);
    return verdict.pass ? 0 : 1;
  } catch (error) {
    await observe(() => run.fail(error));
    logRunRecord(log, run);
    stderr.write(`review: BLOCK (host error: ${error instanceof Error ? error.message : String(error)})\n`);
    return 1;
  }
}

/**
 * One line naming the record and the wall-clock duration of the whole review. Printed after the
 * verdict so the existing `review: PASS` / `review: report` lines stay exactly as they were.
 *
 * @param {(line: string) => void} log
 * @param {object} run
 */
function logRunRecord(log, run) {
  try {
    const record = run.record;
    const duration = formatDuration(record?.durationMs);
    log(`review: run ${run.runId} ${record?.state ?? 'running'} ${duration}`);
    const failure = run.writeFailure;
    if (failure) log(`review: run record not written (${failure})`);
  } catch {
    log('review: run record unavailable');
  }
}

let cachedKitVersion;

/** The kit's own version, as the record's provenance. A missing or unreadable package is `null`. */
async function kitVersion() {
  if (cachedKitVersion !== undefined) return cachedKitVersion;
  try {
    const raw = await readFile(path.join(KIT_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    cachedKitVersion = typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    cachedKitVersion = null;
  }
  return cachedKitVersion;
}

/**
 * The audit trail lives outside the repository, next to the reports of earlier releases.
 *
 * @param {string} repo
 * @param {Awaited<ReturnType<typeof runNativeReview>>} result
 * @param {NodeJS.ProcessEnv} env
 */
async function saveReport(repo, result, env) {
  const dir = repoReportsDir(repo, { env });
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${result.diffHash.slice(0, 12)}.md`);
  const lines = [
    `# reviewer-kit review: ${result.verdict.verdict}`,
    '',
    `- Diff SHA-256: ${result.diffHash}`,
    `- Profile: ${result.profile}; lanes: ${result.lanes.join(', ')}`,
    `- Reviewer role/model (OMP resolved): ${result.provenance.role ?? 'none'} / ${result.provenance.model ?? 'none'}`,
    ...fallbackLines(result.fallback),
    `- Staged paths: ${result.changedPaths.length}`,
    `- Journal: ${result.journal?.hit ? 'hit' : 'miss'} ${result.journal?.key ?? 'unavailable'}`,
    ...(Array.isArray(result.ignoredStagedPaths) && result.ignoredStagedPaths.length > 0
      ? [`- Staged paths ignored by .gitignore: ${result.ignoredStagedPaths.join(', ')}`]
      : []),
    '',
    '## Run',
    '',
    ...runLines(result),
    '',
    '## Stage evidence',
    '',
    ...result.stages.map(stage => `- ${stage.agent}: role ${stage.role ?? 'none'}, model ${stage.model ?? 'none'}, exit ${stage.exitCode}, structured ${stage.structuredStatus ?? 'none'}${stage.aborted ? ', aborted' : ''}`),
    '',
    '## Verdict reasons',
    '',
    ...(result.verdict.reasons.length > 0 ? result.verdict.reasons.map(reason => `- ${reason}`) : ['- none']),
    '',
    '## Reviewer report',
    '',
    result.text,
    '',
  ];
  await writeFile(file, lines.join('\n'), 'utf8');
  return file;
}

/**
 * The `## Run` section: wall clock, phases and one row per stage. Additive — older reports keep
 * their shape, and no line here is a verdict input.
 *
 * @param {Awaited<ReturnType<typeof runNativeReview>>} result
 * @returns {string[]}
 */
function runLines(result) {
  const summary = result.runSummary ?? {};
  const timings = summary.timings ?? {};
  const reviewer = summary.reviewer ?? {};
  const phases = [
    ['snapshot', timings.snapshotMs],
    ['native task', timings.nativeTaskMs],
    ['verdict', timings.verdictMs],
  ]
    .filter(([, ms]) => typeof ms === 'number' && Number.isFinite(ms))
    .map(([name, ms]) => `${name} ${formatDuration(ms)}`);
  const lines = [
    `- Duration: ${formatDuration(summary.durationMs)}${phases.length > 0 ? ` (${phases.join(', ')})` : ''}`,
    `- Reviewer: ${result.provenance.role ?? 'none'} / ${result.provenance.model ?? 'none'}, ${reviewer.tokens ?? 'unknown'} tokens, ${reviewer.requests ?? 'unknown'} requests`,
  ];
  const stages = Array.isArray(result.stages) ? result.stages : [];
  if (stages.length > 0) {
    lines.push('', '| Stage | Duration | Tokens | Requests | Result |', '|---|---|---|---|---|');
    for (const stage of stages) {
      const counts = Object.entries(stage.counts ?? {})
        .map(([key, value]) => `${key} ${value}`)
        .join(', ');
      lines.push(
        `| ${stage.agent ?? 'stage'} | ${formatDuration(stage.durationMs)} | ${stage.tokens ?? 'unknown'} | ${stage.requests ?? 'unknown'} | ${counts || (stage.structuredStatus ?? 'none')} |`,
      );
    }
  }
  return lines;
}

/**
 * Fallback evidence for the report header: whether OMP moved the reviewer off its requested model,
 * how long the chain OMP installed was, and the provider error when the task ended without a
 * switch. Read from the reviewer transcript; no owner configuration is read.
 *
 * @param {{ applied: boolean, requested: string|null, chainLength?: number|null, error?: string|null }|undefined} fallback
 * @returns {string[]}
 */
function fallbackLines(fallback) {
  const applied = fallback?.applied === true;
  const requested = fallback?.requested;
  const state = fallback
    ? applied
      ? `applied (requested ${requested ?? 'unknown'})`
      : requested
        ? `not applied (requested ${requested})`
        : 'unknown'
    : 'unknown';
  const lines = [`- Reviewer fallback: ${state}`];
  if (fallback && fallback.chainLength !== null && fallback.chainLength !== undefined) {
    lines.push(`- Reviewer fallback candidates: ${fallback.chainLength}`);
  }
  if (fallback?.error) lines.push(`- Reviewer provider error: ${fallback.error}`);
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
