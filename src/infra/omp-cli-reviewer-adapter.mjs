import { spawn, spawnSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ReviewerPort } from '../application/ports.mjs';
import { ReviewVerdict } from '../domain/review-verdict.mjs';
import { NULL_RUN_TELEMETRY, formatProviderOutageError, safeRunTelemetry } from './filesystem-telemetry-adapter.mjs';

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

/**
 * Sanitizes stderr from reviewer execution:
 * (a) removes every line matching /^\s*Working\.\.\.\s*$/i (OMP print-mode progress noise),
 * (b) normalizes CRLF to LF.
 *
 * @param {string} stderr
 * @returns {string}
 */
export function sanitizeReviewerOutput(stderr) {
  if (typeof stderr !== 'string') return '';
  const normalized = stderr.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const filtered = lines.filter((line) => !/^\s*Working\.\.\.\s*$/i.test(line));
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

/**
 * Broader live-monitoring signal: the strict refusal pattern plus mid-line
 * provider error shapes observed in OMP logs (`Error 429: Daily free
 * limit`, `INFERENCE_CAP_ERROR`). Safe here because stderr and child logs
 * carry diagnostics, never review prose - the incidental-doc-text concern
 * that keeps the final classifier line-anchored does not apply. Byte-count
 * false positives are excluded by requiring an error/limit word near the
 * status code.
 */
const QUOTA_STALL_SIGNAL_EXTRA_RE = /(?:error|failure|failed)[^\n]{0,40}?\b(?:401|403|429)\b|(?:free|daily)[ -]?limit|INFERENCE_CAP_ERROR/i;

export function containsQuotaStallSignal(text) {
  return containsProviderRefusal(text) || (typeof text === 'string' && QUOTA_STALL_SIGNAL_EXTRA_RE.test(text));
}

const QUOTA_STALL_PREFIX = 'Review stalled on provider quota after ';

/**
 * Detects a quota-stall kill performed by the runner: the marker is prepended
 * to stderr exactly once when the watchdog fires. Mirrors the existing
 * 'Review timed out after' marker convention.
 */
export function isQuotaStallStderr(stderr) {
  return typeof stderr === 'string' && stderr.includes(QUOTA_STALL_PREFIX);
}
/**
 * Title-generator lines are auxiliary session-name requests, not the review
 * flow: they run through a different provider chain and fail with 403/429
 * while the main review keeps streaming. Counting them as a quota signal
 * kills healthy reviews (observed 2026-09-23: pids 46340/79756/27104/58628
 * stall-killed on title-generator 403 FreeTierError with zero main-flow
 * provider errors).
 */
function stripTitleGeneratorLines(text) {
  return String(text ?? '').split('\n').filter((line) => !line.includes('title-generator')).join('\n');
}

/**
 * Best-effort child-log lookup: OMP names per-process logs
 * `omp.<date>.<pid>.log` (see ompLogHints in run telemetry). Returns true
 * when the tail carries a quota-stall signal. Never throws: an
 * unresolvable log simply yields no signal and the watchdog degrades to
 * stderr-only.
 */
export async function childLogHasQuotaSignal({ logDir, pid, maxTailBytes = 65_536 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const dir = logDir ?? path.join(homedir(), '.omp', 'logs');
    const suffix = `.${pid}.log`;
    const entries = await readdir(dir);
    const matches = entries.filter((name) => name.startsWith('omp.') && name.endsWith(suffix));
    if (matches.length === 0) return false;
    matches.sort().reverse();
    const tail = await readLogTail(path.join(dir, matches[0]), maxTailBytes);
    return containsQuotaStallSignal(stripTitleGeneratorLines(tail));
  } catch {
    return false;
  }
}

const STAGE_AGENT_IDS = Object.freeze({
  'review-context-scout': 'scout',
  'review-risk-hunter': 'risk',
  'review-finding-verifier': 'verifier',
});

// `Configured subagent …` events carry DISPLAY names (`role: "subagent:<Parent>.<Display>"`),
// never the agent-type id — only `subagent launch timing` events do. Map the
// observed display suffixes to stages and, as a positional fallback, pair
// Configured events with launch-timing events in chronological order.
const STAGE_ROLE_DISPLAYS = Object.freeze({
  ContextScout: 'scout',
  CorrectnessHunter: 'risk',
  SecurityHunter: 'risk',
  ContentRiskHunter: 'risk',
  FindingVerifier: 'verifier',
});

/**
 * Best-effort stage derivation from the child OMP log. Reads the newest
 * `omp.<date>.<pid>.log`, scans for `Configured subagent` (stage start) and
 * `subagent launch timing` (stage end) JSON entries, and returns the current
 * stage label for `last-run.json`. Never throws: an unreadable or absent log
 * yields `undefined`, leaving the caller to keep the prior stage value.
 *
 * @param {{ logDir?: string, pid?: number, maxTailBytes?: number }} [opts]
 * @returns {Promise<{stage: string, completed: number}|undefined>}
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
    const tail = await readLogTail(path.join(dir, matches[0]), maxTailBytes);
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
      const stage = STAGE_ROLE_DISPLAYS[display];
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
      const stage = STAGE_ROLE_DISPLAYS[display] ?? agentStage;
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
      const st = STAGE_ROLE_DISPLAYS[disp];
      if (st) expectedByStage.set(st, (expectedByStage.get(st) ?? 0) + 1);
    }
    const completedStages = new Set();
    for (const [s, n] of finishedCounts) {
      const expected = Math.max(expectedByStage.get(s) ?? 0, startedCounts.get(s) ?? 0);
      if (n >= expected && expected > 0) completedStages.add(s);
    }
    return { stage, completed: completedStages.size };
  } catch {
    return undefined;
  }
}

/**
 * Static heuristic proving a review attempt failed because the model provider
 * refused the request (quota, rate limit, auth, or capacity), rather than
 * because the review itself produced a verdict or timed out.
 *
 * A provider-side failure is the only legitimate trigger for fallback retries.
 * We never fall back after a real PASS/BLOCK verdict or after the timeout: a
 * timed-out review would time out on every model, and the timeout budget is
 * per-attempt, so retrying would multiply wall-clock cost without new signal.
 *
 * @param {{ status: number, stdout?: string, stderr?: string }} result
 * @returns {boolean}
 */
export function isModelProviderFailure(result) {
  if (result.status === 0) return false;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // A stall kill proves a provider refusal was observed mid-run (stderr or
  // child log); the marker alone classifies even when the accumulated
  // output carries no refusal text (mid-run 429s go to the log, not stderr).
  if (isQuotaStallStderr(combined)) return true;

  // Timeout is per-attempt; retrying would multiply wall-clock cost without
  // new signal on another model.
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
  // reporting a BLOCK exit code. Never retry that.
  return false;
}

export function configuredInteger(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
function isSafeModelSelector(value) {
  return typeof value === 'string' && /^[A-Za-z0-9@._:/+-]+$/.test(value);
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
 * Review children are spawned with OMP role selectors only (`@smol`,
 * `@task`, ...). A concrete `provider/model` selector would bypass the
 * user's `retry.fallbackChains` (chains key off the configured role) and
 * could pick a model the user never assigned, so non-role selectors are
 * rejected before spawn.
 */
function isRoleSelector(value) {
  return typeof value === 'string' && /^@[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Thinking levels accepted by `omp --thinking`. OMP_REVIEW_KIT_EFFORT maps
 * to that flag; unset means the role's own configured effort applies.
 */
const REVIEW_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
function reviewThinkingLevel() {
  const raw = process.env.OMP_REVIEW_KIT_EFFORT;
  return REVIEW_THINKING_LEVELS.has(raw) ? raw : null;
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
  #modelsProvider;
  #primaryModel;
  #maxFallbacks;
  #modelProbe;
  #probeTimeoutMs;
  #reviewMaxTime;
  #quotaStallMs;
  #progress;
  #roleResolver;
  #rolesCache;
  #lastReviewModel;

  /**
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number, model?: string) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   modelsProvider?: () => string[]|Promise<string[]>,
   *   primaryModel?: string,
   *   maxFallbacks?: number,
     *   modelProbe?: (cwd: string, timeoutMs: number, model: string) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   probeTimeoutMs?: number,
   *   maxTime?: string,
   *   quotaStallMs?: number,
   *   progress?: (event: { state: string, message: string, model?: string, elapsedMs?: number }) => void,
   *   roleResolver?: (cwd: string) => Promise<Record<string, string>>|Record<string, string>
   * }} [options]
   */
  constructor({
    runner,
    modelsProvider,
    primaryModel = process.env.OMP_REVIEW_KIT_MODEL ?? '@smol',
    maxFallbacks = configuredInteger(process.env.OMP_REVIEW_KIT_MAX_FALLBACKS, 3, 0),
    modelProbe,
    probeTimeoutMs = configuredInteger(process.env.OMP_REVIEW_KIT_PROBE_TIMEOUT_MS, 60_000, 1),
    maxTime = process.env.OMP_REVIEW_KIT_MAX_TIME ?? null,
    quotaStallMs = configuredInteger(process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS, 300_000, 0),
    progress,
    roleResolver,
  } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    this.#modelsProvider = modelsProvider ?? OmpCliReviewerAdapter.defaultModelsProvider;
    this.#primaryModel = primaryModel;
    this.#maxFallbacks = maxFallbacks;
    this.#modelProbe = modelProbe ?? OmpCliReviewerAdapter.defaultModelProbe;
    this.#probeTimeoutMs = configuredInteger(probeTimeoutMs, 60_000, 1);
    this.#reviewMaxTime = parseReviewMaxTime(maxTime);
    this.#quotaStallMs = configuredInteger(quotaStallMs, 300_000, 0);
    this.#progress = progress ?? (() => {});
    this.#roleResolver = roleResolver ?? OmpCliReviewerAdapter.defaultRoleResolver;
    this.#rolesCache = null;
    this.#lastReviewModel = null;
  }

  #emitProgress(event) {
    try {
      this.#progress(event);
    } catch {
      // Progress is observability only and must never change the review verdict.
    }
  }

  /**
   * Validates an OMP role selector (`@smol`, `@task`, ...) against the
   * user's configured roles and returns the concrete `provider/model[:effort]`
   * for telemetry. The child itself is spawned with the raw `@role` so OMP
   * resolves the role inside the child and the user's `retry.fallbackChains`
   * stay active there. Non-role selectors are rejected.
   */
  async #resolveSelector(cwd, selector, telemetry) {
    if (!isRoleSelector(selector)) {
      throw new Error(`Model selector ${JSON.stringify(selector)} is not an OMP role (@name); reviewer-kit uses only configured roles`);
    }
    if (!this.#rolesCache) {
      this.#rolesCache = Promise.resolve()
        .then(() => this.#roleResolver(cwd))
        .then((roles) => (roles && typeof roles === 'object' ? roles : {}))
        .catch(() => ({}));
      const roles = await this.#rolesCache;
      await telemetry.record('roles_resolved', { roles });
    }
    const resolved = (await this.#rolesCache)[selector.slice(1)];
    if (typeof resolved !== 'string' || !isSafeModelSelector(resolved)) {
      throw new Error(`Model role ${selector} not found in OMP configuration`);
    }
    return resolved;
  }

  async #runReviewAttempt(promptText, cwd, model, telemetry, attempts, attemptIndex) {
    const startedAt = Date.now();
    const record = { model, attemptIndex, startedAt: new Date(startedAt).toISOString() };
    const stageHistory = [];
    attempts.push(record);
    let resolvedModel;
    try {
      resolvedModel = await this.#resolveSelector(cwd, model, telemetry);
    } catch (error) {
      record.status = 1;
      record.durationMs = Date.now() - startedAt;
      record.providerFailure = true;
      record.stderrBytes = 0;
      record.error = error?.message ?? String(error);
      await telemetry.record('review_attempt_finished', { ...record });
      return { status: 1, stdout: '', stderr: record.error };
    }
    if (resolvedModel !== model) record.resolvedModel = resolvedModel;
    this.#lastReviewModel = model;
    let responseObserved = false;
    let workingSignalObserved = false;
    const emitRunning = () => {
      this.#emitProgress({
        state: 'reviewing',
        message: 'commit hook review running; waiting for model response',
        model,
        elapsedMs: Date.now() - startedAt,
      });
      void telemetry.updateLastRun({
        state: 'reviewing',
        model,
        pid: record.pid,
        elapsedMs: Date.now() - startedAt,
      });
    };

    this.#emitProgress({
      state: 'reviewing',
      message: 'commit hook review started; waiting for model response',
      model,
      elapsedMs: 0,
    });
    const heartbeat = setInterval(emitRunning, 5_000);
    heartbeat.unref?.();
    try {
      const result = await this.#runner(promptText, cwd, undefined, model, {
        maxTime: this.#reviewMaxTime.arg,
        quotaStallMs: this.#quotaStallMs,
        onSpawn: (pid) => {
          record.pid = pid;
          void telemetry.record('review_attempt_started', { ...record, pid });
          void telemetry.updateLastRun({ state: 'reviewing', model, pid });
        },
        onOutput: (chunk, stream) => {
          const text = String(chunk);
          if (stream === 'stderr' && !workingSignalObserved && /Working\.\.\./i.test(text)) {
            workingSignalObserved = true;
            this.#emitProgress({
              state: 'working',
              message: 'OMP child process is active; waiting for model response',
              model,
              elapsedMs: Date.now() - startedAt,
            });
            void telemetry.record('review_attempt_working', {
              model, attemptIndex, pid: record.pid, elapsedMs: Date.now() - startedAt,
            });
          }
          if (stream === 'stdout' && !responseObserved && text.trim()) {
            responseObserved = true;
            this.#emitProgress({
              state: 'response',
              message: 'model response received; checking verdict',
              model,
              elapsedMs: Date.now() - startedAt,
            });
            void telemetry.record('review_attempt_first_output', {
              model, attemptIndex, pid: record.pid, elapsedMs: Date.now() - startedAt,
            });
          }
        },
        onStage: ({ stage, completed }) => {
          if (!stage) return;
          stageHistory.push({ stage, completed, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
          this.#emitProgress({
            state: 'reviewing',
            message: `review stage ${stage}${completed > 0 ? ` (${completed} done)` : ''}`,
            model,
            elapsedMs: Date.now() - startedAt,
          });
          void telemetry.updateLastRun({
            state: 'reviewing',
            model,
            pid: record.pid,
            stage,
            stagesCompleted: completed,
            stageHistory,
            elapsedMs: Date.now() - startedAt,
          });
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
      record.stalledOnQuota = isQuotaStallStderr(result?.stderr);
      record.stdoutBytes = typeof result?.stdout === 'string' ? Buffer.byteLength(result.stdout) : 0;
      if (stageHistory.length > 0) record.stageHistory = stageHistory;
      record.stderrBytes = typeof result?.stderr === 'string' ? Buffer.byteLength(result.stderr) : 0;
      await telemetry.record('review_attempt_finished', { ...record });
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #runModelProbe(cwd, model, telemetry, probes) {
    const startedAt = Date.now();
    const record = { model, startedAt: new Date(startedAt).toISOString() };
    probes.push(record);
    let resolvedModel;
    try {
      resolvedModel = await this.#resolveSelector(cwd, model, telemetry);
    } catch (error) {
      record.status = 1;
      record.durationMs = Date.now() - startedAt;
      record.error = error?.message ?? String(error);
      await telemetry.record('probe_finished', { ...record });
      return { status: 1, stdout: '', stderr: record.error };
    }
    if (resolvedModel !== model) record.resolvedModel = resolvedModel;
    await telemetry.record('probe_started', { ...record });
    this.#emitProgress({
      state: 'probe',
      message: 'checking model availability',
      model,
      elapsedMs: 0,
    });
    void telemetry.updateLastRun({ state: 'probing', model });
    const heartbeat = setInterval(() => this.#emitProgress({
      state: 'probe',
      message: 'checking model availability',
      model,
      elapsedMs: Date.now() - startedAt,
    }), 5_000);
    heartbeat.unref?.();
    try {
      const result = await this.#modelProbe(cwd, this.#probeTimeoutMs, model);
      record.pid = result?.pid;
      record.status = result?.status;
      record.durationMs = Date.now() - startedAt;
      await telemetry.record('probe_finished', { ...record });
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Default candidate model list for fallback retries.
   *
   * Priority:
   * 1. `OMP_REVIEW_KIT_FALLBACK_MODELS` (comma-separated) overrides the list.
   * 2. Otherwise the single role fallback `@task` — a role selector always
   *    resolves to whatever fast model the user configured, without probing
   *    the `omp models --json` catalog for arbitrary providers.
   *
   * @returns {Promise<string[]>}
   */
  static async defaultModelsProvider() {
    const explicit = process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
    if (explicit) {
      return explicit
        .split(',')
        .map((s) => s.trim())
        .filter(isRoleSelector);
    }
    return ['@task'];
  }

  /**
   * Standard OMP CLI runner using async spawn to avoid pipe buffer deadlocks.
   *
   * @param {string} prompt
   * @param {string} cwd
   * @param {number} [timeout]
   * @param {string} [model]
   * @param {{ noTools?: boolean, maxTime?: string|null, quotaStallMs?: number, quotaPollMs?: number, quotaLogDir?: string|null, onOutput?: (chunk: unknown, stream: 'stdout'|'stderr') => void, onSpawn?: (pid: number|undefined) => void, registryEnv?: string|null }} [options]
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number }>}
   */
  static defaultRunner(prompt, cwd, timeout, model, { noTools = false, maxTime, quotaStallMs, quotaPollMs = 10_000, quotaLogDir = null, onOutput, onSpawn, onStage, registryEnv } = {}) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const selectedModel = model ?? process.env.OMP_REVIEW_KIT_MODEL ?? '@smol';
      if (!isRoleSelector(selectedModel)) {
        resolve({ status: 1, stdout: '', stderr: 'Rejected non-role model selector' });
        return;
      }
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      // Read-only review child: session titles are never displayed in print
      // mode and project rules guard edits the child cannot perform (its
      // tools are task/read plus read-only specialists), so skip title
      // generation and rules discovery on every spawned session. The model
      // stays a role selector so the child resolves the user's configured
      // role itself and keeps that role's retry.fallbackChains.
      const commandArgs = ['-p', '--model', selectedModel, ...(noTools ? ['--no-tools'] : ['--tools', 'task,read']), '--no-session', '--no-title', '--no-rules'];
      const thinking = reviewThinkingLevel();
      if (thinking) commandArgs.push('--thinking', thinking);
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
        env: mergeRegistryProxyEnv(process.env, registryEnv ?? undefined),
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
      let stallKilled = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearStallTimer();
        stopQuotaPoller();
        resolve({ pid, ...result });
      };
      let timer;
      let stallTimer;
      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = undefined;
        }
      };
      let quotaPoller;
      const stopQuotaPoller = () => {
        if (quotaPoller) {
          clearInterval(quotaPoller);
          quotaPoller = undefined;
        }
      };
      const armQuotaStall = () => {
        // No stdout guard here: the stall timer itself is cleared by each
        // stdout chunk, so arming while stdout flows is harmless — the next
        // chunk cancels it. The guard made the log poller's arm call a no-op
        // after any banner, leaving mid-run stalls unbounded.
        if (!(quotaStallMs > 0) || stallTimer) return;
        const armedAt = lastStdoutAt;
        stallTimer = setTimeout(async () => {
          stallTimer = undefined;
          // stdout progress after this arming means the observed refusal
          // recovered — disarm. A persistent refusal re-arms via the next
          // stderr chunk or log-poller tick.
          if (lastStdoutAt > armedAt) return;
          stopQuotaPoller();
          // Mark BEFORE terminating: terminateProcessTree awaits the kill, and
          // the proc 'close' event can fire during that await and settle the
          // promise first — dropping the stall marker. The close handler checks
          // this flag and prepends the marker itself.
          stallKilled = true;
          await terminateProcessTree(proc);
          finish({
            status: 1,
            stdout,
            stderr: `${QUOTA_STALL_PREFIX}${quotaStallMs}ms\n` + stderr,
          });
        }, quotaStallMs);
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

      let lastStdoutAt = 0;
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        lastStdoutAt = Date.now();
        if (stdout.trim() !== '') clearStallTimer();
        onOutput?.(chunk, 'stdout');
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (containsQuotaStallSignal(stderr)) armQuotaStall();
        onOutput?.(chunk, 'stderr');
      });

      if (Number.isInteger(pid) && pid > 0) {
        let pollRunning = false;
        let lastStage;
        quotaPoller = setInterval(() => {
          if (pollRunning || settled || stallTimer) return;
          pollRunning = true;
          // Stage progress is read unconditionally so last-run.json tracks the
          // child continuously; the quota-stall log check only matters once
          // stdout has gone quiet (mid-run 429s land in the child log anyway).
          const checkQuota = quotaStallMs > 0
            && (stdout.trim() === '' || Date.now() - lastStdoutAt >= quotaStallMs);
          void Promise.all([
            checkQuota ? childLogHasQuotaSignal({ logDir: quotaLogDir, pid }) : Promise.resolve(false),
            typeof onStage === 'function' ? childLogReadStage({ logDir: quotaLogDir, pid }) : Promise.resolve(undefined),
          ])
            .then(([signalled, stageInfo]) => {
              // Post-settle guard: an in-flight tick resolving after close()
              // must not deliver stage updates — updateLastRun would regress
              // the terminal state back to 'reviewing'.
              if (settled) return;
              if (signalled) armQuotaStall();
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
        }, quotaPollMs > 0 ? quotaPollMs : 10_000);
      }


      proc.on('close', (code) => {
        if (timedOut) return;
        finish({
          status: code ?? 1,
          stdout,
          stderr: stallKilled ? `${QUOTA_STALL_PREFIX}${quotaStallMs}ms\n` + stderr : stderr,
        });
      });

      proc.on('error', (err) => {
        if (timedOut) return;
        finish({
          status: 1,
          stdout,
          stderr: `${stallKilled ? QUOTA_STALL_PREFIX + quotaStallMs + 'ms\n' : ''}${err.message || err}\n${stderr}`,
        });
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
   * Performs a minimal no-tools request to confirm that a fallback model can answer.
   *
   * @param {string} cwd
   * @param {number} timeout
   * @param {string} model
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  static defaultModelProbe(cwd, timeout, model) {
    const boundedTimeout = configuredInteger(timeout, 60_000, 1);
    return OmpCliReviewerAdapter.defaultRunner(
      'Respond with exactly READY. Do not use tools.',
      cwd,
      boundedTimeout,
      model,
      { noTools: true },
    );
  }

  /**
   * Resolves the user's OMP role map (`omp config get modelRoles --json`).
   * Best-effort: returns `{}` when the command is unavailable or slow.
   *
   * @param {string} cwd
   * @returns {Promise<Record<string, string>>}
   */
  static defaultRoleResolver(cwd) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      const commandArgs = ['config', 'get', 'modelRoles', '--json'];
      const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const args = isWindowsWrapper
        ? ['/d', '/c', 'call', command, ...commandArgs]
        : commandArgs;
      let proc;
      try {
        proc = spawn(executable, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Same stale-parent guard as the review attempt: role resolution
          // must not die on a missing PI_PROXY_* env slice.
          env: mergeRegistryProxyEnv(),
          windowsHide: true,
        });
      } catch {
        resolve({});
        return;
      }
      let stdout = '';
      let settled = false;
      const finish = (roles) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(roles);
      };
      const timer = setTimeout(async () => {
        await terminateProcessTree(proc);
        finish({});
      }, 15_000);
      timer.unref?.();
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      proc.on('close', (code) => {
        if (code !== 0) {
          finish({});
          return;
        }
        try {
          const value = JSON.parse(stdout)?.value;
          finish(value && typeof value === 'object' ? value : {});
        } catch {
          finish({});
        }
      });
      proc.on('error', () => finish({}));
    });
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
      primaryModel: this.#primaryModel,
      maxFallbacks: this.#maxFallbacks,
      probeTimeoutMs: this.#probeTimeoutMs,
      maxTime: this.#reviewMaxTime.arg,
      quotaStallMs: this.#quotaStallMs,
      effortOverride: reviewThinkingLevel(),
    });
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const primaryModel = this.#primaryModel;
    const modelsTried = [primaryModel];
    const attempts = [];
    const probes = [];
    let result = await this.#runReviewAttempt(promptText, cwd, primaryModel, telemetry, attempts, 0);
    let providerOutage = isModelProviderFailure(result);

    if (providerOutage && this.#maxFallbacks > 0) {
      let fallbackModels = [];
      try {
        fallbackModels = await this.#modelsProvider(this.#probeTimeoutMs);
      } catch {
        fallbackModels = [];
      }

      const candidates = Array.isArray(fallbackModels)
        ? fallbackModels
          .filter((model) => typeof model === 'string' && model.length > 0 && model !== primaryModel)
          .filter((model, index, models) => models.indexOf(model) === index)
        : [];
      let reviewAttempts = 0;

      for (const model of candidates) {
        if (reviewAttempts >= this.#maxFallbacks) break;
        modelsTried.push(model);
        let probeResult;
        try {
          probeResult = await this.#runModelProbe(cwd, model, telemetry, probes);
        } catch (error) {
          probeResult = { status: 1, stdout: '', stderr: error?.message ?? String(error) };
          const probeRecord = probes.at(-1);
          if (probeRecord) {
            probeRecord.status = 1;
            probeRecord.error = error?.message ?? String(error);
            probeRecord.durationMs = Date.now() - Date.parse(probeRecord.startedAt);
          }
        }
        if (probeResult?.status !== 0) {
          continue;
        }

        reviewAttempts += 1;
        result = await this.#runReviewAttempt(promptText, cwd, model, telemetry, attempts, reviewAttempts);
        providerOutage = isModelProviderFailure(result);
        if (!providerOutage) break;
      }
    }

    if (providerOutage) {
      result = {
        status: 1,
        stdout: result.stdout ?? '',
        stderr: formatProviderOutageError(modelsTried, result.stderr),
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = `${stdout}\n${sanitizeReviewerOutput(stderr)}`;

    return {
      status: result.status ?? 1,
      stdout,
      stderr,
      combined,
      modelsTried,
      attempts,
      probes,
    };
  }

  /**
   * Runs exactly one bounded no-tools re-prompt asking the same model to
   * reproduce its previous output verbatim under the verdict contract.
   * Reuses the single-shot runner path and the probe-timeout budget; never
   * probes the catalog and never falls back to another model.
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
    const model = this.#lastReviewModel ?? this.#primaryModel;
    const timeout = configuredInteger(timeoutMs, this.#probeTimeoutMs, 1);
    const startedAt = Date.now();
    const record = { model, kind: 'reemit', startedAt: new Date(startedAt).toISOString() };
    const attempts = [record];
    let resolvedModel;
    try {
      resolvedModel = await this.#resolveSelector(cwd, model, telemetry);
    } catch (error) {
      record.status = 1;
      record.durationMs = Date.now() - startedAt;
      record.stderrBytes = 0;
      record.error = error?.message ?? String(error);
      await telemetry.record('reemit_finished', { ...record });
      return { status: 1, stdout: '', stderr: record.error, attempts };
    }
    if (resolvedModel !== model) record.resolvedModel = resolvedModel;
    await telemetry.record('reemit_started', { ...record });
    void telemetry.updateLastRun({ state: 'reemitting', model });
    try {
      const result = await this.#runner(promptText, cwd, timeout, model, {
        noTools: true,
        onSpawn: (pid) => {
          record.pid = pid;
          void telemetry.updateLastRun({ state: 'reemitting', model, pid });
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
