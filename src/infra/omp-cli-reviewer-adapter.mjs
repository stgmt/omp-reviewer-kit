import { spawn } from 'node:child_process';
import path from 'node:path';
import { ReviewerPort } from '../application/ports.mjs';

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

  // Timeout is per-attempt; retrying would multiply wall-clock cost without
  // new signal on another model.
  if (/Review timed out after/.test(combined)) return false;

  // A provider-side refusal can be wrapped in a synthetic BLOCK marker by
  // the orchestrator when dispatch fails. Detect it before treating BLOCK as
  // a completed review.
  if (/^REVIEW_RESULT=(?:PASS|BLOCK)$/m.test(combined)) return false;

  const providerFailure = /(quota|rate ?limit|RESOURCE_EXHAUSTED|insufficient[ _-]?(?:quota|capacity|credits|balance)|model (not )?(found|available|supported)|model [^\n]{0,80}(not found|unavailable|unsupported)|no endpoints found|provider (error|unavailable)|invalid api[-_ ]?key|set an api key environment variable|upgrade your subscription|(?:status(?: code)?|error code|response code)\s*[:=]?\s*(?:401|403|429)\b[^\n]{0,30}\b(?:Unauthorized|Forbidden|Too Many Requests)\b|\b(?:401|403|429)\s*(?:Unauthorized|Forbidden|Too Many Requests)\b|(?:^|\n)\s*(?:(?:(?:error|failure|failed)\s*:?\s*)?HTTP\s+(?:401|403|429)\b|status(?: code)?\s*[:=]?\s*(?:401|403|429)\b|(?:error|response) code\s*[:=]?\s*(?:401|403|429)\b))/i.test(combined);
  if (providerFailure) return true;

  // A real verdict means the review ran; the non-zero status may be OMP
  // reporting a BLOCK exit code. Never retry that.
  return false;
}

function configuredInteger(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
function isSafeModelSelector(value) {
  return typeof value === 'string' && /^[A-Za-z0-9@._:/+-]+$/.test(value);
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
  #progress;

  /**
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number, model?: string) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   modelsProvider?: () => string[]|Promise<string[]>,
   *   primaryModel?: string,
   *   maxFallbacks?: number,
     *   modelProbe?: (cwd: string, timeoutMs: number, model: string) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   probeTimeoutMs?: number,
   *   progress?: (event: { state: string, message: string, model?: string, elapsedMs?: number }) => void
   * }} [options]
   */
  constructor({
    runner,
    modelsProvider,
    primaryModel = process.env.OMP_REVIEW_KIT_MODEL ?? '@slow',
    maxFallbacks = configuredInteger(process.env.OMP_REVIEW_KIT_MAX_FALLBACKS, 3, 0),
    modelProbe,
    probeTimeoutMs = configuredInteger(process.env.OMP_REVIEW_KIT_PROBE_TIMEOUT_MS, 60_000, 1),
    progress,
  } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    this.#modelsProvider = modelsProvider ?? OmpCliReviewerAdapter.defaultModelsProvider;
    this.#primaryModel = primaryModel;
    this.#maxFallbacks = maxFallbacks;
    this.#modelProbe = modelProbe ?? OmpCliReviewerAdapter.defaultModelProbe;
    this.#probeTimeoutMs = configuredInteger(probeTimeoutMs, 60_000, 1);
    this.#progress = progress ?? (() => {});
  }

  #emitProgress(event) {
    try {
      this.#progress(event);
    } catch {
      // Progress is observability only and must never change the review verdict.
    }
  }

  async #runReviewAttempt(promptText, cwd, model) {
    const startedAt = Date.now();
    let responseObserved = false;
    let workingSignalObserved = false;
    const emitRunning = () => this.#emitProgress({
      state: 'reviewing',
      message: 'commit hook review running; waiting for model response',
      model,
      elapsedMs: Date.now() - startedAt,
    });

    this.#emitProgress({
      state: 'reviewing',
      message: 'commit hook review started; waiting for model response',
      model,
      elapsedMs: 0,
    });
    const heartbeat = setInterval(emitRunning, 5_000);
    heartbeat.unref?.();
    try {
      return await this.#runner(promptText, cwd, undefined, model, {
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
          }
          if (stream === 'stdout' && !responseObserved && text.trim()) {
            responseObserved = true;
            this.#emitProgress({
              state: 'response',
              message: 'model response received; checking verdict',
              model,
              elapsedMs: Date.now() - startedAt,
            });
          }
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #runModelProbe(cwd, model) {
    const startedAt = Date.now();
    this.#emitProgress({
      state: 'probe',
      message: 'checking model availability',
      model,
      elapsedMs: 0,
    });
    const heartbeat = setInterval(() => this.#emitProgress({
      state: 'probe',
      message: 'checking model availability',
      model,
      elapsedMs: Date.now() - startedAt,
    }), 5_000);
    heartbeat.unref?.();
    try {
      return await this.#modelProbe(cwd, this.#probeTimeoutMs, model);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Default candidate model list for fallback retries.
   *
   * Priority:
   * 1. `OMP_REVIEW_KIT_FALLBACK_MODELS` (comma-separated) overrides the list.
   * 2. Otherwise probe the OMP model catalog and pick the cheapest advertised
   *    models first so a quota-exhausted provider can be substituted by one
   *    that is available in the same installation.
   *
   * @returns {Promise<string[]>}
   */
  static async defaultModelsProvider(timeoutMs = configuredInteger(process.env.OMP_REVIEW_KIT_PROBE_TIMEOUT_MS, 60_000, 1)) {
    timeoutMs = configuredInteger(timeoutMs, 60_000, 1);
    const explicit = process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
    if (explicit) {
      return explicit
        .split(',')
        .map((s) => s.trim())
        .filter(isSafeModelSelector);
    }

    const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
    const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
    const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;

    try {
      const output = await new Promise((resolve) => {
        const proc = spawn(executable, isWindowsWrapper
          ? ['/d', '/c', 'call', command, 'models', '--json']
          : ['models', '--json'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = timeoutMs > 0
          ? setTimeout(async () => {
            timedOut = true;
            await terminateProcessTree(proc);
            finish({ stdout, stderr: 'Model catalog timed out after ' + timeoutMs + 'ms\n' + stderr });
          }, timeoutMs)
          : undefined;
        proc.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        proc.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        proc.on('close', () => {
          if (timedOut) return;
          finish({ stdout, stderr });
        });
        proc.on('error', (err) => {
          if (timedOut) return;
          finish({ stdout, stderr: err.message || String(err) });
        });
      });

      const payload = JSON.parse(output.stdout);
      const models = Array.isArray(payload) ? payload : (payload.models ?? []);
      const byCost = (model) => {
        const cost = Number(model?.cost?.output ?? 0) + Number(model?.cost?.input ?? 0);
        return cost > 0 ? cost : 0;
      };
      const providerOf = (model) => model.provider ?? model.selector.split('/')[0];
      const seenProviders = new Set();

      return models
        .filter((model) => isSafeModelSelector(model?.selector))
        .sort((a, b) => (byCost(a) - byCost(b)) || a.selector.localeCompare(b.selector))
        .filter((model) => {
          const provider = providerOf(model);
          if (seenProviders.has(provider)) return false;
          seenProviders.add(provider);
          return true;
        })
        .slice(0, 8)
        .map((model) => model.selector);
    } catch {
      return [];
    }
  }

  /**
   * Standard OMP CLI runner using async spawn to avoid pipe buffer deadlocks.
   *
   * @param {string} prompt
   * @param {string} cwd
   * @param {number} [timeout]
   * @param {string} [model]
   * @param {{ noTools?: boolean }} [options]
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  static defaultRunner(prompt, cwd, timeout, model, { noTools = false, onOutput } = {}) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const selectedModel = model ?? process.env.OMP_REVIEW_KIT_MODEL ?? '@slow';
      if (!isSafeModelSelector(selectedModel)) {
        resolve({ status: 1, stdout: '', stderr: 'Rejected unsafe model selector' });
        return;
      }
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      const modelRoleArgs = isWindowsWrapper
        ? ['--slow', selectedModel, '--smol', selectedModel]
        : [`--slow=${selectedModel}`, `--smol=${selectedModel}`];
      const commandArgs = ['-p', '--model', selectedModel, ...modelRoleArgs, ...(noTools ? ['--no-tools'] : ['--tools', 'task,read']), '--no-session'];
      const dispatchPrompt = `${prompt}\nThe CLI already pins the active, slow, and smol model roles to ${selectedModel}. Use task calls without model, outputSchema, schemaMode, or isolated fields.`;
      const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const args = isWindowsWrapper
        ? ['/d', '/c', 'call', command, ...commandArgs]
        : commandArgs;

      const proc = spawn(executable, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let timer;

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

      proc.on('close', (code) => {
        if (timedOut) return;
        finish({
          status: code ?? 1,
          stdout,
          stderr,
        });
      });

      proc.on('error', (err) => {
        if (timedOut) return;
        finish({
          status: 1,
          stdout,
          stderr: `${err.message || err}\n${stderr}`,
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
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, combined: string, modelsTried: string[] }>}
   */
  async executeReview({ prompt, cwd }) {
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const primaryModel = this.#primaryModel;
    const modelsTried = [primaryModel];
    let result = await this.#runReviewAttempt(promptText, cwd, primaryModel);

    if (isModelProviderFailure(result) && this.#maxFallbacks > 0) {
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
      let lastProbeFailure;
      let reviewAttempts = 0;

      for (const model of candidates) {
        if (reviewAttempts >= this.#maxFallbacks) break;
        modelsTried.push(model);
        let probeResult;
        try {
          probeResult = await this.#runModelProbe(cwd, model);
        } catch (error) {
          probeResult = { status: 1, stdout: '', stderr: error?.message ?? String(error) };
        }
        if (probeResult?.status !== 0) {
          lastProbeFailure = probeResult;
          continue;
        }

        reviewAttempts += 1;
        result = await this.#runReviewAttempt(promptText, cwd, model);
        if (!isModelProviderFailure(result)) break;
      }

      if (isModelProviderFailure(result) && lastProbeFailure && candidates.length > 0
        && reviewAttempts === 0) {
        result = {
          status: 1,
          stdout: '',
          stderr: 'fallback model availability probe failed; no fallback model was available',
        };
      }
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = `${stdout}\n${stderr}`;

    return {
      status: result.status ?? 1,
      stdout,
      stderr,
      combined,
      modelsTried,
    };
  }
}
