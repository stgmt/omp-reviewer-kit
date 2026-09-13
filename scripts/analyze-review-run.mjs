#!/usr/bin/env node
/**
 * Review-run analyzer: correlates telemetry from
 * audit-reports/commit-reviews/runs.jsonl (or last-run.json) with OMP process
 * logs in ~/.omp/logs/omp.<date>.<pid>.log and prints a compact trace:
 * duration, models, per-attempt/per-probe timings, request counts, stage
 * (subagent) timing, and provider-error classification.
 *
 * Usage:
 *   node scripts/analyze-review-run.mjs              # latest run in this repo
 *   node scripts/analyze-review-run.mjs <runId>      # specific runId
 *   node scripts/analyze-review-run.mjs --run last --repo <path>   # explicit repo
 *   node scripts/analyze-review-run.mjs --log <omp.log>  # raw OMP log, no telemetry
 *   node scripts/analyze-review-run.mjs --all        # one line per run
 *   node scripts/analyze-review-run.mjs --json       # machine-readable output
 *
 * Security: prints only metadata (counts, timings, model names, status
 * classes). Raw log lines, prompts, and request payloads are never copied.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OMP_LOG_DIR = path.join(homedir(), '.omp', 'logs');
const OMP_LOG_NAME_RE = /^omp\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;
const PROVIDER_ERROR_RE = /\b(401|403|429)\b|quota|rate.?limit|RESOURCE_EXHAUSTED|insufficient|no endpoints found/i;

function isoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : undefined;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTime(iso) {
  return typeof iso === 'string' && iso.length >= 19 ? iso.slice(11, 19) : '-';
}

function repoRootFromGit(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return cwd;
  }
}

async function readJsonl(filePath) {
  const events = [];
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return events;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Partial line from a concurrent write — skip it.
    }
  }
  return events;
}

/**
 * Parses an OMP process log (JSONL) into metadata only.
 */
async function analyzeOmpLog(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const info = {
    file: filePath,
    pid: Number(OMP_LOG_NAME_RE.exec(path.basename(filePath))?.[2]) || undefined,
    firstAt: undefined,
    lastAt: undefined,
    requests: 0,
    models: new Map(),
    maxRequestBytes: 0,
    lastRequestBytes: 0,
    stages: [],
    exits: new Map(),
    providerErrors: 0,
    firstProviderErrorAt: undefined,
    lastProviderErrorAt: undefined,
    errorClasses: new Map(),
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const at = isoMs(entry.timestamp);
    if (at !== undefined) {
      if (info.firstAt === undefined) info.firstAt = at;
      info.lastAt = at;
    }
    const message = String(entry.message ?? '');

    if (message.endsWith('sending chat request')) {
      info.requests += 1;
      const model = String(entry.model ?? 'unknown');
      info.models.set(model, (info.models.get(model) ?? 0) + 1);
      const bytes = Number(entry.requestBytes ?? 0);
      if (bytes > info.maxRequestBytes) info.maxRequestBytes = bytes;
      if (bytes > 0) info.lastRequestBytes = bytes;
    } else if (message === 'subagent launch timing') {
      info.stages.push({
        id: String(entry.id ?? ''),
        agent: String(entry.agent ?? ''),
        at: entry.timestamp,
        firstChatMs: Number(entry.invokeToFirstChatMs ?? entry.setupToFirstChatMs ?? 0) || undefined,
      });
    } else if (message === 'Session exit recorded') {
      const file = String(entry.sessionFile ?? '');
      const id = path.basename(file, '.jsonl');
      if (id) info.exits.set(id, entry.timestamp);
    }

    const haystack = `${entry.level ?? ''} ${message} ${entry.error ?? ''} ${entry.reason ?? ''}`;
    if (PROVIDER_ERROR_RE.test(haystack)) {
      info.providerErrors += 1;
      if (info.firstProviderErrorAt === undefined) info.firstProviderErrorAt = at;
      info.lastProviderErrorAt = at;
      const cls = /\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(haystack)
        ? 'quota/rate-limit'
        : /\b401\b/.test(haystack)
          ? 'auth(401)'
          : /\b403\b/.test(haystack)
            ? 'forbidden(403)'
            : 'other';
      info.errorClasses.set(cls, (info.errorClasses.get(cls) ?? 0) + 1);
    }
  }
  return info;
}

async function findOmpLogByPid(pid) {
  if (!Number.isInteger(pid)) return undefined;
  let names;
  try {
    names = await readdir(OMP_LOG_DIR);
  } catch {
    return undefined;
  }
  const match = names.find((name) => OMP_LOG_NAME_RE.exec(name)?.[2] === String(pid));
  return match ? path.join(OMP_LOG_DIR, match) : undefined;
}

/**
 * Fallback for wrapper spawns (OMP_REVIEW_KIT_OMP=*.cmd): the recorded pid is
 * cmd.exe, not omp.exe. Correlate by time window — pick the log whose first
 * timestamp falls inside the attempt window.
 */
async function findOmpLogByWindow(startMs, endMs) {
  let names;
  try {
    names = await readdir(OMP_LOG_DIR);
  } catch {
    return undefined;
  }
  const windowStart = startMs - 120_000;
  const windowEnd = (endMs ?? startMs) + 120_000;
  const candidates = [];
  for (const name of names) {
    if (!OMP_LOG_NAME_RE.test(name)) continue;
    const filePath = path.join(OMP_LOG_DIR, name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < windowStart || fileStat.birthtimeMs > windowEnd) continue;
      const head = await readFile(filePath, 'utf8');
      const firstLine = head.split(/\r?\n/, 1)[0];
      const firstAt = isoMs(JSON.parse(firstLine).timestamp);
      if (firstAt !== undefined && firstAt >= windowStart && firstAt <= windowEnd) {
        candidates.push({ filePath, firstAt });
      }
    } catch {
      // Unreadable file — skip.
    }
  }
  candidates.sort((a, b) => a.firstAt - b.firstAt);
  return candidates[0]?.filePath;
}

function groupEventsByRun(events) {
  const runs = new Map();
  for (const event of events) {
    const runId = event.runId;
    if (!runId) continue;
    if (!runs.has(runId)) runs.set(runId, []);
    runs.get(runId).push(event);
  }
  return runs;
}

function summarizeRun(runId, events) {
  const summary = {
    runId,
    startedAt: undefined,
    finishedAt: undefined,
    verdict: undefined,
    exitCode: undefined,
    durationMs: undefined,
    reportPath: undefined,
    diffHash: undefined,
    diffBytes: undefined,
    modelsTried: undefined,
    ompLogHints: [],
    attempts: new Map(),
    probes: [],
    skipped: false,
    error: undefined,
  };
  for (const event of events) {
    switch (event.type) {
      case 'run_started':
        summary.startedAt = event.at;
        break;
      case 'run_skipped':
        summary.skipped = true;
        summary.finishedAt = event.at;
        break;
      case 'diff_collected':
        summary.diffHash = event.diffHash;
        summary.diffBytes = event.diffBytes;
        break;
      case 'probe_started':
        summary.probes.push({ model: event.model, startedAt: event.at });
        break;
      case 'probe_finished': {
        const probe = summary.probes.findLast?.((p) => p.model === event.model && p.status === undefined)
          ?? summary.probes[summary.probes.length - 1];
        if (probe) Object.assign(probe, event);
        else summary.probes.push(event);
        break;
      }
      case 'review_attempt_started':
        summary.attempts.set(event.attemptIndex ?? summary.attempts.size, {
          model: event.model, pid: event.pid, startedAt: event.at, attemptIndex: event.attemptIndex,
        });
        break;
      case 'review_attempt_finished': {
        const key = event.attemptIndex ?? summary.attempts.size - 1;
        const attempt = summary.attempts.get(key) ?? {};
        summary.attempts.set(key, { ...attempt, ...event, finishedAt: event.at });
        break;
      }
      case 'report_written':
        summary.reportPath = event.reportPath;
        break;
      case 'verdict_evaluated':
        summary.verdict = event.verdict;
        break;
      case 'run_finished':
        summary.finishedAt = event.at;
        summary.verdict = event.verdict ?? summary.verdict;
        summary.exitCode = event.exitCode;
        summary.durationMs = event.durationMs;
        summary.modelsTried = event.modelsTried;
        summary.ompLogHints = Array.isArray(event.ompLogHints) ? event.ompLogHints : [];
        break;
      case 'run_failed':
        summary.finishedAt = event.at;
        summary.error = event.error;
        break;
      default:
        break;
    }
  }
  if (summary.durationMs === undefined) {
    const start = isoMs(summary.startedAt);
    const end = isoMs(summary.finishedAt);
    if (start !== undefined && end !== undefined) summary.durationMs = end - start;
  }
  return summary;
}

function printLogInfo(info) {
  if (!info) {
    console.log('    log: (no matching OMP log found)');
    return;
  }
  const span = info.lastAt - info.firstAt;
  const models = [...info.models.entries()].map(([m, n]) => `${m}×${n}`).join(', ');
  console.log(`    log: ${path.basename(info.file)}  span ${fmtDuration(span)}  requests ${info.requests}${models ? `  [${models}]` : ''}`);
  if (info.maxRequestBytes > 0) {
    console.log(`    context growth: max request ${Math.round(info.maxRequestBytes / 1024)}KB, last ${Math.round(info.lastRequestBytes / 1024)}KB`);
  }
  for (const stage of info.stages) {
    const exit = info.exits.get(stage.id);
    const endMs = isoMs(exit);
    const startMs = isoMs(stage.at);
    const dur = startMs !== undefined && endMs !== undefined ? endMs - startMs : undefined;
    console.log(`    stage ${stage.id || stage.agent}: launched ${fmtTime(stage.at)} → exit ${fmtTime(exit)} (${fmtDuration(dur)})`);
  }
  if (info.providerErrors > 0) {
    const classes = [...info.errorClasses.entries()].map(([c, n]) => `${c}×${n}`).join(', ');
    console.log(`    provider errors: ${info.providerErrors} [${classes}] first ${fmtTime(new Date(info.firstProviderErrorAt).toISOString())}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const allMode = args.includes('--all');
  const logIndex = args.indexOf('--log');
  const directLog = logIndex >= 0 ? args[logIndex + 1] : undefined;
  const runIdx = args.indexOf('--run');
  const repoIdx = args.indexOf('--repo');
  const flagValues = new Set(
    [directLog, runIdx >= 0 ? args[runIdx + 1] : undefined, repoIdx >= 0 ? args[repoIdx + 1] : undefined]
      .filter(Boolean),
  );
  const positional = args.find((a) => !a.startsWith('-') && !flagValues.has(a));
  let runIdArg = runIdx >= 0 ? args[runIdx + 1] : positional;
  const repoArg = repoIdx >= 0 ? args[repoIdx + 1] : undefined;

  if (directLog) {
    const info = await analyzeOmpLog(path.resolve(directLog));
    if (jsonMode) {
      console.log(JSON.stringify({
        ...info,
        models: Object.fromEntries(info.models),
        exits: Object.fromEntries(info.exits),
        errorClasses: Object.fromEntries(info.errorClasses),
      }, null, 2));
      return;
    }
    console.log(`OMP log ${info.file}`);
    printLogInfo(info);
    return;
  }

  const repoRoot = repoArg ? path.resolve(repoArg) : repoRootFromGit(process.cwd());
  const reportsDir = path.join(repoRoot, 'audit-reports', 'commit-reviews');
  const events = await readJsonl(path.join(reportsDir, 'runs.jsonl'));
  const runs = groupEventsByRun(events);

  if (runs.size === 0) {
    console.log(`No review runs found in ${path.join(reportsDir, 'runs.jsonl')}`);
    return;
  }

  if (allMode) {
    for (const [runId, runEvents] of runs) {
      const s = summarizeRun(runId, runEvents);
      console.log(`${runId}  ${s.verdict ?? (s.skipped ? 'SKIPPED' : s.error ? 'FAILED' : 'running/incomplete')}  ${fmtDuration(s.durationMs)}  models ${(s.modelsTried ?? []).join('->') || '-'}`);
    }
    return;
  }

  const runIds = [...runs.keys()];
  if (runIdArg === 'last') runIdArg = runIds[runIds.length - 1];
  const targetId = runIdArg ?? runIds[runIds.length - 1];
  if (!runs.has(targetId)) {
    console.log(`Run "${targetId}" not found. Known runs:\n${runIds.map((id) => `  ${id}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }

  const summary = summarizeRun(targetId, runs.get(targetId));
  const result = {
    ...summary,
    attempts: [...summary.attempts.values()],
    probes: summary.probes,
  };

  for (const attempt of result.attempts) {
    let logFile = await findOmpLogByPid(attempt.pid);
    let correlation = 'pid';
    if (!logFile) {
      const start = isoMs(attempt.startedAt);
      const end = start !== undefined && Number.isFinite(attempt.durationMs) ? start + attempt.durationMs : undefined;
      if (start !== undefined) {
        logFile = await findOmpLogByWindow(start, end);
        correlation = 'time-window';
      }
    }
    attempt.ompLog = logFile;
    attempt.ompLogCorrelation = logFile ? correlation : undefined;
    if (logFile) attempt.log = await analyzeOmpLog(logFile);
  }
  for (const probe of result.probes) {
    const logFile = await findOmpLogByPid(probe.pid);
    probe.ompLog = logFile;
    if (logFile) probe.log = await analyzeOmpLog(logFile);
  }

  if (jsonMode) {
    const replacer = (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value);
    console.log(JSON.stringify(result, replacer, 2));
    return;
  }

  console.log(`run ${summary.runId}`);
  console.log(`  verdict: ${summary.verdict ?? (summary.skipped ? 'SKIPPED' : '-')}  duration: ${fmtDuration(summary.durationMs)}  exitCode: ${summary.exitCode ?? '-'}`);
  if (summary.diffHash) console.log(`  diff: ${summary.diffHash.slice(0, 12)}… (${summary.diffBytes ?? '?'} bytes)`);
  if (summary.modelsTried) console.log(`  models tried: ${summary.modelsTried.join(' -> ')}`);
  if (summary.reportPath) console.log(`  report: ${summary.reportPath}`);
  if (summary.error) console.log(`  error: ${summary.error}`);

  for (const attempt of result.attempts) {
    console.log(`  attempt #${attempt.attemptIndex ?? '?'} model ${attempt.model}  pid ${attempt.pid ?? '-'}  ${fmtDuration(attempt.durationMs)}  status ${attempt.status ?? '-'}${attempt.providerFailure ? '  PROVIDER-FAILURE' : ''}`);
    printLogInfo(attempt.log);
    if (attempt.ompLog && attempt.ompLogCorrelation === 'time-window') {
      console.log('    (correlated by time window — pid belongs to a wrapper process)');
    }
  }
  for (const probe of result.probes) {
    console.log(`  probe model ${probe.model}  pid ${probe.pid ?? '-'}  ${fmtDuration(probe.durationMs)}  status ${probe.status ?? '-'}`);
  }
  if (result.attempts.length === 0 && summary.ompLogHints.length > 0) {
    console.log(`  omp log hints: ${summary.ompLogHints.join(', ')}`);
  }
}

await main();
