import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewerPort } from '../application/ports.mjs';
import { ReviewVerdict } from '../domain/review-verdict.mjs';
import { NULL_RUN_TELEMETRY, formatProviderOutageError, safeRunTelemetry } from './filesystem-telemetry-adapter.mjs';
import { parseScoutBaseline } from '../domain/scout-baseline.mjs';
import { readStageResult, summarizeStageTranscripts } from './stage-transcript-stats.mjs';

/**
 * Reads only the last `maxTailBytes` of a (possibly multi-MB) log file via a
 * positioned read — the stage/quota pollers run every ~10s for the whole
 * review, so a whole-file readFile+slice per tick was O(log size) memory and
 * I/O per poll. A mid-UTF-8 start byte yields a truncated first line that
 * never parses — same semantics as the old string slice.
 *
 * @param {string} filePath
 * @param {number} maxTailBytes
 * @returns {Promise<string>}
 */
async function readLogTail(filePath, maxTailBytes) {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxTailBytes);
    const length = size - start;
    if (length <= 0) return '';
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

// Provider-proxy env vars that MUST reach every spawned `omp` child. On the
// primary dev box google-antigravity OAuth refresh dies with a TLS cert error
// when the request leaves the box without 127.0.0.1:3128, and children spawned
// from a stale parent (started before the user-scope vars existed) inherit
// nothing — reviewers die with "Use /login". Merge the user registry's
// PI_PROXY_* into the child env when the inherited env lacks them; never
// overwrite values the parent did set (scoped-off runs keep full control).
const REGISTRY_PROXY_VARS = /^PI_(?:PROXY|CA_BUNDLE)_/;
const REG_SZ_ROW_RE = /^\s+(\S+)\s+REG_SZ\s+(.+)$/;

export function mergeRegistryProxyEnv(env = process.env, registryOut = readUserEnvironmentBlock()) {
  const merged = { ...env };
  const parentKeys = Object.keys(merged);
  for (const line of String(registryOut ?? '').split(/\r?\n/)) {
    const row = line.match(REG_SZ_ROW_RE);
    if (!row) continue;
    const [, name, value] = row;
    if (!REGISTRY_PROXY_VARS.test(name)) continue;
    if (merged[name] !== undefined) continue;
    // Windows env lookup is case-insensitive but Node preserves the
    // inherited spelling in enumeration: a parent-set `pi_proxy_meta`
    // must still suppress the registry PI_PROXY_META row, else both
    // spellings reach the child env block with unpredictable resolution.
    if (process.platform === 'win32'
      && parentKeys.some((k) => k.toUpperCase() === name.toUpperCase())) continue;
    merged[name] = value.trim();
  }
  return merged;
}

function readUserEnvironmentBlock() {
  if (process.platform !== 'win32') return '';
  try {
    const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}

export const REVIEW_PROGRESS_PREFIX = 'reviewer-kit progress: ';

const REVIEW_PROGRESS_RE = /^reviewer-kit progress: \[([a-z-]+)\] (.+)$/;

/**
 * Formats one human-readable, machine-detectable progress line for the Git hook.
 * The line is written to stderr so Git and OMP can display it while the hook runs.
 *
 * @param {{ state: string, message: string, model?: string, elapsedMs?: number }} event
 * @returns {string}
 */
export function formatReviewProgress({ state, message, model, elapsedMs }) {
  const details = [message];
  if (model) details.push('model ' + model);
  if (Number.isFinite(elapsedMs)) details.push('elapsed ' + Math.floor(elapsedMs / 1000) + 's');
  return REVIEW_PROGRESS_PREFIX + '[' + state + '] ' + details.join(' | ');
}

/**
 * Extracts the last progress line from streamed OMP/Git output.
 *
 * @param {unknown} value
 * @returns {{ state: string, text: string }|undefined}
 */
export function parseReviewProgress(value) {
  const lines = String(value ?? '').split(/\r?\n/);
  let parsed;
  for (const line of lines) {
    const match = line.match(REVIEW_PROGRESS_RE);
    if (match) parsed = { state: match[1], text: match[2] };
  }
  return parsed;
}

export function writeReviewProgress(event) {
  process.stderr.write(formatReviewProgress(event) + '\n');
}

// OMP reports an MCP server that failed to start on stderr, possibly after the verdict; it is not reviewer output.
const OMP_MCP_WARNING_RE = /^\s*Warning: MCP server "[^"]*" failed to connect\b/;

/**
 * Sanitizes stderr from reviewer execution:
 * (a) removes every line matching /^\s*Working\.\.\.\s*$/i (OMP print-mode progress noise),
 * (b) removes every line matching OMP_MCP_WARNING_RE (MCP connection warning, which can follow the verdict),
 * (c) normalizes CRLF to LF.
 *
 * @param {string} stderr
 * @returns {string}
 */
export function sanitizeReviewerOutput(stderr) {
  if (typeof stderr !== 'string') return '';
  const normalized = stderr.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const filtered = lines
    .filter((line) => !/^\s*Working\.\.\.\s*$/i.test(line))
    .filter((line) => !OMP_MCP_WARNING_RE.test(line));
  return filtered.join('\n');
}

/**
 * Provider-refusal signal (quota, rate limit, auth, capacity). Same pattern
 * historically inlined in isModelProviderFailure; hoisted so the quota-stall
 * watchdog can test streaming stderr while the child is still alive.
 */
const PROVIDER_REFUSAL_RE = /(quota|rate ?limit|RESOURCE_EXHAUSTED|insufficient[ _-]?(?:quota|capacity|credits|balance)|model (not )?(found|available|supported)|model [^\n]{0,80}(not found|unavailable|unsupported)|no endpoints found|provider (error|unavailable)|invalid api[-_ ]?key|set an api key environment variable|upgrade your subscription|(?:status(?: code)?|error code|response code)\s*[:=]?\s*(?:401|403|429)\b[^\n]{0,30}\b(?:Unauthorized|Forbidden|Too Many Requests)\b|\b(?:401|403|429)\s*(?:Unauthorized|Forbidden|Too Many Requests)\b|(?:^|\n)\s*(?:(?:(?:error|failure|failed)\s*:?\s*)?HTTP\s+(?:401|403|429)\b|status(?: code)?\s*[:=]?\s*(?:401|403|429)\b|(?:error|response) code\s*[:=]?\s*(?:401|403|429)\b))/i;

/**
 * Streaming chunk test for provider refusals. Pure predicate over text, no
 * verdict awareness: callers decide what a refusal means mid-run.
 */
export function containsProviderRefusal(text) {
  return typeof text === 'string' && PROVIDER_REFUSAL_RE.test(text);
}

const STAGE_AGENT_IDS = Object.freeze({
  'review-context-scout': 'scout',
  'review-risk-hunter': 'risk',
  'review-finding-verifier': 'verifier',
});

// `Configured subagent …` events carry DISPLAY names (`role: "subagent:<Parent>.<Display>"`),
// never the agent-type id — only `subagent launch timing` events do. The
// orchestrator picks display names at run time (CorrectnessHunter, HunterS1,
// HunterS2, …), so the stage word inside the name decides. Those names map by
// pattern, and a name with no stage word (the orchestrator's own row) maps to
// nothing and never pins a stage.
const STAGE_DISPLAY_PATTERNS = Object.freeze([
  [/Scout/, 'scout'],
  [/Hunter/, 'risk'],
  [/Verifier/, 'verifier'],
]);

/**
 * @param {string} display
 * @returns {string|undefined}
 */
function stageForDisplay(display) {
  for (const [pattern, stage] of STAGE_DISPLAY_PATTERNS) {
    if (pattern.test(display)) return stage;
  }
  return undefined;
}

/**
 * Best-effort stage derivation from the child OMP log. Reads the newest
 * `omp.<date>.<pid>.log`, scans for `Configured subagent` (stage start) and
 * `subagent launch timing` (stage end) JSON entries, and returns the current
 * stage label for `last-run.json`. `logAt` is the log's modification time: the
 * activity signal behind the quiet judgement, not a stage change. Never throws:
 * an unreadable or absent log yields `undefined`, leaving the caller to keep the
 * prior stage value.
 *
 * @param {{ logDir?: string, pid?: number, maxTailBytes?: number }} [opts]
 * @returns {Promise<{stage: string, completed: number, logAt: string}|undefined>}
 */
export async function childLogReadStage({ logDir, pid, maxTailBytes = 262_144 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const dir = logDir ?? path.join(homedir(), '.omp', 'logs');
    const suffix = `.${pid}.log`;
    const entries = await readdir(dir);
    const matches = entries.filter((name) => name.startsWith('omp.') && name.endsWith(suffix));
    if (matches.length === 0) return undefined;
    matches.sort().reverse();
    const logFile = path.join(dir, matches[0]);
    const logAt = new Date((await stat(logFile)).mtimeMs).toISOString();
    const tail = await readLogTail(logFile, maxTailBytes);
    const configuredRoles = [];
    const launchedAgents = [];
    for (const line of tail.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const message = String(entry.message ?? '');
      if (message === 'Configured subagent runtime model fallback chain') {
        configuredRoles.push(String(entry.role ?? ''));
      } else if (message === 'subagent launch timing') {
        launchedAgents.push(String(entry.agent ?? ''));
      }
    }
    // Stage-matched pairing, launch-side ground truth: a Configured dispatch
    // only pairs with a launch event when their stages agree. The outer
    // orchestrator's own Configured (role "subagent:<Parent>.ReviewerKit",
    // no stage) and non-stage dispatches pair with NOTHING and cannot shift
    // positional indices into wrong labels. A duplicated/retried/cancelled
    // Configured for a stage that already launched is a phantom: it must
    // not create an unfinished agent that pins the reported stage forever.
    const dispatchQueueByStage = new Map();
    for (const role of configuredRoles) {
      const display = (role ?? '').split('.').pop() ?? '';
      const stage = stageForDisplay(display);
      if (!stage) continue;
      const queue = dispatchQueueByStage.get(stage) ?? [];
      queue.push(role);
      dispatchQueueByStage.set(stage, queue);
    }
    const started = [];
    for (const agent of launchedAgents) {
      const agentStage = STAGE_AGENT_IDS[agent];
      const queue = agentStage ? (dispatchQueueByStage.get(agentStage) ?? []) : [];
      const dispatch = queue.length > 0 ? queue.shift() : undefined;
      const display = (dispatch ?? '').split('.').pop() ?? '';
      const stage = stageForDisplay(display) ?? agentStage;
      if (stage) started.push(stage);
    }
    // Configured-but-never-launched stages (dispatch issued, launch event
    // not yet in the tail): the stage is started only while it owns ZERO
    // launches — a launch for that stage consumes its dispatch, so a
    // surplus Configured for an already-launched stage is ignored.
    for (const [stage, queue] of dispatchQueueByStage) {
      const hadLaunches = launchedAgents.some((agent) => STAGE_AGENT_IDS[agent] === stage);
      if (!hadLaunches && queue.length > 0) started.push(stage);
    }
    // Per-agent completion: the two parallel risk hunters must BOTH finish
    // before the risk stage counts as complete; a Set of stage labels would
    // collapse them into one 'risk' entry and falsely conclude `allDone`
    // (regressing the reported stage back to 'scout').
    const finishedAgents = launchedAgents
      .map((agent) => STAGE_AGENT_IDS[agent])
      .filter(Boolean);
    const finishedCounts = new Map();
    for (const stage of finishedAgents) {
      finishedCounts.set(stage, (finishedCounts.get(stage) ?? 0) + 1);
    }
    const startedCounts = new Map();
    for (const stage of started) {
      startedCounts.set(stage, (startedCounts.get(stage) ?? 0) + 1);
    }
    // Current stage = the first observed stage whose agents are unfinished;
    // when every observed agent finished, the review sits in the gap before
    // the NEXT stage's Configured line — report the last completed stage
    // (never 'synthesis', which only begins after the verifier completes).
    let stage = 'scouting';
    let lastCompleted;
    for (let i = 0; i < started.length; i += 1) {
      const s = started[i];
      if ((finishedCounts.get(s) ?? 0) < (startedCounts.get(s) ?? 0)) {
        stage = s;
        lastCompleted = null;
        break;
      }
      lastCompleted = s;
    }
    if (lastCompleted) stage = lastCompleted === 'verifier' ? 'synthesis' : lastCompleted;
    // `completed` counts fully-finished STAGES: a stage is done when every
    // agent dispatched for it (Configured rows by stage) has launched and
    // finished. Configured-but-unlaunched dispatches count against the stage,
    // so hunter#2 pending keeps risk out of the finished set.
    const expectedByStage = new Map();
    for (const role of configuredRoles) {
      const disp = (role ?? '').split('.').pop() ?? '';
      const st = stageForDisplay(disp);
      if (st) expectedByStage.set(st, (expectedByStage.get(st) ?? 0) + 1);
    }
    const completedStages = new Set();
    for (const [s, n] of finishedCounts) {
      const expected = Math.max(expectedByStage.get(s) ?? 0, startedCounts.get(s) ?? 0);
      if (n >= expected && expected > 0) completedStages.add(s);
    }
    return { stage, completed: completedStages.size, logAt };
  } catch {
    return undefined;
  }
}
/**
 * Static heuristic proving a review attempt failed because the model provider
 * refused the request (quota, rate limit, auth, or capacity), rather than
 * because the review itself produced a verdict or timed out. A provider
 * failure ends the run with an infrastructure error: the kit never switches
 * models, that is OMP's own configuration (default role + fallbackChains).
 *
 * @param {{ status: number, stdout?: string, stderr?: string }} result
 * @returns {boolean}
 */
export function isModelProviderFailure(result) {
  if (result.status === 0) return false;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // A timeout is not a provider verdict.
  if (/Review timed out after/.test(combined)) return false;

  // A provider-side refusal can be wrapped in a synthetic BLOCK marker by
  // the orchestrator when dispatch fails. Detect it before treating BLOCK as
  // a completed review — but only when the envelope declares review_failure;
  // a confirmed_findings BLOCK that quotes refusal text is a real verdict.
  // Marker presence (not verdict validity) decides: a marker followed by
  // trailing stderr noise is still verdict-shaped output, not a dispatch
  // failure.
  const hasMarker = /^REVIEW_RESULT=(PASS|BLOCK)\r?$/m.test(combined);
  if (hasMarker) {
    const failureBlock = /"kind"\s*:\s*"review_failure"/.test(combined);
    return failureBlock && containsProviderRefusal(combined);
  }

  if (containsProviderRefusal(combined)) return true;

  // A real verdict means the review ran; the non-zero status may be OMP
  // reporting a BLOCK exit code.
  return false;
}

// Windows STATUS_STACK_BUFFER_OVERRUN (0xC0000409) and generic -1 exits: the
// child crashed before producing any review output.
// Second report channel: no bash write needed. Each review attempt runs the
// OMP child with its own `--session-dir`, so the task tool persists every
// task's complete result as `<session>/<artifacts>/<TaskId>.md`. The
// dispatcher's stdout can still lose the report (truncated task preview,
// unreadable `agent://` URI) and the durable per-run report file depends on
// a bash heredoc that project policy guards may deny; this artifact needs
// neither, so the runner reads it directly after the child exits.
const TASK_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const REPORT_MARKER_LINE_RE = /^REVIEW_RESULT=(PASS|BLOCK)\r?$/m;
const EXECUTION_FAILURE_CODE_RE = /"code"\s*:\s*"execution_failure"/;

/**
 * A task artifact stores the `yield` payload JSON-encoded: a plain string for
 * schema-less agents, an object for `reviewer-kit` whose `report` field holds
 * the complete Markdown. Decode either back to the raw report text; anything
 * else is returned as-is.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeTaskArtifact(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === 'string') return decoded;
      if (decoded && typeof decoded === 'object' && typeof decoded.report === 'string') return decoded.report;
    } catch {
      // Not decodable JSON: fall through to the raw text.
    }
  }
  return raw;
}

/**
 * True when the dispatcher stdout cannot be trusted to carry the reviewer's
 * report: no standalone verdict marker, or the dispatcher itself reported an
 * execution_failure envelope (typically "full report unreadable").
 *
 * @param {string|undefined} stdout
 * @returns {boolean}
 */
export function reviewOutputNeedsRecovery(stdout) {
  const text = String(stdout ?? '');
  return !REPORT_MARKER_LINE_RE.test(text) || EXECUTION_FAILURE_CODE_RE.test(text);
}

/**
 * Reads the newest top-level task result (one directory below the session
 * dir) that carries a standalone verdict marker. Subagent transcripts live a
 * level deeper and never qualify. Returns null when nothing usable exists.
 *
 * @param {string|null|undefined} sessionDir
 * @returns {Promise<{ text: string, file: string, bytes: number }|null>}
 */
export async function recoverTaskReport(sessionDir) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) return null;
  let best = null;
  try {
    for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const artifactsDir = path.join(sessionDir, entry.name);
      for (const file of await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile() || !file.name.endsWith('.md')) continue;
        const full = path.join(artifactsDir, file.name);
        const info = await stat(full).catch(() => null);
        if (!info || info.size === 0 || info.size > TASK_ARTIFACT_MAX_BYTES) continue;
        const text = decodeTaskArtifact(await readFile(full, 'utf8'));
        if (!REPORT_MARKER_LINE_RE.test(text)) continue;
        // Newest wins; equal mtimes (coarse-timestamp filesystems) fall back to the
        // greater path so the choice never depends on readdir order.
        if (!best || info.mtimeMs > best.mtimeMs || (info.mtimeMs === best.mtimeMs && full > best.file)) {
          best = { text, file: full, mtimeMs: info.mtimeMs };
        }
      }
    }
  } catch {
    return null;
  }
  return best ? { text: best.text, file: best.file, bytes: Buffer.byteLength(best.text) } : null;
}

const CHILD_CRASH_STATUSES = new Set([3221226505, -1073740791, 4294967295, -1]);

/**
 * True when the OMP child died with a hard crash code and printed nothing:
 * a runtime fault, not a verdict, worth exactly one re-run.
 */
export function isChildCrash(result) {
  return CHILD_CRASH_STATUSES.has(result?.status) && String(result?.stdout ?? '').trim() === '';
}

export function configuredInteger(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Raw `--max-time` values accepted from OMP_REVIEW_KIT_MAX_TIME and forwarded
 * to the OMP child: plain seconds (`600`) or suffixed durations (`10m`, `1h`)
 * - exactly the shapes `omp --max-time` documents. Anything else disables
 * the bound (historical unbounded behavior).
 */
const REVIEW_MAX_TIME_RE = /^(\d+)([smh])?$/;

/**
 * Parses the review attempt bound into the raw `--max-time` arg for the OMP
 * child plus its millisecond equivalent for telemetry. `0`/empty/invalid
 * disables the bound and returns nulls.
 */
export function parseReviewMaxTime(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '' || raw === '0') return { arg: null, ms: null };
  const match = REVIEW_MAX_TIME_RE.exec(raw);
  if (!match) return { arg: null, ms: null };
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { arg: null, ms: null };
  const factor = match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : 1_000;
  const ms = amount * factor;
  if (!Number.isSafeInteger(ms)) return { arg: null, ms: null };
  return { arg: raw, ms };
}

/**
 * Heuristic: max-time expiry is observable only as exit-0-with-empty-stdout
 * at ~the bound (verified live: `--max-time 20s` exits 0 with no output).
 * The 30s tolerance absorbs spawn/teardown overhead; a model that genuinely
 * returned empty well before the bound is not misclassified.
 */
export function isMaxTimeExpiry({ stdout, durationMs, maxTimeMs }) {
  if (!(maxTimeMs > 0)) return false;
  if ((stdout ?? '').trim() !== '') return false;
  return durationMs >= maxTimeMs - 30_000;
}

/**
 * Skill catalog visible to the review child. The catalog is resent with every
 * request of every stage, and an autolearn-grown store of hundreds of skills
 * made the base request ~213KB (measured; ~92KB with review-domain skills
 * only), so the child lists only the plugin's own skills plus plugin-named
 * skills by default. The plugin skills are always included: the orchestrator
 * autoloads the protocol skills, and a filter that hides them empties the
 * catalog and breaks every skill:// read. OMP_REVIEW_KIT_SKILLS: unset = the
 * default extra patterns, a comma-separated glob list = extra patterns added
 * to the plugin skills, `all` (any case, anywhere in the list) = the full
 * catalog. An invalid list falls back to the default extra patterns.
 */
const REVIEW_PLUGIN_SKILLS = ['multi-stage-review', 'reality-first-review', 'range-audit', 'slop'];
const DEFAULT_REVIEW_SKILL_PATTERNS = '*reviewer-kit*,*review-kit*';
const REVIEW_SKILL_PATTERN_RE = /^[A-Za-z0-9_.*?-]+$/;
function reviewSkillsSelection() {
  const requested = (process.env.OMP_REVIEW_KIT_SKILLS ?? '').split(',').map((pattern) => pattern.trim()).filter(Boolean);
  if (requested.some((pattern) => pattern.toLowerCase() === 'all')) return { args: [], label: 'all' };
  const valid = requested.length > 0 && requested.every((pattern) => REVIEW_SKILL_PATTERN_RE.test(pattern));
  const extra = valid ? requested : DEFAULT_REVIEW_SKILL_PATTERNS.split(',');
  const value = [...new Set([...REVIEW_PLUGIN_SKILLS, ...extra])].join(',');
  return { args: [`--skills=${value}`], label: value };
}


async function terminateProcessTree(proc) {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(resolve, 250);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', finish);
    });
    return;
  }

  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('close', onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('close', onClose);
    if (proc.exitCode !== null || proc.signalCode !== null) finish(true);
  });
  const signalTree = (signal) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };

  signalTree('SIGTERM');
  if (await waitForExit(250)) return;
  signalTree('SIGKILL');
  await waitForExit(250);
}

/**
 * Infrastructure adapter running headless OMP CLI reviews.
 */
export class OmpCliReviewerAdapter extends ReviewerPort {
  #runner;
  #preflight;
  #preflightTimeoutMs;
  #reviewMaxTime;
  #progress;

  /**
   * The adapter never selects, resolves, or falls back between models: OMP is
   * the user's configured tool (default role, `retry.fallbackChains`,
   * `modelFallback`) and the review child inherits it untouched. The only
   * pre-check is a short model-less health call so a missing login or dead
   * provider fails in seconds instead of after a full review.
   *
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number, options?: object) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   preflight?: ((cwd: string, timeoutMs: number) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string })|null,
   *   preflightTimeoutMs?: number,
   *   maxTime?: string,
   *   progress?: (event: { state: string, message: string, elapsedMs?: number }) => void
   * }} [options]
   */
  constructor({
    runner,
    preflight,
    preflightTimeoutMs = configuredInteger(process.env.OMP_REVIEW_KIT_PREFLIGHT_TIMEOUT_MS, 90_000, 1),
    maxTime = process.env.OMP_REVIEW_KIT_MAX_TIME ?? null,
    progress,
  } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    // An injected runner replaces the real OMP child, so the real health call
    // would be meaningless (and spawn a real process); it is opt-in then.
    this.#preflight = preflight === undefined
      ? (runner ? null : OmpCliReviewerAdapter.defaultPreflight)
      : preflight;
    this.#preflightTimeoutMs = configuredInteger(preflightTimeoutMs, 90_000, 1);
    this.#reviewMaxTime = parseReviewMaxTime(maxTime);
    this.#progress = progress ?? (() => {});
  }

  #emitProgress(event) {
    try {
      this.#progress(event);
    } catch {
      // Progress is observability only and must never change the review verdict.
    }
  }

  async #runReviewAttempt(promptText, cwd, telemetry, attempts, attemptIndex, { reportPath = null } = {}) {
    const startedAt = Date.now();
    const record = { attemptIndex, startedAt: new Date(startedAt).toISOString() };
    const stageHistory = [];
    // Latest mtime of the OMP child's log: the activity signal behind the quiet judgement.
    let childLogAt = null;
    attempts.push(record);
    let responseObserved = false;
    let workingSignalObserved = false;
    const emitRunning = () => {
      this.#emitProgress({
        state: 'reviewing',
        message: 'commit hook review running; waiting for model response',
        elapsedMs: Date.now() - startedAt,
      });
      void telemetry.updateLastRun({
        state: 'reviewing',
        pid: record.pid,
        ...(childLogAt ? { childLogAt } : {}),
        elapsedMs: Date.now() - startedAt,
      });
    };

    this.#emitProgress({
      state: 'reviewing',
      message: 'commit hook review started; waiting for model response',
      elapsedMs: 0,
    });
    const heartbeat = setInterval(emitRunning, 5_000);
    heartbeat.unref?.();
    let sessionDir = null;
    try {
      sessionDir = await mkdtemp(path.join(tmpdir(), `reviewer-kit-session-${process.pid}-`));
    } catch {
      sessionDir = null;
    }
    try {
      const result = await this.#runner(promptText, cwd, undefined, {
        maxTime: this.#reviewMaxTime.arg,
        ...(sessionDir ? { sessionDir } : {}),
        // Lets project policy guards recognize the one write the reviewer
        // may perform (its durable report) without pattern-matching the command.
        ...(reportPath ? { env: { OMP_REVIEW_KIT_REPORT_PATH: reportPath } } : {}),
        onSpawn: (pid) => {
          record.pid = pid;
          void telemetry.record('review_attempt_started', { ...record, pid });
          void telemetry.updateLastRun({ state: 'reviewing', pid });
        },
        onOutput: (chunk, stream) => {
          const text = String(chunk);
          if (stream === 'stderr' && !workingSignalObserved && /Working\.\.\./i.test(text)) {
            workingSignalObserved = true;
            this.#emitProgress({
              state: 'working',
              message: 'OMP child process is active; waiting for model response',
              elapsedMs: Date.now() - startedAt,
            });
            void telemetry.record('review_attempt_working', {
              attemptIndex, pid: record.pid, elapsedMs: Date.now() - startedAt,
            });
          }
          if (stream === 'stdout' && !responseObserved && text.trim()) {
            responseObserved = true;
            this.#emitProgress({
              state: 'response',
              message: 'model response received; checking verdict',
              elapsedMs: Date.now() - startedAt,
            });
            void telemetry.record('review_attempt_first_output', {
              attemptIndex, pid: record.pid, elapsedMs: Date.now() - startedAt,
            });
          }
        },
        onActivity: (logAt) => {
          childLogAt = logAt;
        },
        onStage: ({ stage, completed }) => {
          if (!stage) return;
          stageHistory.push({ stage, completed, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
          this.#emitProgress({
            state: 'reviewing',
            message: `review stage ${stage}${completed > 0 ? ` (${completed} done)` : ''}`,
            elapsedMs: Date.now() - startedAt,
          });
          void telemetry.updateLastRun({
            state: 'reviewing',
            pid: record.pid,
            stage,
            stagesCompleted: completed,
            stageHistory,
            progressAt: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
          }, { force: true });
        },
      });
      record.status = result?.status;
      record.durationMs = Date.now() - startedAt;
      record.providerFailure = isModelProviderFailure(result ?? {});
      record.timedOut = isMaxTimeExpiry({
        stdout: result?.stdout,
        durationMs: record.durationMs,
        maxTimeMs: this.#reviewMaxTime.ms,
      });
      record.stdoutBytes = typeof result?.stdout === 'string' ? Buffer.byteLength(result.stdout) : 0;
      if (stageHistory.length > 0) record.stageHistory = stageHistory;
      record.stderrBytes = typeof result?.stderr === 'string' ? Buffer.byteLength(result.stderr) : 0;
      let outcome = result;
      if (sessionDir && reviewOutputNeedsRecovery(result?.stdout)) {
        const recovered = await recoverTaskReport(sessionDir);
        if (recovered) {
          const reason = EXECUTION_FAILURE_CODE_RE.test(String(result?.stdout ?? '')) ? 'execution_failure' : 'missing_marker';
          record.reportRecovered = { reason, bytes: recovered.bytes };
          await telemetry.record('report_artifact_recovered', { attemptIndex, pid: record.pid, reason, bytes: recovered.bytes });
          outcome = { ...result, stdout: recovered.text };
        }
      }
      // Per-stage turn and tool-call counts: a stage lasts turns x turn latency,
      // so this is what explains a slow review. Read before the session dir goes.
      const stages = await summarizeStageTranscripts(sessionDir);
      if (stages.length > 0) await telemetry.record('stage_stats', { attemptIndex, pid: record.pid, stages });
      // The scout's map is carried to the next round so coverage does not drift.
      const scoutBaseline = parseScoutBaseline(await readStageResult(sessionDir, /scout$/i));
      if (scoutBaseline) outcome = { ...outcome, scoutBaseline };
      await telemetry.record('review_attempt_finished', { ...record });
      return outcome;
    } finally {
      clearInterval(heartbeat);
      if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Model-less health call: proves OMP can answer at all with the user's own
   * configuration (default role plus whatever fallbacks they configured).
   * Returns null when healthy, otherwise the failing result.
   */
  async #runPreflight(cwd, telemetry) {
    if (!this.#preflight) return null;
    const startedAt = Date.now();
    const record = { startedAt: new Date(startedAt).toISOString() };
    await telemetry.record('preflight_started', { ...record });
    this.#emitProgress({ state: 'probe', message: 'checking that OMP can reach a model', elapsedMs: 0 });
    void telemetry.updateLastRun({ state: 'probing' });
    const heartbeat = setInterval(() => this.#emitProgress({
      state: 'probe',
      message: 'checking that OMP can reach a model',
      elapsedMs: Date.now() - startedAt,
    }), 5_000);
    heartbeat.unref?.();
    let result;
    try {
      result = await this.#preflight(cwd, this.#preflightTimeoutMs);
    } catch (error) {
      result = { status: 1, stdout: '', stderr: error?.message ?? String(error) };
    } finally {
      clearInterval(heartbeat);
    }
    record.pid = result?.pid;
    record.status = result?.status;
    record.durationMs = Date.now() - startedAt;
    // Healthy = exit 0 with an actual answer. Provider-error text on stderr alone
    // is not a failure here: OMP prints auxiliary-request noise (e.g. 403 on a
    // side model) while the main flow still answers.
    const healthy = result?.status === 0 && String(result?.stdout ?? '').trim() !== '';
    record.healthy = healthy;
    await telemetry.record('preflight_finished', { ...record });
    return healthy ? null : (result ?? { status: 1, stdout: '', stderr: '' });
  }

  /**
   * Standard OMP CLI runner using async spawn to avoid pipe buffer deadlocks.
   * No model flags are ever passed: OMP resolves its own default role.
   *
   * @param {string} prompt
   * @param {string} cwd
   * @param {number} [timeout]
   * @param {{ noTools?: boolean, maxTime?: string|null, stagePollMs?: number, logDir?: string|null, onOutput?: (chunk: unknown, stream: 'stdout'|'stderr') => void, onSpawn?: (pid: number|undefined) => void, onStage?: (info: { stage: string, completed: number }) => void, onActivity?: (logAt: string) => void, registryEnv?: string|null, sessionDir?: string, env?: Record<string, string> }} [options]
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number }>}
   */
  static defaultRunner(prompt, cwd, timeout, { noTools = false, maxTime, stagePollMs = 10_000, logDir = null, onOutput, onSpawn, onStage, onActivity, registryEnv, sessionDir, env: extraEnv } = {}) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      // Read-only review child: session titles are never displayed in print
      // mode and project rules guard edits the child cannot perform (its
      // tools are task/read plus read-only specialists), so skip title
      // generation and rules discovery on every spawned session. No model
      // flag: the child resolves the user's own OMP configuration.
      // A review attempt persists its session under its own directory so the
      // task artifacts (the full reviewer result) survive until the runner
      // has read them; no-tools probes stay ephemeral.
      const sessionArgs = typeof sessionDir === 'string' && sessionDir.length > 0 ? ['--session-dir', sessionDir] : ['--no-session'];
      const commandArgs = ['-p', ...(noTools ? ['--no-tools'] : ['--tools', 'task,read']), ...sessionArgs, '--no-title', '--no-rules'];
      commandArgs.push(...reviewSkillsSelection().args);
      if (typeof maxTime === 'string' && REVIEW_MAX_TIME_RE.test(maxTime)) {
        commandArgs.push('--max-time', maxTime);
      }
      const dispatchPrompt = `${prompt}\nUse task calls without model, outputSchema, schemaMode, or isolated fields.`;
      const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const args = isWindowsWrapper
        ? ['/d', '/c', 'call', command, ...commandArgs]
        : commandArgs;

      const proc = spawn(executable, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Stale-parent guard: pull PI_PROXY_* from the user registry when the
        // inherited env lacks them — children otherwise die at OAuth refresh.
        env: {
          ...mergeRegistryProxyEnv(process.env, registryEnv ?? undefined),
          ...Object.fromEntries(Object.entries(extraEnv ?? {}).filter(([, value]) => typeof value === 'string')),
        },
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const pid = Number.isInteger(proc.pid) ? proc.pid : undefined;
      try {
        onSpawn?.(pid);
      } catch {
        // Telemetry callbacks must never affect the review process.
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer;
      let stagePoller;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stagePoller) clearInterval(stagePoller);
        resolve({ pid, ...result });
      };

      if (timeout && timeout > 0) {
        timer = setTimeout(async () => {
          timedOut = true;
          await terminateProcessTree(proc);
          finish({
            status: 1,
            stdout,
            stderr: 'Review timed out after ' + timeout + 'ms\n' + stderr,
          });
        }, timeout);
      }

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        onOutput?.(chunk, 'stdout');
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        onOutput?.(chunk, 'stderr');
      });

      if (Number.isInteger(pid) && pid > 0 && typeof onStage === 'function') {
        let pollRunning = false;
        let lastStage;
        stagePoller = setInterval(() => {
          if (pollRunning || settled) return;
          pollRunning = true;
          void childLogReadStage({ logDir, pid })
            .then((stageInfo) => {
              // Post-settle guard: an in-flight tick resolving after close()
              // must not deliver stage updates — updateLastRun would regress
              // the terminal state back to 'reviewing'.
              if (settled) return;
              // Child-log activity feeds the quiet judgement; it is not a stage change.
              if (stageInfo?.logAt) {
                try { onActivity?.(stageInfo.logAt); } catch {}
              }
              if (stageInfo) {
                // Monotonic progress: a truncated tail can make the log look
                // earlier than it is; never report a regression — neither the
                // stage label nor the completed count may move backward.
                const rank = (s) => ['scouting', 'scout', 'risk', 'verifier', 'synthesis'].indexOf(s);
                if (lastStage && rank(stageInfo.stage) >= 0 && rank(stageInfo.stage) < rank(lastStage.stage)) {
                  stageInfo = { ...stageInfo, stage: lastStage.stage };
                }
                const prevCompleted = lastStage?.completed ?? -1;
                // r28 correctness-1: tail-window eviction can shrink the
                // recomputed count while the stage still advances — clamp
                // completed to monotonic before reporting/tracking.
                if ((stageInfo.completed ?? 0) < prevCompleted) {
                  stageInfo = { ...stageInfo, completed: prevCompleted };
                }
                const advanced = stageInfo.stage !== lastStage?.stage
                  || (stageInfo.completed ?? 0) > prevCompleted;
                if (advanced) {
                  lastStage = { stage: stageInfo.stage, completed: stageInfo.completed };
                  try { onStage?.(stageInfo); } catch {}
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              pollRunning = false;
            });
        }, stagePollMs > 0 ? stagePollMs : 10_000);
      }

      proc.on('close', (code) => {
        if (timedOut) return;
        finish({ status: code ?? 1, stdout, stderr });
      });

      proc.on('error', (err) => {
        if (timedOut) return;
        finish({ status: 1, stdout, stderr: `${err.message || err}\n${stderr}` });
      });

      // Guard against EPIPE if process terminates before reading stdin
      proc.stdin.on('error', () => {});
      try {
        proc.stdin.write(dispatchPrompt);
        proc.stdin.end();
      } catch {
        // Ignore write failures on closed streams
      }
    });
  }

  /**
   * Minimal no-tools, model-less request confirming OMP can reach a model.
   *
   * @param {string} cwd
   * @param {number} timeout
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  static defaultPreflight(cwd, timeout) {
    return OmpCliReviewerAdapter.defaultRunner(
      'Respond with exactly READY. Do not use tools.',
      cwd,
      configuredInteger(timeout, 90_000, 1),
      { noTools: true },
    );
  }

  /**
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string,
   *   telemetry?: { record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> },
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, combined: string, modelsTried: string[], attempts: object[], probes: object[] }>}
   */
  async executeReview({ prompt, cwd, telemetry = NULL_RUN_TELEMETRY }) {
    telemetry = safeRunTelemetry(telemetry);
    await telemetry.record('review_chain', {
      preflightTimeoutMs: this.#preflight ? this.#preflightTimeoutMs : null,
      maxTime: this.#reviewMaxTime.arg,
      skills: reviewSkillsSelection().label,
    });
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const reportPath = typeof prompt === 'object' && typeof prompt?.reportPath === 'string' ? prompt.reportPath : null;
    const attempts = [];
    const probes = [];

    const preflightFailure = await this.#runPreflight(cwd, telemetry);
    let result;
    if (preflightFailure) {
      probes.push({ kind: 'preflight', status: preflightFailure.status });
      result = {
        status: 1,
        stdout: '',
        stderr: formatProviderOutageError(preflightFailure.stderr || preflightFailure.stdout),
      };
    } else {
      result = await this.#runReviewAttempt(promptText, cwd, telemetry, attempts, 0, { reportPath });
      // A hard child crash (Windows 0xC0000409 / -1) with no output is a
      // runtime fault, not a verdict: one more run with the same command.
      if (isChildCrash(result)) {
        result = await this.#runReviewAttempt(promptText, cwd, telemetry, attempts, 1, { reportPath });
      }
      if (isModelProviderFailure(result)) {
        result = {
          status: 1,
          stdout: result.stdout ?? '',
          stderr: formatProviderOutageError(result.stderr),
        };
      }
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = `${stdout}\n${sanitizeReviewerOutput(stderr)}`;

    return {
      status: result.status ?? 1,
      stdout,
      stderr,
      combined,
      modelsTried: [],
      attempts,
      probes,
      ...(result.scoutBaseline ? { scoutBaseline: result.scoutBaseline } : {}),
    };
  }

  /**
   * Runs exactly one bounded no-tools re-prompt asking OMP to reproduce its
   * previous output verbatim under the verdict contract. Reuses the
   * single-shot runner path and the preflight-timeout budget.
   *
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string,
   *   timeoutMs?: number,
   *   telemetry?: { record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> },
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number, attempts: object[] }>}
   */
  async reemitVerbatim({ prompt, cwd, timeoutMs, telemetry = NULL_RUN_TELEMETRY }) {
    telemetry = safeRunTelemetry(telemetry);
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const timeout = configuredInteger(timeoutMs, this.#preflightTimeoutMs, 1);
    const startedAt = Date.now();
    const record = { kind: 'reemit', startedAt: new Date(startedAt).toISOString() };
    const attempts = [record];
    await telemetry.record('reemit_started', { ...record });
    void telemetry.updateLastRun({ state: 'reemitting' });
    try {
      const result = await this.#runner(promptText, cwd, timeout, {
        noTools: true,
        onSpawn: (pid) => {
          record.pid = pid;
          void telemetry.updateLastRun({ state: 'reemitting', pid });
        },
      });
      record.pid = record.pid ?? result?.pid;
      record.status = result?.status;
      record.durationMs = Date.now() - startedAt;
      record.stdoutBytes = typeof result?.stdout === 'string' ? Buffer.byteLength(result.stdout) : 0;
      record.stderrBytes = typeof result?.stderr === 'string' ? Buffer.byteLength(result.stderr) : 0;
      await telemetry.record('reemit_finished', { ...record });
      return {
        status: result?.status ?? 1,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
        pid: record.pid,
        attempts,
      };
    } catch (error) {
      record.status = 1;
      record.durationMs = Date.now() - startedAt;
      record.stderrBytes = 0;
      record.error = error?.message ?? String(error);
      await telemetry.record('reemit_finished', { ...record });
      return { status: 1, stdout: '', stderr: record.error, pid: record.pid, attempts };
    }
  }
}
