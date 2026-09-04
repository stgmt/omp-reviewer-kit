import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * ============================================================================
 * Domain Layer (DDD / OOP)
 * ============================================================================
 */

/**
 * Value Object representing a staged Git diff and its deterministic cryptographic identity.
 */
export class DiffIdentity {
  #bytes;
  #hash;

  /**
   * @param {Buffer} buffer
   */
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('DiffIdentity expects a Buffer');
    }
    this.#bytes = buffer;
    this.#hash = createHash('sha256').update(buffer).digest('hex');
  }

  static fromBuffer(buffer) {
    return new DiffIdentity(buffer);
  }

  static fromString(text) {
    return new DiffIdentity(Buffer.from(text, 'utf8'));
  }

  isEmpty() {
    return this.#bytes.length === 0;
  }

  get hash() {
    return this.#hash;
  }

  get bytes() {
    return this.#bytes;
  }

  get length() {
    return this.#bytes.length;
  }
}

const RESULT_LINE_RE = /^REVIEW_RESULT=(PASS|BLOCK)$/gm;

/**
 * Domain Value Object encapsulating the review verdict and fail-closed validation rules.
 */
export class ReviewVerdict {
  static PASS = 'PASS';
  static BLOCK = 'BLOCK';

  #value;
  #reason;
  #rawOutput;

  /**
   * @param {'PASS'|'BLOCK'} value
   * @param {{ reason?: string, rawOutput?: string }} [meta]
   */
  constructor(value, { reason = '', rawOutput = '' } = {}) {
    if (value !== ReviewVerdict.PASS && value !== ReviewVerdict.BLOCK) {
      throw new Error(`Invalid ReviewVerdict value: ${value}`);
    }
    this.#value = value;
    this.#reason = reason;
    this.#rawOutput = rawOutput;
  }

  /**
   * Evaluates raw reviewer process output and derives a verdict.
   * Fail-closed invariant: only exactly one REVIEW_RESULT=PASS line yields a PASS verdict.
   * Any missing, multiple, or malformed markers strictly yield BLOCK.
   *
   * @param {string} output
   * @returns {ReviewVerdict}
   */
  static fromOutput(output) {
    if (typeof output !== 'string') {
      return new ReviewVerdict(ReviewVerdict.BLOCK, {
        reason: 'non_string_output',
        rawOutput: String(output ?? ''),
      });
    }

    const matches = [...output.matchAll(RESULT_LINE_RE)];
    if (matches.length === 1) {
      const parsedValue = matches[0][1];
      return new ReviewVerdict(parsedValue, {
        reason: parsedValue === ReviewVerdict.PASS ? 'verified' : 'explicit_block',
        rawOutput: output,
      });
    }

    if (matches.length === 0) {
      return new ReviewVerdict(ReviewVerdict.BLOCK, {
        reason: 'missing_verdict_marker',
        rawOutput: output,
      });
    }

    return new ReviewVerdict(ReviewVerdict.BLOCK, {
      reason: 'multiple_verdict_markers',
      rawOutput: output,
    });
  }

  static blockDueToFailure(errorDetails) {
    return new ReviewVerdict(ReviewVerdict.BLOCK, {
      reason: 'execution_failure',
      rawOutput: errorDetails,
    });
  }

  isPass() {
    return this.#value === ReviewVerdict.PASS;
  }

  isBlock() {
    return this.#value === ReviewVerdict.BLOCK;
  }

  get value() {
    return this.#value;
  }

  get reason() {
    return this.#reason;
  }

  get rawOutput() {
    return this.#rawOutput;
  }
}

/**
 * Domain specification and builder for reviewer agent prompt instructions.
 */
export class ReviewPrompt {
  #diffHash;

  constructor(diffHash) {
    if (!diffHash || typeof diffHash !== 'string') {
      throw new TypeError('ReviewPrompt requires a non-empty diff hash string');
    }
    this.#diffHash = diffHash;
  }

  static forDiff(target) {
    const hash = target instanceof DiffIdentity ? target.hash : target;
    return new ReviewPrompt(hash);
  }

  toString() {
    return [
      'You are the OMP headless review dispatcher.',
      'Run exactly one native task with agent "reviewer-kit".',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project review skills discovered by OMP.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'The task must return its complete report and finish with exactly REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK.',
      `The staged diff hash for this hook invocation is ${this.#diffHash}.`,
    ].join('\n');
  }

  get diffHash() {
    return this.#diffHash;
  }
}

/**
 * Domain Entity representing an audit report artifact.
 */
export class ReviewReport {
  #diffHash;
  #verdict;
  #rawOutput;
  #timestamp;

  constructor({ diffIdentity, verdict, rawOutput = '', timestamp = new Date() }) {
    this.#diffHash = diffIdentity instanceof DiffIdentity ? diffIdentity.hash : String(diffIdentity);
    this.#verdict = verdict instanceof ReviewVerdict ? verdict.value : String(verdict);
    this.#rawOutput = rawOutput;
    this.#timestamp = timestamp instanceof Date ? timestamp : new Date(timestamp);
  }

  static formatTimestamp(date) {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  get filename() {
    const stamp = ReviewReport.formatTimestamp(this.#timestamp);
    return `${stamp}-${this.#diffHash}.md`;
  }

  toMarkdown() {
    return [
      '# OMP Review Kit commit review',
      '',
      `- staged diff hash: ${this.#diffHash}`,
      `- result: ${this.#verdict}`,
      '',
      this.#rawOutput.trim(),
      '',
    ].join('\n');
  }

  get diffHash() {
    return this.#diffHash;
  }

  get verdict() {
    return this.#verdict;
  }

  get rawOutput() {
    return this.#rawOutput;
  }

  get timestamp() {
    return this.#timestamp;
  }
}

/**
 * Value Object representing the final outcome of the review workflow execution.
 */
export class ReviewExecutionResult {
  #exitCode;
  #skipped;
  #verdict;
  #reportPath;
  #details;

  constructor({ exitCode, skipped, verdict, reportPath, details }) {
    this.#exitCode = exitCode;
    this.#skipped = skipped;
    this.#verdict = verdict;
    this.#reportPath = reportPath;
    this.#details = details;
  }

  static skipped() {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: true,
    });
  }

  static pass(reportPath, verdict = 'PASS') {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: false,
      verdict,
      reportPath,
    });
  }

  static block(reportPath, details = '') {
    return new ReviewExecutionResult({
      exitCode: 1,
      skipped: false,
      verdict: 'BLOCK',
      reportPath,
      details,
    });
  }

  get exitCode() {
    return this.#exitCode;
  }

  get skipped() {
    return this.#skipped;
  }

  get verdict() {
    return this.#verdict;
  }

  get reportPath() {
    return this.#reportPath;
  }

  get details() {
    return this.#details;
  }

  toJSON() {
    const obj = {
      exitCode: this.#exitCode,
      skipped: this.#skipped,
    };
    if (this.#verdict !== undefined) obj.verdict = this.#verdict;
    if (this.#reportPath !== undefined) obj.reportPath = this.#reportPath;
    return obj;
  }
}

/**
 * ============================================================================
 * Application & Ports Layer (SOLID)
 * ============================================================================
 */

export class GitPort {
  getRepoRoot(cwd) {
    throw new Error('GitPort.getRepoRoot must be implemented');
  }

  getStagedDiff(repoRoot) {
    throw new Error('GitPort.getStagedDiff must be implemented');
  }
}

export class ReviewerPort {
  executeReview(params) {
    throw new Error('ReviewerPort.executeReview must be implemented');
  }
}

export class ReportStorePort {
  saveReport(repoRoot, report) {
    throw new Error('ReportStorePort.saveReport must be implemented');
  }
}

/**
 * Application Orchestrator Service implementing the staged code review lifecycle use case.
 */
export class ReviewWorkflowService {
  #gitPort;
  #reviewerPort;
  #reportStorePort;
  #clock;
  #logger;

  constructor({
    gitPort,
    reviewerPort,
    reportStorePort,
    clock = () => new Date(),
    logger = {
      log: (msg) => process.stdout.write(msg),
      error: (msg) => process.stderr.write(msg),
    },
  }) {
    if (!gitPort) throw new TypeError('ReviewWorkflowService requires gitPort');
    if (!reviewerPort) throw new TypeError('ReviewWorkflowService requires reviewerPort');
    if (!reportStorePort) throw new TypeError('ReviewWorkflowService requires reportStorePort');

    this.#gitPort = gitPort;
    this.#reviewerPort = reviewerPort;
    this.#reportStorePort = reportStorePort;
    this.#clock = clock;
    this.#logger = logger;
  }

  async execute({ cwd = process.cwd(), timeoutMs } = {}) {
    const repoRoot = (await this.#gitPort.getRepoRoot(cwd)).trim();
    const diff = await this.#gitPort.getStagedDiff(repoRoot);

    if (diff.isEmpty()) {
      return ReviewExecutionResult.skipped();
    }

    const prompt = ReviewPrompt.forDiff(diff);
    const execResult = await this.#reviewerPort.executeReview({
      prompt,
      cwd: repoRoot,
      timeoutMs,
    });

    const combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;

    const verdict = execResult.status === 0
      ? ReviewVerdict.fromOutput(combinedOutput)
      : ReviewVerdict.blockDueToFailure(execResult.stderr || 'reviewer process exited with non-zero status');

    const report = new ReviewReport({
      diffIdentity: diff,
      verdict,
      rawOutput: combinedOutput,
      timestamp: this.#clock(),
    });

    const reportPath = await this.#reportStorePort.saveReport(repoRoot, report);

    if (execResult.status === 0 && verdict.isPass()) {
      this.#logger.log(`reviewer-kit PASS: ${reportPath}\n`);
      return ReviewExecutionResult.pass(reportPath, verdict.value);
    }

    this.#logger.error(`reviewer-kit BLOCK: ${reportPath}\n`);
    if (combinedOutput.trim()) {
      this.#logger.error(`${combinedOutput.trim()}\n`);
    }

    return ReviewExecutionResult.block(reportPath, combinedOutput.trim());
  }
}

/**
 * ============================================================================
 * Infrastructure Layer (Adapters)
 * ============================================================================
 */

export class SubprocessGitAdapter extends GitPort {
  #runner;

  constructor(runner) {
    super();
    this.#runner = runner ?? SubprocessGitAdapter.defaultRunner;
  }

  static defaultRunner(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: null, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr ?? Buffer.from('git command failed')).toString().trim());
    }
    return result.stdout ?? Buffer.alloc(0);
  }

  getRepoRoot(cwd) {
    const output = this.#runner(['rev-parse', '--show-toplevel'], cwd);
    return output.toString('utf8').trim();
  }

  getStagedDiff(repoRoot) {
    const output = this.#runner(['diff', '--cached', '--binary', '--no-ext-diff', '--'], repoRoot);
    return DiffIdentity.fromBuffer(output);
  }
}

export class OmpCliReviewerAdapter extends ReviewerPort {
  #runner;
  #defaultTimeoutMs;

  constructor({
    runner,
    defaultTimeoutMs = process.env.OMP_REVIEW_KIT_TIMEOUT_MS
      ? parseInt(process.env.OMP_REVIEW_KIT_TIMEOUT_MS, 10)
      : 600_000,
  } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  static defaultRunner(prompt, cwd, timeout) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const commandArgs = ['-p', '--model', '@slow', '--no-session'];
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const args = isWindowsWrapper
        ? ['/d', '/c', 'call', command, ...commandArgs]
        : commandArgs;

      const proc = spawn(executable, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer;

      if (timeout && timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
        }, timeout);
      }

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          status: timedOut ? 1 : (code ?? 1),
          stdout,
          stderr: timedOut ? `Review timed out after ${timeout}ms\n${stderr}` : stderr,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          status: 1,
          stdout,
          stderr: `${err.message || err}\n${stderr}`,
        });
      });

      // Guard against EPIPE if process terminates before reading stdin
      proc.stdin.on('error', () => {});
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch {
        // Ignore write failures on closed streams
      }
    });
  }

  async executeReview({ prompt, cwd, timeoutMs }) {
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const timeout = timeoutMs ?? this.#defaultTimeoutMs;
    const result = await this.#runner(promptText, cwd, timeout);

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = `${stdout}\n${stderr}`;

    return {
      status: result.status ?? 1,
      stdout,
      stderr,
      combined,
    };
  }
}

export class FileSystemReportStoreAdapter extends ReportStorePort {
  #relativeDir;

  constructor(relativeDir = path.join('audit-reports', 'commit-reviews')) {
    super();
    this.#relativeDir = relativeDir;
  }

  async saveReport(repoRoot, report) {
    const reportDir = path.join(repoRoot, this.#relativeDir);
    await mkdir(reportDir, { recursive: true });

    const reportPath = path.join(reportDir, report.filename);
    await writeFile(reportPath, report.toMarkdown(), 'utf8');

    return reportPath;
  }
}

/**
 * ============================================================================
 * Public Facade / Composition Root
 * ============================================================================
 */

export function createReviewWorkflowService({ git, omp, clock, logger } = {}) {
  const gitPort = new SubprocessGitAdapter(git);
  const reviewerPort = new OmpCliReviewerAdapter({ runner: omp });
  const reportStorePort = new FileSystemReportStoreAdapter();

  return new ReviewWorkflowService({
    gitPort,
    reviewerPort,
    reportStorePort,
    clock,
    logger,
  });
}

/**
 * Public facade maintaining backward compatibility with existing Git pre-commit hooks and tests.
 *
 * @param {{
 *   cwd?: string,
 *   git?: (args: string[], cwd: string) => Buffer,
 *   omp?: (prompt: string, cwd: string, timeoutMs?: number) => { status: number, stdout?: string, stderr?: string },
 *   now?: Date,
 * }} [options]
 * @returns {Promise<{ exitCode: number, skipped: boolean, verdict?: 'PASS'|'BLOCK', reportPath?: string }>}
 */
export async function runReview({
  cwd = process.cwd(),
  git,
  omp,
  now = new Date(),
  logger,
} = {}) {
  const service = createReviewWorkflowService({
    git,
    omp,
    clock: () => now,
    logger,
  });

  const result = await service.execute({ cwd });
  return result.toJSON();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runReview();
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`reviewer-kit BLOCK: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
