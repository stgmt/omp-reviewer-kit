import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { TelemetryPort } from '../application/ports.mjs';

export const REVIEW_EVENT_SCHEMA = 'review-run-event@1';
export const REVIEW_LAST_RUN_SCHEMA = 'review-last-run@1';
const LAST_RUN_THROTTLE_MS = 2_000;
export const REVIEW_RUN_RECORD_SCHEMA = 'review-run-record@1';
const RUN_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_RECORD_PRUNE_LIMIT = 2_000;
/** States that never change again: a record in one of them has finished. */
export const TERMINAL_RUN_STATES = new Set(['passed', 'blocked', 'failed', 'skipped', 'interrupted']);

/**
 * Non-terminal last-run states: a live run must keep the recorded pid alive.
 * Kept in sync with LIVE_LAST_RUN_STATES in application/installer-service.mjs.
 */
const LIVE_LAST_RUN_STATES = new Set([
  'started',
  'executing',
  'reviewing',
  'working',
  'response',
  'probe',
  'probing',
  'reemitting',
]);

/**
 * Signal-0 liveness probe used by the stale last-run sweep. Mirrors
 * checkProcessLiveness in application/installer-service.mjs (that service
 * imports this adapter, so the duplicate stays local to avoid a cycle).
 *
 * @param {number} pid
 * @returns {'alive'|'dead'|'unknown'}
 */
export function pidLiveness(pid) {
  if (!Number.isInteger(pid)) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err?.code === 'ESRCH') return 'dead';
    if (err?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Builds the user-facing message emitted when OMP could not reach a model
 * (health call or review run). The review produced no verdict; the commit is
 * blocked by infrastructure, not by findings.
 *
 * @param {string} [lastStderr]
 * @returns {string}
 */
export function formatProviderOutageError(lastStderr) {
  const lines = [
    'reviewer-kit infrastructure failure: no review verdict was produced.',
    'OMP could not get an answer from a model (this is an outage or a configuration problem, not a code verdict).',
    'Fix: reviewer-kit does not choose models. Check the login and the default model role in OMP itself,',
    '  and configure fallbacks there (modelRoles / retry.fallbackChains in ~/.omp/agent/config.yml).',
    'The detailed report and run telemetry are under audit-reports/commit-reviews/.',
  ];
  const tail = typeof lastStderr === 'string'
    ? lastStderr.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(' | ')
    : '';
  if (tail) lines.push(`Last provider error: ${tail}`);
  return `${lines.join('\n')}\n`;
}

export const NULL_RUN_TELEMETRY = Object.freeze({
  recorded: false,
  record: async () => {},
  updateLastRun: async () => {},
});

/**
 * Wraps a run telemetry sink so that throwing/rejecting sinks (custom ports,
 * injected doubles) can never change the review verdict or exit code.
 *
 * @param {unknown} sink
 * @returns {{ recorded: boolean, record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> }}
 */
export function safeRunTelemetry(sink) {
  if (!sink || typeof sink.record !== 'function' || typeof sink.updateLastRun !== 'function') {
    return NULL_RUN_TELEMETRY;
  }
  // Read on every access, not copied once: a run record written after this wrapper exists must count.
  // Only the null sink reports recorded: false; a sink that does not report it counts as recorded.
  return {
    get recorded() {
      return sink.recorded !== false;
    },
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

// `d:runs` names a folder of drive D's current directory, not of home, so it has no fixed location.
const DRIVE_RELATIVE_OVERRIDE = /^[A-Za-z]:(?![\\/])/;

/**
 * Per-run records live outside any repository, so `review-progress` can list
 * every run of every session at once. Overridable for tests and sandboxes. A
 * relative override is resolved against the home directory, never the working
 * directory: the hook and `review-progress` run from different folders and must
 * still agree on one place. A drive-relative override falls back to the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveRunsDir(env = process.env, home = homedir()) {
  const override = typeof env.OMP_REVIEW_KIT_RUNS_DIR === 'string' ? env.OMP_REVIEW_KIT_RUNS_DIR.trim() : '';
  if (!override || DRIVE_RELATIVE_OVERRIDE.test(override)) return path.join(home, '.omp', 'review-kit-runs');
  return path.resolve(home, override);
}

/**
 * Session tag exported by the Claude Code SessionStart hook as
 * `OMP_REVIEW_KIT_RUN_TAG`. Anything that is not a plain token is dropped.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function runTagFromEnv(env = process.env) {
  const raw = typeof env.OMP_REVIEW_KIT_RUN_TAG === 'string' ? env.OMP_REVIEW_KIT_RUN_TAG.trim() : '';
  return /^[A-Za-z0-9._:-]{1,200}$/.test(raw) ? raw : null;
}

/**
 * Run-scoped telemetry sink. Appends one JSONL event per record() call to
 * <reportDir>/runs.jsonl and maintains <reportDir>/last-run.json as the live
 * state channel (throttled, last-writer-wins), plus this run's own record in
 * the runs directory (see resolveRunsDir). All failures are swallowed: telemetry
 * must never change the review verdict or exit code.
 */
export class RunTelemetry {
  #eventsFile;
  #lastRunFile;
  #runRecordFile;
  #runId;
  #doc;
  #lastWriteAt = 0;
  #pendingWrite = Promise.resolve();
  #recordWritten = false;

  constructor({ reportDir, runsDir = null, runId, base }) {
    this.#eventsFile = path.join(reportDir, 'runs.jsonl');
    this.#lastRunFile = path.join(reportDir, 'last-run.json');
    this.#runRecordFile = runsDir ? path.join(runsDir, `${runId}.json`) : null;
    this.#runId = runId;
    // The state document of this run, merged field by field (see updateLastRun).
    this.#doc = { runId, ...base };
    // A previous run that died without a finish event leaves last-run.json
    // stuck in a live state forever — readers then keep showing "reviewing".
    // Tombstone it before this run's own writes land (state:'started' would
    // otherwise clobber the evidence).
    this.#pendingWrite = this.#pendingWrite
      .then(() => this.#sweepStaleLastRun())
      .then(() => this.#pruneRunRecords(runsDir))
      .catch(() => {});
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
  /**
   * Drops per-run records that can no longer matter: finished ones, and
   * abandoned ones (runner gone) past the retention window. A live record is
   * never removed, whatever its age.
   */
  async #pruneRunRecords(runsDir) {
    if (!runsDir) return;
    let names;
    try {
      names = await readdir(runsDir);
    } catch {
      return; // No runs directory yet: nothing to prune.
    }
    const cutoff = Date.now() - RUN_RECORD_RETENTION_MS;
    for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, RUN_RECORD_PRUNE_LIMIT)) {
      const file = path.join(runsDir, name);
      try {
        if ((await stat(file)).mtimeMs > cutoff) continue;
        const record = JSON.parse(await readFile(file, 'utf8'));
        // Only kit run records are removed: a foreign JSON file in the runs folder is never ours to delete.
        const isKitRecord = record?.schema === REVIEW_RUN_RECORD_SCHEMA && typeof record.runId === 'string';
        if (isKitRecord && (TERMINAL_RUN_STATES.has(record.state) || pidLiveness(record.runnerPid) === 'dead')) {
          await rm(file, { force: true });
        }
      } catch {
        // Unreadable, or racing with another run: a later sweep decides.
      }
    }
  }

  async #sweepStaleLastRun() {
    let previous;
    try {
      previous = JSON.parse(await readFile(this.#lastRunFile, 'utf8'));
    } catch {
      return; // Missing or corrupt: nothing to tombstone.
    }
    if (
      !previous ||
      typeof previous !== 'object' ||
      previous.runId === this.#runId ||
      !LIVE_LAST_RUN_STATES.has(previous.state) ||
      pidLiveness(Number.isInteger(previous.runnerPid) ? previous.runnerPid : previous.pid) !== 'dead'
    ) {
      return;
    }
    const detail = 'review process gone; no finish event recorded';
    await mkdir(path.dirname(this.#eventsFile), { recursive: true });
    await appendFile(this.#eventsFile, `${JSON.stringify({
      schema: REVIEW_EVENT_SCHEMA,
      runId: previous.runId,
      type: 'run_abandoned',
      at: new Date().toISOString(),
      pid: previous.pid,
      state: previous.state,
      error: detail,
    })}\n`, 'utf8');
    await writeFile(this.#lastRunFile, `${JSON.stringify({
      ...previous,
      state: 'interrupted',
      error: previous.error ?? detail,
      message: previous.message ?? detail,
      abandonedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  }

  /** True once this run's own record is on disk: the only record review-progress can follow. */
  get recorded() {
    return this.#recordWritten;
  }

  updateLastRun(state, { force = false } = {}) {
    const now = Date.now();
    // Merge, never replace: a field this update leaves out keeps its last value,
    // so a heartbeat cannot erase the stage that an earlier write recorded.
    Object.assign(this.#doc, state);
    if (!force && now - this.#lastWriteAt < LAST_RUN_THROTTLE_MS) {
      return Promise.resolve();
    }
    this.#lastWriteAt = now;
    const doc = {
      ...this.#doc,
      schema: REVIEW_LAST_RUN_SCHEMA,
      updatedAt: new Date(now).toISOString(),
    };
    return this.#enqueue(async () => {
      if (this.#runRecordFile) {
        // The per-run record is what review-progress reads. A failure there must
        // not stop the pointer file below, and the other way round.
        await mkdir(path.dirname(this.#runRecordFile), { recursive: true }).catch(() => {});
        const written = await writeFile(this.#runRecordFile, `${JSON.stringify({ ...doc, schema: REVIEW_RUN_RECORD_SCHEMA }, null, 2)}\n`, 'utf8')
          .then(() => true, () => false);
        // Sticky: a later failed write does not hide a record that is already on disk.
        if (written) this.#recordWritten = true;
      }
      await mkdir(path.dirname(this.#lastRunFile), { recursive: true });
      await writeFile(this.#lastRunFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    });
  }

  async #enqueue(operation) {
    this.#pendingWrite = this.#pendingWrite.then(operation, operation).catch(() => {});
    await this.#pendingWrite;
  }
}

/** Repository roots may differ in case between sessions on Windows, so they are compared resolved. */
function sameRepoRoot(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const key = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return key(left) === key(right);
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
      runsDir: resolveRunsDir(),
      runId,
      base: { repoRoot, runnerPid: process.pid, tag: runTagFromEnv() },
    });
  }

  /**
   * Live runs of the same repository other than `runId`. A run is live while its
   * state is non-terminal and its runner process is not dead. Unreadable records
   * are skipped: the count only informs the committer and never decides a verdict.
   *
   * @param {{ repoRoot: string, runId: string }} context
   * @returns {Promise<number>}
   */
  async countOtherLiveRuns({ repoRoot, runId }) {
    if (process.env.OMP_REVIEW_KIT_TELEMETRY === '0') return 0;
    const runsDir = resolveRunsDir();
    let names;
    try {
      names = await readdir(runsDir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || name === `${runId}.json`) continue;
      let record;
      try {
        record = JSON.parse(await readFile(path.join(runsDir, name), 'utf8'));
      } catch {
        continue;
      }
      if (!sameRepoRoot(record?.repoRoot, repoRoot)) continue;
      if (!LIVE_LAST_RUN_STATES.has(record.state)) continue;
      if (!Number.isInteger(record.runnerPid) || pidLiveness(record.runnerPid) === 'dead') continue;
      count += 1;
    }
    return count;
  }
}
