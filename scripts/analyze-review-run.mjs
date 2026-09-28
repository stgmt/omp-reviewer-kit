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
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OMP_LOG_DIR = path.join(homedir(), '.omp', 'logs');
const OMP_LOG_NAME_RE = /^omp\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;
const OMP_TASK_DIR_GLOB_PREFIX = 'omp-task-';

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
    configs: [],
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
      // Recorded when the subagent's task() finishes — this is the stage END,
      // not the launch; invokeToFirstChatMs back-anchors it to the real start.
      info.stages.push({
        id: String(entry.id ?? ''),
        agent: String(entry.agent ?? ''),
        at: entry.timestamp,
        firstChatMs: Number(entry.invokeToFirstChatMs ?? entry.setupToFirstChatMs ?? 0) || undefined,
      });
    } else if (message === 'Configured subagent runtime model fallback chain') {
      // Emitted when the orchestrator's task() call dispatches the subagent —
      // the real stage START.
      info.configs.push({
        role: String(entry.role ?? ''),
        requested: Array.isArray(entry.requested) ? entry.requested.join(' -> ') : String(entry.requested ?? ''),
        at: entry.timestamp,
      });
    } else if (message === 'Session exit recorded') {
      // Session teardown is a deferred cleanup (observed lag ≈ 420s after the
      // task finishes) — NOT stage duration; never pair exits with stages.
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
      case 'run_abandoned':
        summary.finishedAt = event.at;
        summary.error = event.error ?? 'abandoned (stale run swept by next run_started)';
        summary.abandoned = true;
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
    // Pair dispatch ('Configured subagent …') → finish ('subagent launch timing').
    const cfg = info.configs.findLast?.((c) => c.role.endsWith(`:${stage.id}`))
      ?? info.configs.find((c) => c.role.endsWith(`:${stage.id}`));
    const startMs = isoMs(cfg?.at) ?? isoMs(stage.at);
    const endMs = isoMs(stage.at);
    const dur = endMs !== undefined && startMs !== undefined ? endMs - startMs : undefined;
    const startLabel = cfg ? fmtTime(cfg.at) : `${fmtTime(stage.at)}(finish)`;
    console.log(`    stage ${stage.id || stage.agent}: ${startLabel} → ${fmtTime(stage.at)} (${fmtDuration(dur)})${cfg?.requested ? `  model ${cfg.requested}` : ''}`);
  }
  if (info.providerErrors > 0) {
    const classes = [...info.errorClasses.entries()].map(([c, n]) => `${c}×${n}`).join(', ');
    console.log(`    provider errors: ${info.providerErrors} [${classes}] first ${fmtTime(new Date(info.firstProviderErrorAt).toISOString())}`);
  }
}

/**
 * Reads the parent task transcript and its per-subagent transcripts from
 * %TEMP%/omp-task-*. The log only records request counts for providers that
 * emit "sending chat request"; transcripts carry the true per-agent model,
 * thinking level and message span.
 *
 * @param {number|undefined} startMs attempt start
 * @param {number|undefined} endMs attempt end (undefined → +Infinity)
 * @param {string|undefined} repoPath expected transcript cwd substring
 * @param {string|undefined} matchText literal that must appear in the parent
 *   transcript (diff hash) to disambiguate overlapping runs
 * @returns {Promise<{agentStats: Array<object>, matchedDir?: string}>}
 */
async function analyzeTaskTranscripts(startMs, endMs, repoPath, matchText) {
  const empty = { agentStats: [] };
  if (startMs === undefined) return empty;
  const taskRoot = path.join(tmpdir());
  const windowEnd = endMs ?? Number.MAX_SAFE_INTEGER;
  let dirs;
  try {
    dirs = (await readdir(taskRoot)).filter((n) => n.startsWith(OMP_TASK_DIR_GLOB_PREFIX));
  } catch {
    return empty;
  }
  for (const dir of dirs) {
    const dirPath = path.join(taskRoot, dir);
    let topFiles;
    try {
      topFiles = (await readdir(dirPath)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const top of topFiles) {
      const topPath = path.join(dirPath, top);
      let raw;
      try {
        raw = await readFile(topPath, 'utf8');
      } catch {
        continue;
      }
      let sessionTs, cwd;
      for (const line of raw.split(/\r?\n/, 4)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session') {
            sessionTs = entry.timestamp;
            cwd = String(entry.cwd ?? '');
            break;
          }
        } catch { /* skip */ }
      }
      const ts = isoMs(sessionTs);
      if (ts === undefined || ts < startMs - 60_000 || ts > windowEnd + 60_000) continue;
      if (repoPath && cwd && !cwd.startsWith(repoPath.replace(/\//g, path.sep))) continue;
      if (matchText && !raw.slice(0, 300_000).includes(matchText)) continue;
      const subDir = path.join(dirPath, path.basename(top, '.jsonl'));
      let subFiles = [];
      try {
        subFiles = (await readdir(subDir)).filter((n) => n.endsWith('.jsonl'));
      } catch { /* no subagent dir */ }
      const stats = [];
      const files = [{ file: topPath, name: path.basename(top, '.jsonl') }]
        .concat(subFiles.map((n) => ({ file: path.join(subDir, n), name: path.basename(n, '.jsonl') })));
      for (const { file, name } of files) {
        try {
          const content = file === topPath ? raw : await readFile(file, 'utf8');
          let model, thinking, firstMsg, lastMsg, messages = 0;
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'model_change') model = entry.model;
              else if (entry.type === 'thinking_level_change') thinking = entry.thinkingLevel;
              else if (entry.type === 'message') {
                messages += 1;
                if (!firstMsg) firstMsg = entry.timestamp;
                lastMsg = entry.timestamp;
              }
            } catch { /* skip */ }
          }
          const dur = isoMs(lastMsg) !== undefined && isoMs(firstMsg) !== undefined
            ? isoMs(lastMsg) - isoMs(firstMsg) : undefined;
          stats.push({ name, model, thinking, messages, firstAt: firstMsg, lastAt: lastMsg, durationMs: dur });
        } catch { /* skip */ }
      }
      stats.sort((a, b) => (isoMs(a.firstAt) ?? 0) - (isoMs(b.firstAt) ?? 0));
      return { agentStats: stats, matchedDir: dirPath };
    }
  }
  return empty;
}

function printTranscriptInfo(transcripts) {
  if (!transcripts || transcripts.agentStats.length === 0) return;
  console.log(`    transcripts: ${path.basename(transcripts.matchedDir ?? '')}`);
  for (const a of transcripts.agentStats) {
    console.log(`      ${a.name}: ${a.model ?? '?'}${a.thinking ? `:${a.thinking}` : ''}  msgs ${a.messages}  ${fmtTime(a.firstAt)} → ${fmtTime(a.lastAt)} (${fmtDuration(a.durationMs)})`);
  }
}

/**
 * Collects every omp-task-* parent session inside the union of the attempt
 * windows and assigns each one to the attempt whose window encloses it.
 *
 * @param {Array<{startMs?: number, endMs?: number}>} windows attempt windows
 * @param {string|undefined} repoPath expected transcript cwd substring
 * @param {string|undefined} matchText literal required in the parent transcript
 * @returns {Promise<Map<number, {agentStats: Array<object>, matchedDir: string}>>}
 */
async function collectTranscripts(windows, repoPath, matchText) {
  const out = new Map();
  const valid = windows
    .map((w, i) => ({ ...w, i }))
    .filter((w) => w.startMs !== undefined);
  if (valid.length === 0) return out;
  const lo = Math.min(...valid.map((w) => w.startMs)) - 60_000;
  const hi = Math.max(...valid.map((w) => w.endMs ?? Number.MAX_SAFE_INTEGER)) + 60_000;
  const taskRoot = path.join(tmpdir());
  let dirs;
  try {
    dirs = (await readdir(taskRoot)).filter((n) => n.startsWith(OMP_TASK_DIR_GLOB_PREFIX));
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const dirPath = path.join(taskRoot, dir);
    let topFiles;
    try {
      topFiles = (await readdir(dirPath)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const top of topFiles) {
      const topPath = path.join(dirPath, top);
      let raw;
      try {
        raw = await readFile(topPath, 'utf8');
      } catch {
        continue;
      }
      let sessionTs, cwd;
      for (const line of raw.split(/\r?\n/, 4)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session') {
            sessionTs = entry.timestamp;
            cwd = String(entry.cwd ?? '');
            break;
          }
        } catch { /* skip */ }
      }
      const ts = isoMs(sessionTs);
      if (ts === undefined || ts < lo || ts > hi) continue;
      if (repoPath && cwd && !cwd.startsWith(repoPath.replace(/\//g, path.sep))) continue;
      if (matchText && !raw.slice(0, 300_000).includes(matchText)) continue;
      const owner = valid.find((w) => ts >= w.startMs && ts <= (w.endMs ?? Number.MAX_SAFE_INTEGER) + 60_000);
      if (!owner || out.has(owner.i)) continue;
      const parsed = await parseTranscriptDir(dirPath, topPath, raw);
      if (parsed) out.set(owner.i, parsed);
    }
  }
  return out;
}

async function parseTranscriptDir(dirPath, topPath, raw) {
  const top = path.basename(topPath);
  const subDir = path.join(dirPath, path.basename(top, '.jsonl'));
  let subFiles = [];
  try {
    subFiles = (await readdir(subDir)).filter((n) => n.endsWith('.jsonl'));
  } catch { /* no subagent dir */ }
  const stats = [];
  const files = [{ file: topPath, name: path.basename(top, '.jsonl') }]
    .concat(subFiles.map((n) => ({ file: path.join(subDir, n), name: path.basename(n, '.jsonl') })));
  for (const { file, name } of files) {
    try {
      const content = file === topPath ? raw : await readFile(file, 'utf8');
      let model, thinking, firstMsg, lastMsg, messages = 0;
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'model_change') model = entry.model;
          else if (entry.type === 'thinking_level_change') thinking = entry.thinkingLevel;
          else if (entry.type === 'message') {
            messages += 1;
            if (!firstMsg) firstMsg = entry.timestamp;
            lastMsg = entry.timestamp;
          }
        } catch { /* skip */ }
      }
      const dur = isoMs(lastMsg) !== undefined && isoMs(firstMsg) !== undefined
        ? isoMs(lastMsg) - isoMs(firstMsg) : undefined;
      stats.push({ name, model, thinking, messages, firstAt: firstMsg, lastAt: lastMsg, durationMs: dur });
    } catch { /* skip */ }
  }
  stats.sort((a, b) => (isoMs(a.firstAt) ?? 0) - (isoMs(b.firstAt) ?? 0));
  return { agentStats: stats, matchedDir: dirPath };
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
      console.log(`${runId}  ${s.verdict ?? (s.abandoned ? 'ABANDONED' : s.skipped ? 'SKIPPED' : s.error ? 'FAILED' : 'running/incomplete')}  ${fmtDuration(s.durationMs)}  models ${(s.modelsTried ?? []).join('->') || '-'}`);
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
  const attemptWindows = result.attempts.map((attempt) => {
    const start = isoMs(attempt.startedAt);
    const end = start !== undefined && Number.isFinite(attempt.durationMs)
      ? start + attempt.durationMs
      : (isoMs(attempt.finishedAt) ?? undefined);
    return { startMs: start, endMs: end };
  });
  const transcriptMap = await collectTranscripts(attemptWindows, repoRoot, summary.diffHash);
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
    attempt.transcripts = transcriptMap.get(result.attempts.indexOf(attempt));
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
    printTranscriptInfo(attempt.transcripts);
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
