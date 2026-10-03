/**
 * @typedef {import('../domain/diff-identity.mjs').DiffIdentity} DiffIdentity
 * @typedef {import('../domain/review-prompt.mjs').ReviewPrompt} ReviewPrompt
 * @typedef {import('../domain/review-report.mjs').ReviewReport} ReviewReport
 * @typedef {import('../domain/staged-snapshot.mjs').StagedSnapshot} StagedSnapshot
 */

/**
 * Port representing Git VCS operations.
 *
 * @interface
 */
export class GitPort {
  /**
   * Resolves top-level repository directory.
   *
   * @param {string} cwd
   * @returns {Promise<string>|string}
   */
  getRepoRoot(cwd) {
    throw new Error('GitPort.getRepoRoot must be implemented');
  }

  /**
   * Captures strictly staged changes as a DiffIdentity.
   *
   * @param {string} repoRoot
   * @returns {Promise<DiffIdentity>|DiffIdentity}
   */
  getStagedDiff(repoRoot) {
    throw new Error('GitPort.getStagedDiff must be implemented');
  }

  /**
   * Captures the staged index as an immutable StagedSnapshot.
   *
   * @param {string} repoRoot
   * @returns {Promise<StagedSnapshot>|StagedSnapshot}
   */
  getSnapshot(repoRoot) {
    throw new Error('GitPort.getSnapshot must be implemented');
  }

  /**
   * Reads a file content from HEAD if it exists, or null.
   *
   * @param {string} repoRoot
   * @param {string} path
   * @returns {Promise<Buffer | null>|Buffer|null}
   */
  getHeadFile(repoRoot, path) {
    throw new Error('GitPort.getHeadFile must be implemented');
  }

  /**
   * Object id of the staged index tree (`git write-tree`), or null when it
   * cannot be determined (e.g. unmerged entries). Optional capability.
   *
   * @param {string} repoRoot
   * @returns {Promise<string|null>|string|null}
   */
  getIndexTree(repoRoot) {
    throw new Error('GitPort.getIndexTree must be implemented');
  }
}

/**
 * Port representing temporary storage for an immutable staged snapshot.
 *
 * @interface
 */
export class SnapshotStorePort {
  /**
   * Materializes a staged snapshot in an isolated temporary directory.
   * When artifacts are provided the implementation also writes the review
   * inputs (diff patch and changed-file manifest) under `<dir>/.review/`.
   *
   * @param {StagedSnapshot} snapshot
   * @param {{ diffBytes?: Buffer, changedPaths?: string[] }} [artifacts]
   * @returns {Promise<string>|string}
   */
  create(snapshot, artifacts) {
    throw new Error('SnapshotStorePort.create must be implemented');
  }

  /**
   * Removes a directory previously returned by create.
   *
   * @param {string} snapshotDir
   * @returns {Promise<void>|void}
   */
  remove(snapshotDir) {
    throw new Error('SnapshotStorePort.remove must be implemented');
  }
  /**
   * Optional: releases an in-use marker without deleting the directory.
   * Implementations that retain created dirs as cache entries may override;
   * callers feature-detect the method.
   *
   * @param {string} snapshotDir
   * @returns {Promise<void>|void}
   */
  async release(snapshotDir) {}
  /**
   * Optional: refreshes this process's in-use lease on a retained dir so a
   * review outliving the marker TTL keeps sweep protection. Callers
   * feature-detect the method and swallow refresh failures per tick.
   *
   * @param {string} snapshotDir
   * @returns {Promise<void>|void}
   */
  async refreshLease(snapshotDir) {}
}

/**
 * Port representing the headless OMP review execution engine.
 *
 * @interface
 */
export class ReviewerPort {
  /**
   * Executes review prompt headlessly and returns process output.
   *
   * @param {{
   *   prompt: ReviewPrompt|string,
   *   cwd: string,
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, combined: string }>|{ status: number, stdout: string, stderr: string, combined: string }}
   */
  executeReview(params) {
    throw new Error('ReviewerPort.executeReview must be implemented');
  }

  /**
   * Re-emits a completed review output verbatim through one bounded no-tools
   * re-prompt on the same model. Recovery path for exit-0 reviews that
   * produced output but no standalone REVIEW_RESULT marker.
   *
   * @param {{
   *   prompt: ReviewPrompt|string,
   *   cwd: string,
   *   timeoutMs?: number,
   *   telemetry?: object,
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number, attempts?: object[] }>}
   */
  reemitVerbatim(params) {
    throw new Error('ReviewerPort.reemitVerbatim must be implemented');
  }
}

/**
 * Port representing the audit report storage engine.
 *
 * @interface
 */
export class ReportStorePort {
  /**
   * Persists a ReviewReport artifact to durable storage and returns its filesystem path.
   *
   * @param {string} repoRoot
   * @param {ReviewReport} report
   * @returns {Promise<string>|string}
   */
  saveReport(repoRoot, report) {
    throw new Error('ReportStorePort.saveReport must be implemented');
  }
}

/**
 * Port remembering reusable PASS verdicts keyed by staged tree + diff hash.
 *
 * @interface
 */
export class VerdictCachePort {
  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string }} key
   * @returns {Promise<{ reportPath: string, at: string }|null>|{ reportPath: string, at: string }|null}
   */
  lookup(key) {
    throw new Error('VerdictCachePort.lookup must be implemented');
  }

  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string, reportPath: string }} entry
   * @returns {Promise<void>|void}
   */
  record(entry) {
    throw new Error('VerdictCachePort.record must be implemented');
  }
}

/**
 * Port representing the run telemetry sink factory.
 * A port creates a run-scoped sink per review; the sink persists observability
 * events and the live/last-run state without ever influencing the verdict.
 *
 * @interface
 */
export class TelemetryPort {
  /**
   * @param {{ repoRoot: string, runId: string }} context
   * @returns {{ record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> }}
   */
  forRun(context) {
    throw new Error('TelemetryPort.forRun must be implemented');
  }
}

/**
 * Port representing external check/test command execution.
 *
 * @interface
 */
export class ExecutionPort {
  /**
   * Executes a command within the specified working directory with bounded timeout.
   *
   * @param {{ command: string, cwd: string, timeoutMs?: number }} options
   * @returns {Promise<{ ok: true, exitCode: number, timedOut: boolean, durationMs: number, stdout: string, stderr: string } | { ok: false, error: string }>}
   */
  run({ command, cwd, timeoutMs }) {
    throw new Error('ExecutionPort.run must be implemented');
  }
}
