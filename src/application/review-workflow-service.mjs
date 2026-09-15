import { ReviewRejectionEnvelope } from '../domain/review-rejection-envelope.mjs';
import { ReviewPrompt } from '../domain/review-prompt.mjs';
import { ReviewReport } from '../domain/review-report.mjs';
import { ReviewExecutionResult } from '../domain/review-execution-result.mjs';
import { SuspicionMap, DEFAULT_ASSERT_PATTERNS, DEFAULT_TEST_PATH_PATTERNS, DEFAULT_TEST_DECLARATION_PATTERNS } from '../domain/suspicion-map.mjs';
import { GitPort, ReviewerPort, ReportStorePort, SnapshotStorePort, TelemetryPort } from './ports.mjs';
import { FileSystemTelemetryAdapter, NULL_RUN_TELEMETRY, safeRunTelemetry } from '../infra/filesystem-telemetry-adapter.mjs';
import { installRunSignalGuard } from '../infra/run-signal-guard.mjs';

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
    let telemetry;
    try {
      telemetry = safeRunTelemetry(this.#telemetryPort.forRun({ repoRoot, runId }));
    } catch {
      telemetry = NULL_RUN_TELEMETRY;
    }
    const uninstall = installRunSignalGuard({ telemetry, runId });
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
      const snapshotDir = await this.#snapshotStorePort.create(snapshot, {
        diffBytes: diff.bytes,
        changedPaths: diff.changedPaths,
      });
      await telemetry.record('snapshot_materialized', {
        files: snapshot.files.length,
        bytes: snapshot.files.reduce((total, file) => total + file.content.length, 0),
        durationMs: Date.now() - snapshotStartedAt,
      });

      let execResult;
      try {
        const prompt = ReviewPrompt.forDiff(diff, snapshotDir, diff.changedPaths, {
          suspicionMapText: suspicionMap.toPromptText(),
        });
        execResult = await this.#reviewerPort.executeReview({
          prompt,
          cwd: repoRoot,
          telemetry,
        });
      } finally {
        await this.#snapshotStorePort.remove(snapshotDir);
      }

      let combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;
      const modelsTried = execResult.modelsTried;

      let { verdict, envelope } = ReviewRejectionEnvelope.evaluate({
        output: combinedOutput,
        diffIdentity: diff,
        processStatus: execResult.status,
        processError: execResult.stderr,
      });

      // Fail-closed verbatim re-emit recovery: when the reviewer exited cleanly
      // and produced output but no standalone verdict marker, ask the same
      // model once — with no tools and a bounded timeout — to reproduce its
      // report verbatim under the verdict contract, then re-run the full
      // envelope evaluation on the re-emitted output. A failed re-emit keeps
      // the original verdict; exactly one re-emit is ever attempted.
      if (
        verdict.reason === 'missing_verdict_marker'
        && execResult.status === 0
        && combinedOutput.trim() !== ''
        && process.env.OMP_REVIEW_KIT_REEMIT !== '0'
      ) {
        const reemitStartedAt = Date.now();
        const originalBytes = Buffer.byteLength(combinedOutput);
        const reemitResult = await this.#reviewerPort.reemitVerbatim({
          prompt: ReviewPrompt.forReemit(combinedOutput),
          cwd: repoRoot,
          telemetry,
        });
        if (Array.isArray(reemitResult?.attempts)) {
          execResult.attempts = [
            ...(Array.isArray(execResult.attempts) ? execResult.attempts : []),
            ...reemitResult.attempts,
          ];
        }
        if (reemitResult?.status === 0) {
          const reemittedOutput = reemitResult.combined ?? `${reemitResult.stdout ?? ''}\n${reemitResult.stderr ?? ''}`;
          const reevaluated = ReviewRejectionEnvelope.evaluate({
            output: reemittedOutput,
            diffIdentity: diff,
            processStatus: reemitResult.status,
            processError: reemitResult.stderr,
          });
          verdict = reevaluated.verdict;
          envelope = reevaluated.envelope;
          combinedOutput = reemittedOutput;
        }
        await telemetry.record('reemit_recovery', {
          originalBytes,
          recovered: verdict.reason !== 'missing_verdict_marker',
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
}
