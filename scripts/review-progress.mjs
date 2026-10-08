#!/usr/bin/env node
// Read-only view of commit reviews. Every review run writes its own record (see
// src/infra/review-run-records.mjs). This script lists runs, follows one, and
// finds the run that reviewed a commit. It never stops, restarts or edits a run.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';
import { resolveRunsDir, runTagFromEnv } from '../src/infra/filesystem-telemetry-adapter.mjs';
import {
  followExitCode,
  formatRunDetail,
  formatRunTable,
  quietThresholdMs,
  readRunRecord,
  readRunRecords,
  recentlyUnreadableRunFiles,
  runRecordExists,
  runsForCommit,
  runsNeedingAttention,
  selectRuns,
  summarizeRun,
  summaryLine,
} from '../src/infra/review-run-records.mjs';

export const EXIT = Object.freeze({ ok: 0, notFound: 1, usage: 2, unfinished: 3 });
const FOLLOW_INTERVAL_MS = 2_000;
const LIST_LIMIT = 30;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const COMMIT_PATTERN = /^[0-9a-f]{4,64}$/i;
const USAGE = [
  'usage: review-progress [--mine | --all] [--json]',
  '       review-progress --run <runId> [--json]',
  '       review-progress --run <runId> --follow',
  '       review-progress --commit <sha>',
  '       review-progress --summary',
].join('\n');

class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {{ mine: boolean, all: boolean, json: boolean, follow: boolean, summary: boolean, runId: string|null, commit: string|null }}
 */
export function parseArgs(argv) {
  const options = { mine: false, all: false, json: false, follow: false, summary: false, runId: null, commit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mine') options.mine = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--follow') options.follow = true;
    else if (arg === '--summary') options.summary = true;
    else if (arg === '--run' || arg === '--commit') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      if (arg === '--run') {
        if (!RUN_ID_PATTERN.test(value)) throw new UsageError(`not a run id: ${value}`);
        options.runId = value;
      } else {
        if (!COMMIT_PATTERN.test(value)) throw new UsageError(`not a commit id: ${value}`);
        options.commit = value;
      }
      index += 1;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.follow && !options.runId) throw new UsageError('--follow needs --run <runId>');
  return options;
}

function gitIn(cwd, args, extra = {}) {
  return spawnSync('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...extra });
}

function gitText(cwd, args) {
  const result = gitIn(cwd, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Hash of the diff a commit introduced, computed the way the runner computes
 * the diff it reviewed (same git command and pins, same excluded paths).
 */
function commitDiffHash(repoRoot, commit, parentSha, excludedPaths) {
  const base = parentSha ?? gitText(repoRoot, ['hash-object', '-t', 'tree', '--stdin']) ?? '';
  const pathspec = excludedPaths.map((file) => `:(exclude,literal)${file}`);
  // Pinned like the runner's staged diff, so a committer's colour or prefix settings cannot change the bytes.
  const result = gitIn(repoRoot, ['diff', base, commit, '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', ...pathspec]);
  if (result.status !== 0) return null;
  return DiffIdentity.fromBuffer(result.stdout, { excludedPaths }).hash;
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string[]} [argv]
 * @param {object} [deps] injected for tests
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    out = console.log,
    err = console.error,
    now = () => Date.now(),
    sleep = sleepFor,
    runsDir = resolveRunsDir(env),
    scriptPath = fileURLToPath(import.meta.url),
  } = deps;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(error instanceof UsageError ? error.message : String(error));
    err(USAGE);
    return EXIT.usage;
  }

  const repoRoot = gitText(cwd, ['rev-parse', '--show-toplevel']);
  const quietMs = quietThresholdMs(env);
  const tag = runTagFromEnv(env);
  const summarize = (record) => summarizeRun(record, { now: now(), quietMs });

  if (options.summary) {
    const records = await readRunRecords(runsDir);
    const line = summaryLine(runsNeedingAttention(records, { repoRoot, tag, now: now(), quietMs }));
    if (line) out(line);
    return EXIT.ok;
  }

  if (options.runId && !options.follow) {
    const record = await readRunRecord(runsDir, options.runId);
    if (!record) {
      // A file that exists but does not parse is not an absent run: the runner may be rewriting it right now.
      if (await runRecordExists(runsDir, options.runId)) {
        err(`run ${options.runId}: record exists but cannot be read (it may be being written)`);
        return EXIT.unfinished;
      }
      err(`no review run ${options.runId} in ${runsDir}`);
      return EXIT.notFound;
    }
    const summary = summarize(record);
    if (options.json) out(JSON.stringify(summary, null, 2));
    else out(formatRunDetail(summary, { followCommand: `node "${scriptPath}" --run ${options.runId} --follow` }));
    return EXIT.ok;
  }

  if (options.follow) return followRun(options.runId, { runsDir, out, sleep, now, quietMs, scriptPath });

  if (options.commit) {
    if (!repoRoot) {
      err('--commit needs a git repository');
      return EXIT.usage;
    }
    const commit = gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`]);
    if (!commit) {
      err(`not a commit in this repository: ${options.commit}`);
      return EXIT.usage;
    }
    const parentSha = gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `${commit}^`]);
    const candidates = selectRuns(await readRunRecords(runsDir), { repoRoot });
    const matches = await runsForCommit(candidates, {
      parentSha,
      diffHashOf: (excludedPaths) => commitDiffHash(repoRoot, commit, parentSha, excludedPaths),
    });
    if (matches.length === 0) {
      // A record that changed just now and cannot be read yet may be this commit's run, so no answer is given until it settles.
      const unreadable = await recentlyUnreadableRunFiles(runsDir, { now: now(), windowMs: quietMs });
      if (options.json) out(JSON.stringify([], null, 2));
      if (unreadable > 0) {
        err(`${unreadable} run record(s) changed just now and cannot be read yet (they may be being written); try again`);
        return EXIT.unfinished;
      }
      if (!options.json) out(`No review run reviewed commit ${commit.slice(0, 12)}. The commit may predate the run records, or its run was pruned.`);
      return EXIT.notFound;
    }
    out(options.json
      ? JSON.stringify(matches.map(summarize), null, 2)
      : matches.map((record) => formatRunDetail(summarize(record))).join('\n\n'));
    return EXIT.ok;
  }

  if (options.mine && !tag) {
    err('This shell has no Claude session tag (OMP_REVIEW_KIT_RUN_TAG). Use the default view or --all.');
    return EXIT.usage;
  }
  if (!options.mine && !options.all && !repoRoot) {
    err('Not inside a git repository. Use --all or --mine.');
    return EXIT.usage;
  }

  const records = await readRunRecords(runsDir);
  const scoped = selectRuns(records, { repoRoot, tag: options.mine ? tag : null, all: options.all });
  const summaries = scoped.map(summarize);
  if (options.json) {
    out(JSON.stringify(summaries, null, 2));
    return EXIT.ok;
  }
  const shown = summaries.slice(0, LIST_LIMIT);
  out(formatRunTable(shown, { withRepo: options.all || options.mine }));
  if (summaries.length > LIST_LIMIT) out(`... ${summaries.length - LIST_LIMIT} older run(s); use --json for all.`);
  return EXIT.ok;
}

async function followRun(runId, { runsDir, out, sleep, now, quietMs, scriptPath }) {
  let previous = null;
  let unreadableSince = null;
  for (;;) {
    const record = await readRunRecord(runsDir, runId);
    if (!record) {
      // The runner rewrites the record in place, so a poll can land on a half-written file. Keep polling while the
      // file exists; one that stays unreadable for a whole quiet period is reported instead of waited on forever.
      if (await runRecordExists(runsDir, runId)) {
        unreadableSince ??= now();
        if (now() - unreadableSince < quietMs) {
          await sleep(FOLLOW_INTERVAL_MS);
          continue;
        }
        out(`run ${runId}: record unreadable for ${Math.round(quietMs / 1000)} s`);
        return EXIT.unfinished;
      }
      out(`run ${runId}: no record (pruned, or never written)`);
      return EXIT.notFound;
    }
    unreadableSince = null;
    const summary = summarizeRun(record, { now: now(), quietMs });
    const line = `${summary.classification} ${summary.state}${summary.stage ? ` stage=${summary.stage}` : ''} (${summary.stagesCompleted ?? 0} stage(s) done)`;
    if (line !== previous) {
      out(`${new Date(now()).toISOString().slice(11, 19)}  ${line}`);
      previous = line;
    }
    const code = followExitCode(summary);
    if (code !== null) {
      out(formatRunDetail(summary, { followCommand: `node "${scriptPath}" --run ${runId} --follow` }));
      return code === 3 ? EXIT.unfinished : code;
    }
    await sleep(FOLLOW_INTERVAL_MS);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
