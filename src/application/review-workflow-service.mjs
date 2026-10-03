import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewRejectionEnvelope } from '../domain/review-rejection-envelope.mjs';
import { ReviewPrompt } from '../domain/review-prompt.mjs';
import { ReviewReport } from '../domain/review-report.mjs';
import { ReviewExecutionResult } from '../domain/review-execution-result.mjs';
import { SuspicionMap, isTestPath, DEFAULT_ASSERT_PATTERNS, DEFAULT_TEST_PATH_PATTERNS, DEFAULT_TEST_DECLARATION_PATTERNS } from '../domain/suspicion-map.mjs';
import { ExecutionEvidence } from '../domain/execution-evidence.mjs';
import { buildRevertedFiles } from '../domain/reverted-snapshot.mjs';
import { classifyChangedPaths, reviewProfileFor, riskLanesFor } from '../domain/file-class.mjs';
import { StagedSnapshot } from '../domain/staged-snapshot.mjs';
import { SubprocessExecutionAdapter, linkDependencyDirs } from '../infra/subprocess-execution-adapter.mjs';
import { configuredInteger } from '../infra/omp-cli-reviewer-adapter.mjs';
import { GitPort, ReviewerPort, ReportStorePort, SnapshotStorePort, TelemetryPort } from './ports.mjs';
import { FileSystemTelemetryAdapter, NULL_RUN_TELEMETRY, safeRunTelemetry } from '../infra/filesystem-telemetry-adapter.mjs';
import { installRunSignalGuard } from '../infra/run-signal-guard.mjs';

// Lease heartbeat period: reviews outliving the 24h marker TTL refresh
// their `.live-<pid>` marker this often, keeping sweep protection whole.
const LEASE_REFRESH_MS = 15 * 60 * 1000;

// Per-process run sequence so two concurrent execute() calls on identical
// staged content never share one runReportPath within a millisecond tick.
let REPORT_SEQ = 0;

/**
 * Renders a path for committed observability artifacts: repo-relative when
 * inside the repo, otherwise the bare basename. Absolute operator paths
 *
 * @param {string} repoRoot
 * @param {string} absolutePath
 * @returns {string}
 */
export function toCommittedPath(repoRoot, absolutePath) {
  const rel = path.relative(repoRoot, absolutePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return path.basename(absolutePath);
}

/**
 * Decides how a snapshot dir is disposed when a run ends (normally or by
 * signal): transient mkdtemp dirs are destroyed (`remove`); the deterministic
 * content-addressed reuseDir only drops the caller's lease (`release`) so a
 *
 * @param {string} snapshotDir
 * @param {string|null} reuseDir
 * @returns {'remove'|'release'}
 */
export function snapshotDirDisposition(snapshotDir, reuseDir) {
  return snapshotDir !== reuseDir ? 'remove' : 'release';
}

 /**
  * Application Orchestrator Service implementing the staged code review lifecycle use case.
  */
export class ReviewWorkflowService {
  #gitPort;
  #reviewerPort;
  #reportStorePort;
  #snapshotStorePort;
  #telemetryPort;
  #clock;
  #logger;
  #assertPatterns;
  #testPathPatterns;
  #testDeclarationPatterns;
  #executionPort;
  #execution;

  /**
   * @param {{
   *   gitPort: GitPort,
   *   reviewerPort: ReviewerPort,
   *   reportStorePort: ReportStorePort,
   *   snapshotStorePort: SnapshotStorePort,
   *   telemetryPort?: TelemetryPort,
   *   clock?: () => Date,
   *   logger?: { log: (msg: string) => void, error: (msg: string) => void }
   * }} dependencies
   */
  constructor({
    gitPort,
    reviewerPort,
    reportStorePort,
    snapshotStorePort,
    telemetryPort,
    clock = () => new Date(),
    logger = {
      log: (msg) => process.stdout.write(msg),
      error: (msg) => process.stderr.write(msg),
    },
    assertPatterns,
    testPathPatterns,
    testDeclarationPatterns,
    executionPort,
    execution = {},
  }) {
    if (!gitPort) throw new TypeError('ReviewWorkflowService requires gitPort');
    if (!reviewerPort) throw new TypeError('ReviewWorkflowService requires reviewerPort');
    if (!reportStorePort) throw new TypeError('ReviewWorkflowService requires reportStorePort');
    if (!snapshotStorePort) throw new TypeError('ReviewWorkflowService requires snapshotStorePort');

    this.#gitPort = gitPort;
    this.#reviewerPort = reviewerPort;
    this.#reportStorePort = reportStorePort;
    this.#snapshotStorePort = snapshotStorePort;
    this.#telemetryPort = telemetryPort ?? new FileSystemTelemetryAdapter();
    this.#clock = clock;
    this.#logger = logger;
    const envAssert = process.env.OMP_REVIEW_KIT_ASSERT_PATTERNS?.trim();
    const envTestPaths = process.env.OMP_REVIEW_KIT_TEST_PATH_PATTERNS?.trim();
    this.#assertPatterns = assertPatterns ?? (envAssert ? envAssert.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    this.#testPathPatterns = testPathPatterns ?? (envTestPaths ? envTestPaths.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    this.#testDeclarationPatterns = testDeclarationPatterns;

    const envExecute = process.env.OMP_REVIEW_KIT_EXECUTE === '1';
    const envCommand = process.env.OMP_REVIEW_KIT_EXECUTE_COMMAND?.trim() ?? '';
    const envTimeout = configuredInteger(process.env.OMP_REVIEW_KIT_EXECUTE_TIMEOUT_MS, 600000, 0);
    const envLinkDirs = process.env.OMP_REVIEW_KIT_EXECUTE_LINK_DIRS
      ? process.env.OMP_REVIEW_KIT_EXECUTE_LINK_DIRS.split(',').map((s) => s.trim()).filter(Boolean)
      : ['node_modules', '.venv', 'venv'];
    const envRedProof = process.env.OMP_REVIEW_KIT_RED_PROOF === '1';

    const execEnabled = execution.enabled ?? envExecute;
    const execCommand = execution.command ?? envCommand;

    this.#executionPort = executionPort ?? ((execEnabled || execCommand) ? new SubprocessExecutionAdapter() : null);
    this.#execution = {
      enabled: execEnabled,
      command: execCommand,
      timeoutMs: execution.timeoutMs ?? envTimeout,
      linkDirs: execution.linkDirs ?? envLinkDirs,
      redProof: execution.redProof ?? envRedProof,
    };
  }

  /**
   * Executes the complete review lifecycle.
   *
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<ReviewExecutionResult>}
   */
  async execute({ cwd = process.cwd() } = {}) {
    const startedAt = Date.now();
    const repoRoot = (await this.#gitPort.getRepoRoot(cwd)).trim();
    const diff = await this.#gitPort.getStagedDiff(repoRoot);

    const runStamp = ReviewReport.formatTimestamp(new Date(startedAt));
    const runId = diff.isEmpty() ? `${runStamp}-skipped` : `${runStamp}-${diff.hash.slice(0, 12)}`;
    // Durable per-run report copy: the dispatcher falls back to it when the
    // agent URI is unreadable. It lives OUTSIDE the shared content-addressed
    // snapshot dir (run-unique, not diff-addressed) so concurrent reviews
    // on identical staged content never share, delete, or overwrite each
    // other's fallback — the cache dir stays read-only for the run lifetime.
    // Name: runId(timestamp+hash) + per-process seq + random nonce + pid
    // tail. The nonce makes the path unpredictable to same-user processes
    // (a predictable name can be pre-created as a planted PASS report the
    // dispatcher would reproduce verbatim); the pid tail feeds the
    // orphan-sweep owner check (`-<pid>.md$`).
    const runReportPath = path.join(tmpdir(), `reviewer-kit-report-${runId}-${REPORT_SEQ++}-${randomBytes(8).toString('hex')}-${process.pid}.md`);
    let telemetry;
    try {
      telemetry = safeRunTelemetry(this.#telemetryPort.forRun({ repoRoot, runId }));
    } catch {
      telemetry = NULL_RUN_TELEMETRY;
    }
    // Snapshot dirs created during this run; the signal guard removes them
    // before exit() since the finally blocks below never run on SIGINT/SIGTERM.
    // Transient mkdtemp dirs are destroyed; the deterministic content-addressed
    // reuseDir only drops this process's `.live-<pid>` lease (release) so a
    // concurrent review serving from it — or a later retry — keeps its input.
    const transientSnapshotDirs = new Set();
    let retainedSnapshotDir = null;
    let clearLeaseTimer = async () => {};
    const cleanupSnapshots = async () => {
      await clearLeaseTimer();
      for (const dir of transientSnapshotDirs) {
        await this.#snapshotStorePort.remove(dir).catch(() => {});
      }
      if (retainedSnapshotDir && typeof this.#snapshotStorePort.release === 'function') {
        // A tampered lease marker must not vanish silently: the adapter
        // throws on non-regular markers to surface mid-run tampering —
        // record it before swallowing the cleanup-path rejection.
        await this.#snapshotStorePort.release(retainedSnapshotDir).catch(async (error) => {
          await telemetry.record('snapshot_release_failed', {
            dir: retainedSnapshotDir,
            error: String(error?.message ?? error),
          }).catch(() => {});
        });
      }
      await rm(runReportPath, { force: true }).catch(() => {});
    };
    const uninstall = installRunSignalGuard({ telemetry, runId, cleanup: cleanupSnapshots });
    await telemetry.updateLastRun({
      state: 'started',
      runId,
      repoRoot,
      startedAt: new Date(startedAt).toISOString(),
    }, { force: true });

    try {
      await telemetry.record('run_started', {
        cwd,
        repoRoot,
        node: process.version,
        platform: process.platform,
      });

      if (diff.isEmpty()) {
        await telemetry.record('run_skipped', { reason: 'no staged changes' });
        await telemetry.updateLastRun({
          state: 'skipped',
          verdict: 'SKIPPED',
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        }, { force: true });
        return ReviewExecutionResult.skipped();
      }

      await telemetry.record('diff_collected', {
        diffHash: diff.hash,
        diffBytes: diff.length,
      });

      const suspicionMap = SuspicionMap.compute({
        diffBytes: diff.bytes,
        assertPatterns: this.#assertPatterns,
        testPathPatterns: this.#testPathPatterns,
        testDeclarationPatterns: this.#testDeclarationPatterns,
      });

      await telemetry.record('suspicion_map_computed', {
        entries: suspicionMap.entries.length,
        assertDelta: suspicionMap.entries.filter((e) => e.kind === 'assert_delta').length,
        deletedTestFiles: suspicionMap.entries.filter((e) => e.kind === 'deleted_test_file').length,
        removedTestDeclarations: suspicionMap.entries.filter((e) => e.kind === 'removed_test_declarations').length,
      });

      const snapshotStartedAt = Date.now();
      const snapshot = await this.#gitPort.getSnapshot(repoRoot);
      const fileClasses = classifyChangedPaths(
        diff.changedPaths,
        (p) => isTestPath(p, this.#testPathPatterns),
        new Map(snapshot.files.map((f) => [f.path, f.mode])),
      );
      const shaByPath = new Map(
        snapshot.files.map((f) => [f.path, createHash('sha256').update(f.content).digest('hex')]),
      );
      const fileClassRows = fileClasses.map((entry) => ({
        ...entry,
        sha256: shaByPath.get(entry.path) ?? null,
      }));
      // Resolve the profile + lanes BEFORE any lease is claimed: an invalid
      // OMP_REVIEW_KIT_LANES must fail before create() stamps a .live marker,
      // otherwise the throw leaks a foreign-live lease for its 24h TTL.
      const reviewProfile = reviewProfileFor(fileClasses);
      const riskLanes = riskLanesFor(reviewProfile, process.env);
      const reuseDir = path.join(tmpdir(), `reviewer-kit-snapshot-${diff.hash.slice(0, 24)}`);
      const snapshotDir = await this.#snapshotStorePort.create(snapshot, {
        diffBytes: diff.bytes,
        changedPaths: diff.changedPaths,
        fileClasses: fileClassRows,
        reuseDir,
      });
      if (snapshotDir !== reuseDir) {
        transientSnapshotDirs.add(snapshotDir);
      } else {
        retainedSnapshotDir = snapshotDir;
      }
      // Lease heartbeat: reviews outliving the 24h marker TTL keep sweep
      // protection for their whole duration. Unref'd — never blocks exit;
      // cleared on every completion path and on signal cleanup.
      const storePort = this.#snapshotStorePort;
      let leaseRefresh = Promise.resolve();
      const leaseTimer = (typeof storePort.refreshLease === 'function' && typeof setInterval === 'function')
        ? setInterval(() => {
          // Ticks serialize on the chain: a second interval can never
          // interleave inside refreshLease itself.
          leaseRefresh = leaseRefresh.then(() => storePort.refreshLease(snapshotDir)).catch(() => {});
        }, LEASE_REFRESH_MS)
        : null;
      leaseTimer?.unref?.();
      clearLeaseTimer = async () => {
        clearInterval(leaseTimer);
        // Drain the in-flight tick before the caller releases: a refresh
        // still racing release() is a fire-and-forget write that could
        // re-stamp the marker on the retained dir after release() ran.
        await leaseRefresh.catch(() => {});
      };
      await telemetry.record('snapshot_materialized', {
        files: snapshot.files.length,
        bytes: snapshot.files.reduce((total, file) => total + file.content.length, 0),
        durationMs: Date.now() - snapshotStartedAt,
      });

      let executionEvidence = null;
      if (this.#execution.enabled || this.#execution.command) {
        if (!this.#execution.command) {
          executionEvidence = new ExecutionEvidence({
            command: '',
            staged: { ok: false, error: 'no command configured' },
            reverted: null,
          });
        } else if (this.#executionPort) {
          try {
            await telemetry.updateLastRun({
              state: 'executing',
              phase: 'staged',
              command: this.#execution.command,
              runId,
              repoRoot,
            }, { force: true });

            await telemetry.record('execution_started', {
              phase: 'staged',
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
            });

            const linkWarnings = await linkDependencyDirs(repoRoot, snapshotDir, this.#execution.linkDirs);
            const stagedResult = await this.#executionPort.run({
              command: this.#execution.command,
              cwd: snapshotDir,
              timeoutMs: this.#execution.timeoutMs,
            });

            await telemetry.record('execution_finished', {
              phase: 'staged',
              exitCode: stagedResult.exitCode,
              timedOut: stagedResult.timedOut,
              durationMs: stagedResult.durationMs,
              stdoutBytes: Buffer.byteLength(stagedResult.stdout ?? ''),
              stderrBytes: Buffer.byteLength(stagedResult.stderr ?? ''),
            });

            let revertedResult = null;
            let revertedSkipReason = '';

            if (this.#execution.redProof && stagedResult.ok) {
              const hasTest = diff.changedPaths.some((p) => isTestPath(p, this.#testPathPatterns));
              const hasNonTest = diff.changedPaths.some((p) => !isTestPath(p, this.#testPathPatterns));

              if (hasTest && hasNonTest) {
                const headFiles = new Map();
                for (const p of diff.changedPaths) {
                  if (!isTestPath(p, this.#testPathPatterns)) {
                    headFiles.set(p, await this.#gitPort.getHeadFile(repoRoot, p));
                  }
                }

                const revertedFiles = buildRevertedFiles({
                  files: snapshot.files,
                  changedPaths: diff.changedPaths,
                  testPathPatterns: this.#testPathPatterns,
                  headFiles,
                });

                const revertedDir = await this.#snapshotStorePort.create(revertedSnapshot, {
                  artifacts: false,
                });
                transientSnapshotDirs.add(revertedDir);

                try {
                  await telemetry.updateLastRun({
                    state: 'executing',
                    phase: 'reverted',
                    command: this.#execution.command,
                    runId,
                    repoRoot,
                  }, { force: true });

                  await telemetry.record('execution_started', {
                    phase: 'reverted',
                    command: this.#execution.command,
                    timeoutMs: this.#execution.timeoutMs,
                  });

                  await linkDependencyDirs(repoRoot, revertedDir, this.#execution.linkDirs);
                  revertedResult = await this.#executionPort.run({
                    command: this.#execution.command,
                    cwd: revertedDir,
                    timeoutMs: this.#execution.timeoutMs,
                  });

                  await telemetry.record('execution_finished', {
                    phase: 'reverted',
                    exitCode: revertedResult.exitCode,
                    timedOut: revertedResult.timedOut,
                    durationMs: revertedResult.durationMs,
                    stdoutBytes: Buffer.byteLength(revertedResult.stdout ?? ''),
                    stderrBytes: Buffer.byteLength(revertedResult.stderr ?? ''),
                  });
                } finally {
                  await this.#snapshotStorePort.remove(revertedDir);
                  transientSnapshotDirs.delete(revertedDir);
                }
              } else {
                revertedSkipReason = !hasTest ? 'no test changes staged' : 'no non-test changes staged';
              }
            } else if (!this.#execution.redProof) {
              revertedSkipReason = 'red proof disabled';
            }

            executionEvidence = new ExecutionEvidence({
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
              staged: stagedResult,
              reverted: revertedResult,
              revertedSkipReason,
              warnings: linkWarnings,
            });
          } catch (err) {
            executionEvidence = new ExecutionEvidence({
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
              staged: { ok: false, error: err.message },
              reverted: null,
            });
          }
        }
      }

      let execResult;
      try {
        const prompt = ReviewPrompt.forDiff(diff, snapshotDir, diff.changedPaths, {
          suspicionMapText: suspicionMap.toPromptText(),
          executionEvidenceText: executionEvidence ? executionEvidence.toPromptText() : '',
          reviewProfile,
          riskLanes,
          fileClasses: fileClassRows,
          reportPath: runReportPath,
          // ~50KB ≈ 12K tokens — cheaper than four read round-trips per subagent.
          inlineDiff: diff.length <= 50_000 ? diff.bytes.toString('utf8') : '',
        });
        execResult = await this.#reviewerPort.executeReview({
          prompt,
          cwd: repoRoot,
          telemetry,
        });
      } finally {
        await clearLeaseTimer();
        if (snapshotDirDisposition(snapshotDir, reuseDir) === 'remove') {
          // Transient mkdtemp dirs are removed immediately; the deterministic
          // content-addressed reuseDir is left in place so a later identical
          // diff can reuse it (the adapter's retention sweep bounds its age).
          await this.#snapshotStorePort.remove(snapshotDir);
          transientSnapshotDirs.delete(snapshotDir);
        } else if (typeof this.#snapshotStorePort.release === 'function') {
          // The retained cache dir drops its in-use marker so the retention
          // sweep can prune it once this run no longer references it.
          await this.#snapshotStorePort.release(snapshotDir).catch(async (error) => {
            await telemetry.record('snapshot_release_failed', {
              dir: snapshotDir,
              error: String(error?.message ?? error),
            }).catch(() => {});
          });
        }
        // The dispatcher consumed the durable report (or never needed it);
        // remove this run's copy so per-run fallbacks never accumulate.
        await rm(runReportPath, { force: true }).catch(() => {});
      }

      let combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;
      const modelsTried = execResult.modelsTried;

      let { verdict, envelope } = ReviewRejectionEnvelope.evaluate({
        output: combinedOutput,
        diffIdentity: diff,
        processStatus: execResult.status,
        processError: execResult.stderr,
      });

      // Fail-closed verbatim re-emit recovery. Two recoverable shapes, one
      // attempt total, no tools, bounded timeout:
      //  - missing_verdict_marker: the reviewer finished but forgot the marker;
      //    the re-emit is re-evaluated in full and may yield PASS or BLOCK.
      //  - missing/malformed rejection envelope on an explicit BLOCK: only the
      //    envelope shape is repaired; the re-emit is accepted solely when it is
      //    again a BLOCK carrying a valid non-failure envelope, so a repair can
      //    never downgrade a BLOCK to PASS.
      // A failed re-emit keeps the original verdict.
      const envelopeFailureCode = envelope?.kind === 'review_failure' ? envelope.failure?.code : null;
      const markerRecovery = verdict.reason === 'missing_verdict_marker';
      const envelopeRecovery = !markerRecovery
        && (envelopeFailureCode === 'missing_rejection_envelope' || envelopeFailureCode === 'malformed_rejection_envelope');
      if (
        (markerRecovery || envelopeRecovery)
        && execResult.status === 0
        && combinedOutput.trim() !== ''
        && process.env.OMP_REVIEW_KIT_REEMIT !== '0'
      ) {
        const reemitStartedAt = Date.now();
        const originalBytes = Buffer.byteLength(combinedOutput);
        const reemitResult = await this.#reviewerPort.reemitVerbatim({
          prompt: ReviewPrompt.forReemit(combinedOutput, { repairEnvelope: envelopeRecovery }),
          cwd: repoRoot,
          telemetry,
        });
        if (Array.isArray(reemitResult?.attempts)) {
          execResult.attempts = [
            ...(Array.isArray(execResult.attempts) ? execResult.attempts : []),
            ...reemitResult.attempts,
          ];
        }
        let recovered = false;
        if (reemitResult?.status === 0) {
          const reemittedOutput = reemitResult.combined ?? `${reemitResult.stdout ?? ''}
${reemitResult.stderr ?? ''}`;
          const reevaluated = ReviewRejectionEnvelope.evaluate({
            output: reemittedOutput,
            diffIdentity: diff,
            processStatus: reemitResult.status,
            processError: reemitResult.stderr,
          });
          const accepted = markerRecovery
            ? reevaluated.verdict.reason !== 'missing_verdict_marker'
            : !reevaluated.verdict.isPass()
              && reevaluated.envelope != null
              && reevaluated.envelope.kind !== 'review_failure';
          if (markerRecovery || accepted) {
            verdict = reevaluated.verdict;
            envelope = reevaluated.envelope;
            combinedOutput = reemittedOutput;
          }
          recovered = accepted;
        }
        await telemetry.record('reemit_recovery', {
          originalBytes,
          recovered,
          mode: envelopeRecovery ? 'envelope_repair' : 'missing_marker',
          reemitStatus: reemitResult?.status ?? null,
          durationMs: Date.now() - reemitStartedAt,
        });
      }

      await telemetry.record('verdict_evaluated', {
        verdict: verdict.value,
        envelopeKind: envelope ? envelope.kind : null,
        failureCode: envelope?.failure?.code ?? null,
        findings: envelope ? envelope.findings.length : 0,
      });

      const verifiedOk = [
        'The staged index was materialized into a temporary snapshot before review.',
        'The reviewer ran from the repository root, preserving Git and project context.',
      ];
      if (execResult.status === 0) {
        verifiedOk.push('The reviewer process exited successfully and its verdict was normalized.');
      }

      const report = new ReviewReport({
        diffIdentity: diff,
        verdict,
        rawOutput: combinedOutput,
        modelsTried,
        verifiedOk,
        envelope,
        timestamp: this.#clock(),
      });

      const reportStartedAt = Date.now();
      const reportPath = await this.#reportStorePort.saveReport(repoRoot, report);
      await telemetry.record('report_written', {
        reportPath,
        durationMs: Date.now() - reportStartedAt,
      });

      const childPids = [
        ...(Array.isArray(execResult.attempts) ? execResult.attempts : []),
        ...(Array.isArray(execResult.probes) ? execResult.probes : []),
      ].map((entry) => entry?.pid).filter((pid) => Number.isInteger(pid));
      await telemetry.record('run_finished', {
        verdict: verdict.value,
        exitCode: verdict.isPass() ? 0 : 1,
        durationMs: Date.now() - startedAt,
        modelsTried,
        attemptCount: Array.isArray(execResult.attempts) ? execResult.attempts.length : 0,
        probeCount: Array.isArray(execResult.probes) ? execResult.probes.length : 0,
        ompLogHints: [...new Set(childPids)].map((pid) => `~/.omp/logs/omp.*.${pid}.log`),
      });
      await telemetry.updateLastRun({
        state: verdict.isPass() ? 'passed' : 'blocked',
        verdict: verdict.value,
        exitCode: verdict.isPass() ? 0 : 1,
        reportPath,
        durationMs: Date.now() - startedAt,
        modelsTried,
        finishedAt: new Date().toISOString(),
      }, { force: true });

      // Per-stage stats + README badge: best-effort, never gates the verdict.
      // r26 correctness-2: only the kit's own repo (or an explicit opt-in)
      // receives badge artifacts — a consumer repo under review must not
      // accumulate unrequested committable files.
      if (await this.#badgeEligible(repoRoot)) try {
        const stageHistory = (Array.isArray(execResult.attempts) ? execResult.attempts : [])
          .flatMap((a) => Array.isArray(a?.stageHistory) ? a.stageHistory : []);
        const badgeColor = verdict.isPass() ? 'brightgreen' : 'red';
        const stageParts = stageHistory.map((s) => s.stage).filter(Boolean);
        const badge = {
          schemaVersion: 1,
          label: 'review-kit',
          message: `${verdict.value} · ${Math.round((Date.now() - startedAt) / 1000)}s`,
          color: badgeColor,
        };
        await this.#writeBadge(repoRoot, {
          badge,
          runId,
          diffHash: diff.hash,
          verdict: verdict.value,
          reviewProfile,
          durationMs: Date.now() - startedAt,
          stageHistory,
          stageTrail: stageParts.join('→'),
          modelsTried,
          // Committed artifact: repo-relative, never an absolute operator
          // path (machine layout must not leak into public git history).
          reportPath: toCommittedPath(repoRoot, reportPath),
          generatedAt: new Date().toISOString(),
        });
      } catch {
        // Badge writing is observability sugar; a failure must never fail the review.
      }

      if (verdict.isPass()) {
        this.#logger.log(`reviewer-kit PASS: ${reportPath}\n`);
        return ReviewExecutionResult.pass(reportPath, verdict.value, modelsTried);
      }

      if (envelope && envelope.kind === 'review_failure' && typeof execResult.stderr === 'string') {
        const detail = execResult.stderr.trim();
        if (detail) {
          this.#logger.error(detail.split(/\r?\n/).slice(-8).join('\n') + '\n');
        }
      }
      this.#logger.error(`reviewer-kit BLOCK: ${reportPath}\n`);
      this.#logger.error(`REVIEW_REJECTION_REPORT=${reportPath}\n`);

      return ReviewExecutionResult.block(reportPath, combinedOutput.trim(), modelsTried, envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await telemetry.record('run_failed', { error: message });
      await telemetry.updateLastRun({
        state: 'failed',
        error: message,
        exitCode: 1,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      }, { force: true });
      throw error;
    } finally {
      uninstall?.();
    }
  }


  /**
   * Writes the README badge payload to `audit-reports/review-badge.json`
   * (shields.io endpoint shape) plus the richer `review-badge.full.json`
   * side-car with per-stage stats. Best-effort observability — callers wrap
   * in try/catch and never let it gate the verdict.
   */
  async #badgeEligible(repoRoot) {
    const env = process.env.OMP_REVIEW_KIT_BADGE;
    if (env === '1') return true;
    if (env === '0') return false;
    try {
      const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
      return pkg?.name === 'omp-reviewer-kit';
    } catch {
      return false;
    }
  }

  async #writeBadge(repoRoot, payload) {
    const dir = path.join(repoRoot, 'audit-reports');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'review-badge.json'),
      JSON.stringify(payload.badge, null, 2) + '\n',
      'utf8',
    );
    const { badge, ...full } = payload;
    await writeFile(
      path.join(dir, 'review-badge.full.json'),
      JSON.stringify({ schema: 'review-badge@1', ...full }, null, 2) + '\n',
      'utf8',
    );
  }
}

