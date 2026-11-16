// The machine half of a liveness report: the age of the last progress write, whether the runner
// process is ours, and whether a git commit is still waiting. Every probe is injectable, so the
// classification can be tested without a live review, and every probe that cannot answer returns
// null instead of a guess.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat as statFs } from 'node:fs/promises';
import path from 'node:path';

import { classifyLiveness } from '../domain/review-liveness.mjs';
import { TERMINAL_RUN_STATES } from '../domain/review-run-summary.mjs';
import { isRunAlive, runRecordFile } from './review-run-store.mjs';

/**
 * One record, ready to print: the liveness verdict plus the facts it was derived from.
 *
 * @param {object} record
 * @param {{
 *   dir: string,
 *   now?: number,
 *   deadlineMs?: number,
 *   stat?: (file: string) => Promise<{ mtimeMs: number }>,
 *   alive?: (record: object) => boolean,
 *   waiter?: (repoRoot: string|null|undefined) => boolean|null,
 * }} input
 * @returns {Promise<{ runId: string, repo: string|null, state: string|null, verdict: string|null, kind: string, text: string, progressAgeMs: number|null }>}
 */
export async function probeRun(record, {
  dir,
  now = Date.now(),
  deadlineMs = null,
  stat = file => statFile(file),
  alive = entry => isRunAlive(entry),
  waiter = repoRoot => gitCommitWaiting(repoRoot),
}) {
  const running = !TERMINAL_RUN_STATES.includes(record.state);
  // A stat that throws synchronously is the same observation as one that rejects: the age is unknown.
  const age = running
    ? await Promise.resolve().then(() => stat(runRecordFile(dir, record.runId))).then(info => Math.max(0, now - info.mtimeMs), () => null)
    : null;
  // A pid that exists is not proof this review is running: Windows recycles pids, and an old record
  // then points at an unrelated process. A review that wrote no progress for longer than its own
  // stage deadline cannot be the run that pid belongs to.
  // Three answers, not two: alive, gone, and alive-but-unjudgeable. A pid that answers while the
  // record cannot be read or is older than the stage deadline is not proof of a dead process.
  const pidAlive = running ? alive(record) : false;
  const ageTrusted = age !== null && (deadlineMs <= 0 || age <= deadlineMs);
  const runnerAlive = !running ? false : (pidAlive ? (ageTrusted ? true : 'unknown') : false);
  const stage = running ? [...(record.stages ?? [])].reverse().find(entry => entry.status === 'running') ?? null : null;
  // A dead runner is `exited` whatever a commit is doing, and the process table is expensive: it is
  // asked once per live review, never once per abandoned record.
  const commitWaiting = runnerAlive === true ? waiter(record.repoRoot) : null;
  const liveness = classifyLiveness({
    state: record.state,
    verdict: record.verdict ?? null,
    stage,
    startedAt: record.startedAt ?? null,
    durationMs: record.durationMs ?? null,
    progressAgeMs: age,
    runnerAlive,
    commitWaiting,
    reportPath: record.reportPath ?? null,
  }, { now, deadlineMs });
  return {
    runId: record.runId,
    repo: record.repoName ?? record.repoRoot ?? null,
    state: record.state ?? null,
    verdict: record.verdict ?? null,
    kind: liveness.kind,
    text: liveness.text,
    progressAgeMs: liveness.progressAgeMs,
    // Carried so `--status --json` answers the same three-valued question as the text does.
    commitWaiting,
  };
}

/**
 * Whether a `git commit` of this repository is still waiting for the verdict. The index lock is the
 * cheap half of the answer: git holds it for the whole commit, hooks included. No lock but a live
 * `git ... commit` in the process table still means the verdict is wanted; neither means nobody is
 * waiting and the review only costs quota. Null when the machine cannot be asked, which the report
 * says instead of guessing.
 *
 * @param {string|null|undefined} repoRoot
 * @param {{ lockExists?: (repoRoot: string) => boolean, processList?: () => string }} [deps]
 * @returns {boolean|null}
 */
export function gitCommitWaiting(repoRoot, { lockExists = root => indexLockExists(root), processList = processTable } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') return null;
  if (lockExists(repoRoot)) return true;
  let table;
  try {
    table = processList();
  } catch {
    return null;
  }
  const repo = normalisePath(repoRoot);
  // `git commit` runs with the repository as its working directory, so most commit lines name no
  // path at all; they are not evidence about *which* repository waits. Only a line that names our
  // repository proves a waiter, a line that names another one proves nothing, and a pathless line
  // makes the answer unknown instead of a false "nobody is waiting".
  let unattributable = false;
  for (const line of table.split(/\r?\n/)) {
    if (!/git(\.exe)?\b/i.test(line) || !/\bcommit\b/i.test(line)) continue;
    if (mentionsRepo(normalisePath(line), repo)) return true;
    // Uppercase only: `-C <path>` is the directory flag, `-c key=value` is configuration and names
    // no repository, so it must fall through to "unattributable", never to a definite "nobody waits".
    if (/-C\s+\S+/.test(line)) continue;
    unattributable = true;
  }
  return unattributable ? null : false;
}

/** Whether git is holding the index lock a waiting commit owns. A repository without `.git` says no. */
export function indexLockExists(repoRoot, { exists = file => existsSync(file), gitPath = gitLockPath } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') return false;
  const lock = gitPath(repoRoot);
  return lock === null ? false : exists(lock);
}

/**
 * The index lock path of a repository, asked from git itself so a linked worktree (where `.git` is a
 * file) resolves to its own lock. Null when git cannot answer; the caller then reports "unknown".
 */
function gitLockPath(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'index.lock'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return path.resolve(repoRoot, String(out).trim());
  } catch {
    return null;
  }
}

/** One line per process, so `git -C <repo> commit` is visible and nothing else matters. */
function processTable() {
  if (process.platform === 'win32') {
    return execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  }
  return execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

function normalisePath(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

/**
 * Whether a normalised command line names this repository as a whole path. A prefix compare would
 * make `E:/repos/x` match `E:/repos/xy`, and the answer "a commit is waiting" would then be a false
 * positive on an unrelated repository — the exact guess this function exists to avoid.
 *
 * @param {string} line already normalised
 * @param {string} repo already normalised
 */
function mentionsRepo(line, repo) {
  for (let index = line.indexOf(repo); index !== -1; index = line.indexOf(repo, index + 1)) {
    const next = line[index + repo.length];
    if (next === undefined || !/[\w.-]/.test(next)) return true;
  }
  return false;
}

async function statFile(file) {
  const info = await statFs(file);
  return { mtimeMs: info.mtimeMs };
}
