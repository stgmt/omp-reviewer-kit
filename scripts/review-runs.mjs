#!/usr/bin/env node
// Read-only view of the review run records. Usage:
//   node scripts/review-runs.mjs                 the last 10 runs of this machine
//   node scripts/review-runs.mjs --all           every kept run
//   node scripts/review-runs.mjs --repo <path>   runs of one repository
//   node scripts/review-runs.mjs --run <runId>   one record, in full
//   node scripts/review-runs.mjs --json          the same data as machine-readable JSON
//   node scripts/review-runs.mjs --follow <id>   watch a running review until it settles
// Exit 0 when something was found, 1 when nothing matched, 2 on a usage error. This command never
// writes, never stops a review and never changes a verdict.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TERMINAL_RUN_STATES, formatDuration, stageSummaryLine } from '../src/domain/review-run-summary.mjs';
import { isRunAlive, latestRunRecord, readRunRecord, readRunRecords, runRecordFile, runsRootDir } from '../src/infra/review-run-store.mjs';

const DEFAULT_LIMIT = 10;
const FOLLOW_INTERVAL_MS = 500;

/**
 * `--flag value` and `--flag=value` in one small parser: the CLI takes no positionals.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { mode: 'list', limit: DEFAULT_LIMIT, json: false, repo: null, runId: null, timeoutMs: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      index += 1;
      const next = argv[index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case '--all':
        options.mode = 'all';
        break;
      case '--last':
        options.mode = 'last';
        break;
      case '--json':
        options.json = true;
        break;
      case '--repo':
        options.repo = path.resolve(take());
        break;
      case '--run':
        options.runId = take();
        break;
      case '--follow':
        options.mode = 'follow';
        options.runId = take();
        break;
      case '--timeout': {
        const seconds = Number(take());
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout needs a positive number of seconds');
        options.timeoutMs = seconds * 1000;
        break;
      }
      case '--help':
      case '-h':
        options.mode = 'help';
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

/** One table row per record. */
export function formatRunLine(record) {
  const label = record.verdict ?? String(record.state ?? 'unknown').toUpperCase();
  const state = String(label).padEnd(8);
  const duration = formatDuration(record.durationMs);
  const repo = record.repoName ?? 'unknown';
  const stages = stageSummaryLine(record.stages);
  return `${record.runId}  ${state} ${duration}  ${repo}${stages.length > 0 ? `  ${stages}` : ''}`;
}

export const HELP = `Usage: node scripts/review-runs.mjs [--last] [--all] [--repo <path>] [--run <runId>] [--json] [--follow <runId>] [--timeout <seconds>]

Records live in <home>/.omp/review-kit-runs, or OMP_REVIEW_KIT_RUNS_DIR when set.`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Prints each stage transition of one run until it settles. Read-only: the follow never touches the
 * file, never signals a process, and gives up when its optional timeout expires.
 *
 * @param {{ dir: string, runId: string, out: (line: string) => void, timeoutMs?: number|null, intervalMs?: number, now?: () => number }} input
 * @returns {Promise<boolean>} whether the run settled
 */
export async function followRun({ dir, runId, out, timeoutMs = null, intervalMs = FOLLOW_INTERVAL_MS, now = () => Date.now() }) {
  const started = now();
  const seen = new Map();
  let announced = false;
  for (;;) {
    const record = await readRunRecord(runRecordFile(dir, runId));
    if (!record) {
      if (!announced) out(`run ${runId} not found in ${dir}`);
      return false;
    }
    announced = true;
    for (const stage of record.stages) {
      const key = `${stage.agent}|${stage.lane ?? ''}`;
      const signature = `${stage.status}|${stage.durationMs ?? ''}|${stage.tokens ?? ''}`;
      if (seen.get(key) === signature) continue;
      seen.set(key, signature);
      out(`stage ${stage.agent}${stage.lane ? ` lane=${stage.lane}` : ''} ${stage.status ?? 'running'} ${formatDuration(stage.durationMs)}`);
    }
    if (TERMINAL_RUN_STATES.includes(record.state)) {
      out(formatRunLine(record));
      return true;
    }
    if (!isRunAlive(record)) {
      out(`run ${runId} is no longer running and did not settle (interrupted)`);
      out(formatRunLine(record));
      return false;
    }
    if (timeoutMs !== null && now() - started > timeoutMs) {
      out(`run ${runId} still running after ${formatDuration(now() - started)}; stopped watching`);
      return false;
    }
    await sleep(intervalMs);
  }
}

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, env?: NodeJS.ProcessEnv }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`), env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(HELP);
    return 2;
  }
  if (options.mode === 'help') {
    out(HELP);
    return 0;
  }
  const dir = runsRootDir({ env });

  if (options.mode === 'follow') {
    const settled = await followRun({ dir, runId: options.runId, out, timeoutMs: options.timeoutMs });
    return settled ? 0 : 1;
  }

  if (options.runId) {
    const record = await readRunRecord(runRecordFile(dir, options.runId));
    if (!record) {
      err(`no run ${options.runId} in ${dir}`);
      return 1;
    }
    out(options.json ? JSON.stringify(record, null, 2) : formatRunDetail(record));
    return 0;
  }

  const limit = options.mode === 'all' ? undefined : options.limit;
  const records = await readRunRecords({ dir, limit, repoRoot: options.repo ?? undefined });
  if (records.length === 0) {
    if (options.json) out('[]');
    else err(`no run records in ${dir}`);
    return 1;
  }
  if (options.json) {
    out(JSON.stringify(records, null, 2));
    return 0;
  }
  const latest = options.mode === 'last' ? await latestRunRecord({ dir, repoRoot: options.repo ?? undefined }) : null;
  const shown = latest ? [latest] : records;
  for (const record of shown) out(formatRunLine(record));
  return 0;
}

/** One record as a short block: identity, timings, then a row per stage. */
export function formatRunDetail(record) {
  const lines = [
    `Run: ${record.runId}`,
    `State: ${record.state}${record.verdict ? ` (${record.verdict})` : ''}`,
    `Repository: ${record.repoRoot ?? 'unknown'}`,
    `Started: ${record.startedAt ?? 'unknown'}; duration: ${formatDuration(record.durationMs)}`,
  ];
  const lanes = Array.isArray(record.lanes) ? record.lanes : [];
  const stages = Array.isArray(record.stages) ? record.stages : [];
  const reasons = Array.isArray(record.reasons) ? record.reasons : [];
  if (record.profile) lines.push(`Profile: ${record.profile}; lanes: ${lanes.join(', ') || 'none'}`);
  if (record.reportPath) lines.push(`Report: ${record.reportPath}`);
  if (stages.length > 0) {
    lines.push('', 'Stage | Status | Duration | Tokens | Requests | Counts', '--- | --- | --- | --- | --- | ---');
    for (const stage of stages) {
      const counts = Object.entries(stage.counts ?? {}).map(([key, value]) => `${key} ${value}`).join(', ');
      lines.push(`${stage.agent ?? 'stage'} | ${stage.status ?? 'unknown'} | ${formatDuration(stage.durationMs)} | ${stage.tokens ?? 'unknown'} | ${stage.requests ?? 'unknown'} | ${counts || '-'}`);
    }
  }
  if (reasons.length > 0) {
    lines.push('', 'Reasons:', ...reasons.map(reason => `- ${reason}`));
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
