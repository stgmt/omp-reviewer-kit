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

const ENVELOPE_SCHEMA = 'review-rejection-envelope@1';
const BEGIN_LINE = 'REVIEW_REJECTION_ENVELOPE_BEGIN';
const END_LINE = 'REVIEW_REJECTION_ENVELOPE_END';

const FAILURE_MESSAGES = Object.freeze({
  execution_failure: 'The reviewer process did not complete successfully.',
  missing_verdict_marker: 'No solitary review verdict marker was emitted.',
  multiple_verdict_markers: 'Multiple solitary review verdict markers were emitted.',
  missing_rejection_envelope: 'No rejection envelope was emitted for the BLOCK verdict.',
  malformed_rejection_envelope: 'The rejection envelope was malformed or violated its schema.',
  contradictory_rejection_envelope: 'The rejection envelope contradicted the review verdict.',
});

const TOP_LEVEL_KEYS = Object.freeze(['diff_hash', 'findings', 'kind', 'schema']);
const FAILURE_TOP_LEVEL_KEYS = Object.freeze([...TOP_LEVEL_KEYS, 'failure'].sort());
const FINDING_KEYS = Object.freeze([
  'counterexample',
  'defect_class',
  'file_path',
  'finding_id',
  'line_end',
  'line_start',
  'priority',
  'verifier_argument',
]);
const FAILURE_KEYS = Object.freeze(['code', 'message']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;

function parseStrictJson(source) {
  let index = 0;

  function fail() {
    throw new SyntaxError('Invalid JSON envelope');
  }

  function skipWhitespace() {
    while (index < source.length && /\s/.test(source[index])) index += 1;
  }

  function parseString() {
    if (source[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < source.length) {
      const current = source[index];
      if (current === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (current === '\\') {
        index += 2;
      } else {
        index += 1;
      }
    }
    fail();
  }

  function parseNumber() {
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail();
    index += match[0].length;
    return Number(match[0]);
  }

  function parseArray() {
    const value = [];
    index += 1;
    skipWhitespace();
    if (source[index] === ']') {
      index += 1;
      return value;
    }
    while (index < source.length) {
      value.push(parseValue());
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return value;
      }
      if (source[index] !== ',') fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseObject() {
    const value = {};
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (source[index] === '}') {
      index += 1;
      return value;
    }
    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) fail();
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ':') fail();
      index += 1;
      value[key] = parseValue();
      skipWhitespace();
      if (source[index] === '}') {
        index += 1;
        return value;
      }
      if (source[index] !== ',') fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseValue() {
    skipWhitespace();
    const current = source[index];
    if (current === '"') return parseString();
    if (current === '{') return parseObject();
    if (current === '[') return parseArray();
    if (source.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (source.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (source.startsWith('null', index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== source.length) fail();
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRelativeRepositoryPath(value) {
  if (!isNonEmptyString(value) || value.includes('\\') || value.startsWith('/') || WINDOWS_ABSOLUTE_RE.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function diffHashOf(diffIdentity) {
  const hash = typeof diffIdentity === 'string' ? diffIdentity : diffIdentity?.hash;
  if (!SHA256_RE.test(hash ?? '')) {
    throw new TypeError('ReviewRejectionEnvelope requires a lowercase SHA-256 diff identity');
  }
  return hash;
}

function validateFinding(finding, identifiers) {
  if (!hasExactKeys(finding, FINDING_KEYS)) return false;
  if (!isNonEmptyString(finding.finding_id) || identifiers.has(finding.finding_id)) return false;
  if (finding.priority !== 'P1' && finding.priority !== 'P2') return false;
  if (finding.defect_class !== 'correctness' && finding.defect_class !== 'security') return false;
  if (!isRelativeRepositoryPath(finding.file_path)) return false;
  if (!Number.isInteger(finding.line_start) || finding.line_start < 1) return false;
  if (!Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) return false;
  if (!isNonEmptyString(finding.verifier_argument) || !isNonEmptyString(finding.counterexample)) return false;
  identifiers.add(finding.finding_id);
  return true;
}

function validateEnvelope(value, diffHash) {
  if (!isRecord(value) || value.schema !== ENVELOPE_SCHEMA || value.diff_hash !== diffHash) return false;
  if (value.kind === 'confirmed_findings') {
    if (!hasExactKeys(value, TOP_LEVEL_KEYS) || !Array.isArray(value.findings) || value.findings.length === 0) return false;
    const identifiers = new Set();
    return value.findings.every((finding) => validateFinding(finding, identifiers));
  }
  if (value.kind === 'review_failure') {
    return hasExactKeys(value, FAILURE_TOP_LEVEL_KEYS)
      && Array.isArray(value.findings)
      && value.findings.length === 0
      && hasExactKeys(value.failure, FAILURE_KEYS)
      && Object.hasOwn(FAILURE_MESSAGES, value.failure.code)
      && value.failure.message === FAILURE_MESSAGES[value.failure.code];
  }
  return false;
}

function failureValue(diffHash, code) {
  return {
    schema: ENVELOPE_SCHEMA,
    kind: 'review_failure',
    diff_hash: diffHash,
    findings: [],
    failure: {
      code,
      message: FAILURE_MESSAGES[code],
    },
  };
}

function blockWithFailure(output, diffHash, code, verdict) {
  return {
    verdict: verdict?.reason === code
      ? verdict
      : new ReviewVerdict(ReviewVerdict.BLOCK, { reason: code, rawOutput: output }),
    envelope: new ReviewRejectionEnvelope(failureValue(diffHash, code)),
  };
}

/**
 * Domain Value Object owning strict caller-readable BLOCK normalization.
 */
export class ReviewRejectionEnvelope {
  static SCHEMA = ENVELOPE_SCHEMA;
  static BEGIN_LINE = BEGIN_LINE;
  static END_LINE = END_LINE;

  #value;

  constructor(value) {
    if (!validateEnvelope(value, value?.diff_hash)) {
      throw new TypeError('Invalid ReviewRejectionEnvelope value');
    }
    this.#value = Object.freeze({
      ...value,
      findings: Object.freeze(value.findings.map((finding) => Object.freeze({ ...finding }))),
      ...(value.failure ? { failure: Object.freeze({ ...value.failure }) } : {}),
    });
  }

  static evaluate({ output, diffIdentity, processStatus, processError }) {
    const rawOutput = typeof output === 'string' ? output : String(output ?? '');
    const diffHash = diffHashOf(diffIdentity);

    if (processStatus !== 0) {
      const verdict = ReviewVerdict.blockDueToFailure(
        isNonEmptyString(processError) ? processError : 'reviewer process exited with non-zero status',
      );
      return blockWithFailure(rawOutput, diffHash, 'execution_failure', verdict);
    }

    const verdict = ReviewVerdict.fromOutput(rawOutput);
    if (verdict.reason === 'missing_verdict_marker') {
      return blockWithFailure(rawOutput, diffHash, 'missing_verdict_marker', verdict);
    }
    if (verdict.reason === 'multiple_verdict_markers') {
      return blockWithFailure(rawOutput, diffHash, 'multiple_verdict_markers', verdict);
    }

    const lines = rawOutput.split(/\r?\n/);
    const beginIndexes = [];
    const endIndexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === BEGIN_LINE) beginIndexes.push(index);
      if (lines[index] === END_LINE) endIndexes.push(index);
    }

    if (verdict.isPass()) {
      if (beginIndexes.length > 0 || endIndexes.length > 0) {
        return blockWithFailure(rawOutput, diffHash, 'contradictory_rejection_envelope');
      }
      return { verdict, envelope: null };
    }

    if (beginIndexes.length === 0 && endIndexes.length === 0) {
      return blockWithFailure(rawOutput, diffHash, 'missing_rejection_envelope', verdict);
    }
    if (beginIndexes.length !== 1 || endIndexes.length !== 1) {
      return blockWithFailure(rawOutput, diffHash, 'malformed_rejection_envelope');
    }

    const beginIndex = beginIndexes[0];
    const endIndex = endIndexes[0];
    const blockIndex = lines.indexOf('REVIEW_RESULT=BLOCK');
    if (beginIndex >= endIndex || endIndex >= blockIndex) {
      return blockWithFailure(rawOutput, diffHash, 'contradictory_rejection_envelope');
    }

    try {
      const parsed = parseStrictJson(lines.slice(beginIndex + 1, endIndex).join('\n'));
      if (!validateEnvelope(parsed, diffHash)) {
        return blockWithFailure(rawOutput, diffHash, 'malformed_rejection_envelope');
      }
      return { verdict, envelope: new ReviewRejectionEnvelope(parsed) };
    } catch {
      return blockWithFailure(rawOutput, diffHash, 'malformed_rejection_envelope');
    }
  }

  get schema() {
    return this.#value.schema;
  }

  get kind() {
    return this.#value.kind;
  }

  get diffHash() {
    return this.#value.diff_hash;
  }

  get findings() {
    return this.#value.findings;
  }

  get failure() {
    return this.#value.failure;
  }

  toJSON() {
    return {
      schema: this.#value.schema,
      kind: this.#value.kind,
      diff_hash: this.#value.diff_hash,
      findings: this.#value.findings.map((finding) => ({ ...finding })),
      ...(this.#value.failure ? { failure: { ...this.#value.failure } } : {}),
    };
  }

  toString() {
    return JSON.stringify(this.toJSON(), null, 2);
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
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',
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
  #modelsTried;
  #envelope;
  #timestamp;

  /**
   * @param {{
   *   diffIdentity: DiffIdentity|string,
   *   verdict: ReviewVerdict|string,
   *   rawOutput: string,
   *   modelsTried?: string[],
   *   envelope?: ReviewRejectionEnvelope|null,
   *   timestamp?: Date
   * }} params
   */
  constructor({ diffIdentity, verdict, rawOutput = '', modelsTried, envelope = null, timestamp = new Date() }) {
    this.#diffHash = diffIdentity instanceof DiffIdentity ? diffIdentity.hash : String(diffIdentity);
    this.#verdict = verdict instanceof ReviewVerdict ? verdict.value : String(verdict);
    this.#rawOutput = rawOutput;
    this.#modelsTried = Array.isArray(modelsTried) ? modelsTried.filter((m) => typeof m === 'string') : undefined;
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
    this.#timestamp = timestamp instanceof Date ? timestamp : new Date(timestamp);
  }

  /**
   * Formats ISO timestamp into safe filename segment.
   *
   * @param {Date} date
   * @returns {string}
   */
  static formatTimestamp(date) {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Computes standardized report filename.
   *
   * @returns {string}
   */
  get filename() {
    const stamp = ReviewReport.formatTimestamp(this.#timestamp);
    return `${stamp}-${this.#diffHash}.md`;
  }

  /**
   * Renders the complete markdown audit report.
   *
   * @returns {string}
   */
  toMarkdown() {
    const lines = [
      '# OMP Review Kit commit review',
      '',
      `- staged diff hash: ${this.#diffHash}`,
      `- result: ${this.#verdict}`,
    ];
    if (this.#modelsTried && this.#modelsTried.length > 0) {
      lines.push(`- reviewer models tried: ${this.#modelsTried.join(', ')}`);
    }
    if (this.#envelope) {
      lines.push('', '## Normalized rejection envelope', '', '```json', this.#envelope.toString(), '```');
    }
    lines.push('', this.#rawOutput.trim(), '');
    return lines.join('\n');
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

  get modelsTried() {
    return this.#modelsTried;
  }

  get envelope() {
    return this.#envelope;
  }

  get timestamp() {
    return this.#timestamp;
  }
}

export class ReviewExecutionResult {
  #exitCode;
  #skipped;
  #verdict;
  #reportPath;
  #details;
  #modelsTried;
  #envelope;

  /**
   * @param {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   details?: string,
   *   modelsTried?: string[],
   *   envelope?: ReviewRejectionEnvelope|null
   * }} params
   */
  constructor({ exitCode, skipped, verdict, reportPath, details, modelsTried, envelope = null }) {
    this.#exitCode = exitCode;
    this.#skipped = skipped;
    this.#verdict = verdict;
    this.#reportPath = reportPath;
    this.#details = details;
    if (modelsTried !== undefined && (!Array.isArray(modelsTried) || modelsTried.some((model) => typeof model !== 'string'))) {
      throw new TypeError('modelsTried must be an array of strings');
    }
    this.#modelsTried = modelsTried;
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
  }

  /**
   * Factory for clean commits with no staged modifications.
   *
   * @returns {ReviewExecutionResult}
   */
  static skipped() {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: true,
    });
  }

  /**
   * Factory for approved changes.
   *
   * @param {string} reportPath
   * @param {'PASS'} [verdict='PASS']
   * @param {string[]} [modelsTried]
   * @returns {ReviewExecutionResult}
   */
  static pass(reportPath, verdict = 'PASS', modelsTried) {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: false,
      verdict,
      reportPath,
      modelsTried,
    });
  }

  /**
   * Factory for rejected changes.
   *
   * @param {string} [reportPath]
   * @param {string} [details]
   * @param {string[]} [modelsTried]
   * @param {ReviewRejectionEnvelope} envelope
   * @returns {ReviewExecutionResult}
   */
  static block(reportPath, details = '', modelsTried, envelope) {
    return new ReviewExecutionResult({
      exitCode: 1,
      skipped: false,
      verdict: 'BLOCK',
      reportPath,
      details,
      modelsTried,
      envelope,
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

  get modelsTried() {
    return this.#modelsTried;
  }

  get envelope() {
    return this.#envelope;
  }

  /**
   * Plain object representation for backward-compatible consumption.
   *
   * @returns {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   modelsTried?: string[],
   *   envelope?: object
   * }}
   */
  toJSON() {
    const obj = {
      exitCode: this.#exitCode,
      skipped: this.#skipped,
    };
    if (this.#verdict !== undefined) obj.verdict = this.#verdict;
    if (this.#reportPath !== undefined) obj.reportPath = this.#reportPath;
    if (this.#modelsTried !== undefined && this.#modelsTried.length > 0) {
      obj.modelsTried = this.#modelsTried;
    }
    if (this.#envelope) obj.envelope = this.#envelope.toJSON();
    return obj;
  }
}

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

  /**
   * @param {{
   *   gitPort: GitPort,
   *   reviewerPort: ReviewerPort,
   *   reportStorePort: ReportStorePort,
   *   clock?: () => Date,
   *   logger?: { log: (msg: string) => void, error: (msg: string) => void }
   * }} dependencies
   */
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

  /**
   * Executes the complete review lifecycle.
   *
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<ReviewExecutionResult>}
   */
  async execute({ cwd = process.cwd() } = {}) {
    const repoRoot = (await this.#gitPort.getRepoRoot(cwd)).trim();
    const diff = await this.#gitPort.getStagedDiff(repoRoot);

    if (diff.isEmpty()) {
      return ReviewExecutionResult.skipped();
    }

    const prompt = ReviewPrompt.forDiff(diff);
    const execResult = await this.#reviewerPort.executeReview({
      prompt,
      cwd: repoRoot,
    });

    const combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;
    const modelsTried = execResult.modelsTried;

    const { verdict, envelope } = ReviewRejectionEnvelope.evaluate({
      output: combinedOutput,
      diffIdentity: diff,
      processStatus: execResult.status,
      processError: execResult.stderr,
    });

    const report = new ReviewReport({
      diffIdentity: diff,
      verdict,
      rawOutput: combinedOutput,
      modelsTried,
      envelope,
      timestamp: this.#clock(),
    });

    const reportPath = await this.#reportStorePort.saveReport(repoRoot, report);

    if (verdict.isPass()) {
      this.#logger.log(`reviewer-kit PASS: ${reportPath}\n`);
      return ReviewExecutionResult.pass(reportPath, verdict.value, modelsTried);
    }

    this.#logger.error(`reviewer-kit BLOCK: ${reportPath}\n`);
    this.#logger.error(`REVIEW_REJECTION_REPORT=${reportPath}\n`);

    return ReviewExecutionResult.block(reportPath, combinedOutput.trim(), modelsTried, envelope);
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
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      // The process already exited.
    }
  }
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
      const commandArgs = ['-p', '--model', selectedModel, ...modelRoleArgs, ...(noTools ? ['--no-tools'] : ['--tools', 'task']), '--no-session'];
      const dispatchPrompt = `${prompt}\nSelected reviewer model for this invocation: ${selectedModel}. Pass model: \"${selectedModel}\" to every child task so all review stages use this selector.`;
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
   *   cwd: string,
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

export function createReviewWorkflowService({ git, omp, clock, logger, progress } = {}) {
  const gitPort = new SubprocessGitAdapter(git);
  const reviewerPort = new OmpCliReviewerAdapter({ runner: omp, progress });
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
  progress,
} = {}) {
  const service = createReviewWorkflowService({
    git,
    omp,
    clock: () => now,
    logger,
    progress,
  });

  const result = await service.execute({ cwd });
  return result.toJSON();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stderr.write(formatReviewProgress({
      state: 'started',
      message: 'commit hook started; collecting staged change',
      elapsedMs: 0,
    }) + '\n');
    const result = await runReview({ progress: writeReviewProgress });
    if (result.skipped) process.stderr.write('reviewer-kit SKIPPED: no staged changes\n');    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`reviewer-kit BLOCK: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
