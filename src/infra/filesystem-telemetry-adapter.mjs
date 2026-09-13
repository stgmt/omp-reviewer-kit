import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TelemetryPort } from '../application/ports.mjs';

export const REVIEW_EVENT_SCHEMA = 'review-run-event@1';
export const REVIEW_LAST_RUN_SCHEMA = 'review-last-run@1';
const LAST_RUN_THROTTLE_MS = 2_000;

/**
 * Builds the user-facing message emitted when every model in the chain failed
 * with a provider/availability error. The review produced no verdict; the
 * commit is blocked by infrastructure, not by findings.
 *
 * @param {string[]} modelsTried
 * @param {string} [lastStderr]
 * @returns {string}
 */
export function formatProviderOutageError(modelsTried, lastStderr) {
  const lines = [
    'reviewer-kit infrastructure failure: no review verdict was produced.',
    'Every configured model failed with a provider/availability error (this is an outage, not a code verdict).',
    `Models attempted: ${modelsTried.join(' -> ')}`,
    'Fix: point the fast roles at available fast models in ~/.omp/agent/config.yml',
    '  (modelRoles.smol / modelRoles.task), or set OMP_REVIEW_KIT_MODEL /',
    '  OMP_REVIEW_KIT_FALLBACK_MODELS to explicit model selectors.',
    'The detailed report and run telemetry are under audit-reports/commit-reviews/.',
  ];
  const tail = typeof lastStderr === 'string'
    ? lastStderr.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(' | ')
    : '';
  if (tail) lines.push(`Last provider error: ${tail}`);
  return `${lines.join('\n')}\n`;
}

export const NULL_RUN_TELEMETRY = Object.freeze({
  record: async () => {},
  updateLastRun: async () => {},
});

/**
 * Wraps a run telemetry sink so that throwing/rejecting sinks (custom ports,
 * injected doubles) can never change the review verdict or exit code.
 *
 * @param {unknown} sink
 * @returns {{ record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> }}
 */
export function safeRunTelemetry(sink) {
  if (!sink || typeof sink.record !== 'function' || typeof sink.updateLastRun !== 'function') {
    return NULL_RUN_TELEMETRY;
  }
  return {
    record: (type, payload) => {
      try {
        return Promise.resolve(sink.record(type, payload)).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    },
    updateLastRun: (state, opts) => {
      try {
        return Promise.resolve(sink.updateLastRun(state, opts)).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    },
  };
}

export class NullTelemetryAdapter extends TelemetryPort {
  forRun() {
    return NULL_RUN_TELEMETRY;
  }
}

/**
 * Run-scoped telemetry sink. Appends one JSONL event per record() call to
 * <reportDir>/runs.jsonl and maintains <reportDir>/last-run.json as the live
 * state channel (throttled, last-writer-wins). All failures are swallowed:
 * telemetry must never change the review verdict or exit code.
 */
export class RunTelemetry {
  #eventsFile;
  #lastRunFile;
  #runId;
  #base;
  #lastWriteAt = 0;
  #pendingWrite = Promise.resolve();

  constructor({ reportDir, runId, base }) {
    this.#eventsFile = path.join(reportDir, 'runs.jsonl');
    this.#lastRunFile = path.join(reportDir, 'last-run.json');
    this.#runId = runId;
    this.#base = base;
  }

  record(type, payload = {}) {
    const event = {
      schema: REVIEW_EVENT_SCHEMA,
      runId: this.#runId,
      type,
      at: new Date().toISOString(),
      ...payload,
    };
    return this.#enqueue(async () => {
      await mkdir(path.dirname(this.#eventsFile), { recursive: true });
      await appendFile(this.#eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  updateLastRun(state, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.#lastWriteAt < LAST_RUN_THROTTLE_MS) {
      return Promise.resolve();
    }
    this.#lastWriteAt = now;
    const doc = {
      schema: REVIEW_LAST_RUN_SCHEMA,
      runId: this.#runId,
      ...this.#base,
      updatedAt: new Date(now).toISOString(),
      ...state,
    };
    return this.#enqueue(async () => {
      await mkdir(path.dirname(this.#lastRunFile), { recursive: true });
      await writeFile(this.#lastRunFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    });
  }

  async #enqueue(operation) {
    this.#pendingWrite = this.#pendingWrite.then(operation, operation).catch(() => {});
    await this.#pendingWrite;
  }
}

export class FileSystemTelemetryAdapter extends TelemetryPort {
  #relativeDir;

  constructor(relativeDir = path.join('audit-reports', 'commit-reviews')) {
    super();
    this.#relativeDir = relativeDir;
  }

  forRun({ repoRoot, runId }) {
    if (process.env.OMP_REVIEW_KIT_TELEMETRY === '0') {
      return NULL_RUN_TELEMETRY;
    }
    const override = process.env.OMP_REVIEW_KIT_TELEMETRY_DIR;
    const reportDir = override
      ? (path.isAbsolute(override) ? override : path.join(repoRoot, override))
      : path.join(repoRoot, this.#relativeDir);
    return new RunTelemetry({
      reportDir,
      runId,
      base: { repoRoot },
    });
  }
}
