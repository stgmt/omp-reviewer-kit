import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function unquoteGitPath(quoted) {
  const inner = quoted.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 3 < inner.length && /[0-7]/.test(inner[i + 1]) && /[0-7]/.test(inner[i + 2]) && /[0-7]/.test(inner[i + 3])) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (inner[i] === '\\' && inner[i + 1] === '\\') {
      bytes.push(0x5c);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === '"') {
      bytes.push(0x22);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === 't') {
      bytes.push(0x09);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === 'n') {
      bytes.push(0x0a);
      i += 1;
    } else {
      bytes.push(inner.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

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

  /**
   * Unique repository-relative paths touched by this diff, parsed from
   * `diff --git a/<old> b/<new>` headers (both sides for renames).
   * @returns {string[]}
   */
  get changedPaths() {
    const text = this.#bytes.toString('utf8');
    const seen = new Set();
    for (const header of text.matchAll(/^diff --git (.+)$/gm)) {
      for (const side of header[1].match(/"[^"]*"|\S+/g) ?? []) {
        const raw = side.startsWith('"') ? unquoteGitPath(side) : side;
        seen.add(raw.replace(/^[ab]\//, ''));
      }
    }
    return [...seen];
  }
}


/**
 * Immutable value object containing the complete staged index tree.
 */
export class StagedSnapshot {
  #files;
  #hash;

  /**
   * @param {{ path: string, content: Buffer }[]} files
   */
  constructor(files) {
    if (!Array.isArray(files)) {
      throw new TypeError('StagedSnapshot expects an array of files');
    }

    const normalizedFiles = files.map((file) => {
      if (!file || typeof file.path !== 'string' || !Buffer.isBuffer(file.content)) {
        throw new TypeError('StagedSnapshot files require a string path and Buffer content');
      }
      return Object.freeze({ path: file.path, content: Buffer.from(file.content) });
    });

    const hash = createHash('sha256');
    for (const file of normalizedFiles) {
      hash.update(file.path);
      hash.update('\0');
      hash.update(file.content);
      hash.update('\0');
    }

    this.#files = Object.freeze(normalizedFiles);
    this.#hash = hash.digest('hex');
  }

  get files() {
    return this.#files;
  }

  get hash() {
    return this.#hash;
  }

  isEmpty() {
    return this.#files.length === 0;
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
    const value = Object.create(null);
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

    const pairs = [];
    let openBegin = -1;
    for (const index of [...beginIndexes, ...endIndexes].sort((a, b) => a - b)) {
      if (beginIndexes.includes(index)) {
        openBegin = index;
      } else if (openBegin >= 0) {
        pairs.push([openBegin, index]);
        openBegin = -1;
      }
    }

    const blockIndex = lines.indexOf('REVIEW_RESULT=BLOCK');
    for (const [beginIndex, endIndex] of pairs) {
      if (endIndex >= blockIndex || blockIndex !== endIndex + 1) continue;
      try {
        const parsed = parseStrictJson(lines.slice(beginIndex + 1, endIndex).join('\n'));
        if (validateEnvelope(parsed, diffHash)) {
          return { verdict, envelope: new ReviewRejectionEnvelope(parsed) };
        }
      } catch {
        // try the next envelope pair
      }
    }
    return blockWithFailure(rawOutput, diffHash, 'malformed_rejection_envelope');
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
  #snapshotDir;
  #diffHash;
  #changedPaths;

  constructor(diffHash, snapshotDir = '', changedPaths = []) {
    if (!diffHash || typeof diffHash !== 'string') {
      throw new TypeError('ReviewPrompt requires a non-empty diff hash string');
    }
    if (typeof snapshotDir !== 'string') {
      throw new TypeError('ReviewPrompt snapshotDir must be a string');
    }
    if (!Array.isArray(changedPaths)) {
      throw new TypeError('ReviewPrompt changedPaths must be an array');
    }
    this.#diffHash = diffHash;
    this.#snapshotDir = snapshotDir;
    this.#changedPaths = changedPaths;
  }

  static forDiff(target, snapshotDir = '', changedPaths = []) {
    const hash = target instanceof DiffIdentity ? target.hash : target;
    const paths = target instanceof DiffIdentity ? target.changedPaths : changedPaths;
    return new ReviewPrompt(hash, snapshotDir, paths);
  }

  toString() {
    const lines = [
      'You are the OMP headless review dispatcher.',
      'Run exactly one native task with agent "reviewer-kit".',
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',
      'The task must run both correctness and security risk lanes; the correctness lane must inspect focused tests and YAGNI only when a concrete reachable P1/P2 impact is proven.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'Invoke the task with only the supported name, agent, and task fields; omit model, outputSchema, schemaMode, and isolated so the reviewer agent owns its declared schema and model roles.',
      'After the task returns, reproduce its complete report verbatim; if the result says it was truncated or provides an agent URI, read that URI first, and never summarize or omit a rejection envelope.',
      'If the task fails, returns empty, or its result cannot be read, do not summarize: emit exactly one review_failure envelope — the line REVIEW_REJECTION_ENVELOPE_BEGIN, then one JSON object {"schema":"review-rejection-envelope@1","kind":"review_failure","diff_hash":"<the staged diff hash from this prompt>","findings":[],"failure":{"code":"execution_failure","message":"<the observed task error>"}}, then REVIEW_REJECTION_ENVELOPE_END, then REVIEW_RESULT=BLOCK on its own line.',
    ];
    if (this.#snapshotDir) {
      lines.push(
        `The staged snapshot directory is ${this.#snapshotDir}.`,
        `The complete staged diff is materialized at ${this.#snapshotDir}/.review/diff.patch and the changed-file list at ${this.#snapshotDir}/.review/changed-files.txt. Read them as files; do not run git diff or git show to obtain review content.`,
        'Read every source file from that staged snapshot directory, never from the working tree. Use the repository only for read-only Git metadata and project skill discovery.',
      );
    }
    if (this.#changedPaths.length > 0) {
      lines.push(
        `The changed paths for this review are: ${this.#changedPaths.join(', ')}.`,
        'Pass these paths to the context scout in its task text so it does not re-derive them from the diff.',
      );
    }
    lines.push(`The staged diff hash for this hook invocation is ${this.#diffHash}.`);
    return lines.join('\n');
  }

  get diffHash() {
    return this.#diffHash;
  }

  get snapshotDir() {
    return this.#snapshotDir;
  }

  get changedPaths() {
    return [...this.#changedPaths];
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
  #verifiedOk;
  #envelope;
  #timestamp;

  constructor({ diffIdentity, verdict, rawOutput = '', modelsTried, verifiedOk = [], envelope = null, timestamp = new Date() }) {
    this.#diffHash = diffIdentity instanceof DiffIdentity ? diffIdentity.hash : String(diffIdentity);
    this.#verdict = verdict instanceof ReviewVerdict ? verdict.value : String(verdict);
    this.#rawOutput = rawOutput;
    this.#modelsTried = Array.isArray(modelsTried) ? modelsTried.filter((m) => typeof m === 'string') : undefined;
    if (!Array.isArray(verifiedOk) || verifiedOk.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      throw new TypeError('verifiedOk must be an array of non-empty strings');
    }
    this.#verifiedOk = Object.freeze(verifiedOk.map((item) => item.trim()));
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
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
    const rawOutput = this.#rawOutput.trim();
    if (this.#verifiedOk.length > 0 && !/^### Verified-OK\s*$/m.test(rawOutput)) {
      lines.push('', '### Verified-OK', ...this.#verifiedOk.map((item) => `- ${item}`));
    }
    lines.push('', rawOutput, '');
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

  get verifiedOk() {
    return this.#verifiedOk;
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
   *   details?: string,
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
    if (this.#details !== undefined) obj.details = this.#details;
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

  getSnapshot(repoRoot) {
    throw new Error('GitPort.getSnapshot must be implemented');
  }
}

export class SnapshotStorePort {
  create(snapshot, artifacts) {
    throw new Error('SnapshotStorePort.create must be implemented');
  }

  remove(snapshotDir) {
    throw new Error('SnapshotStorePort.remove must be implemented');
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
 * Port representing the run telemetry sink factory.
 * A port creates a run-scoped sink per review; the sink persists observability
 * events and the live/last-run state without ever influencing the verdict.
 */
export class TelemetryPort {
  /**
   * @param {{ repoRoot: string, runId: string }} context
   * @returns {RunTelemetry-like sink with record() and updateLastRun()}
   */
  forRun(context) {
    throw new Error('TelemetryPort.forRun must be implemented');
  }
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
  }

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
        const prompt = ReviewPrompt.forDiff(diff, snapshotDir, diff.changedPaths);
        execResult = await this.#reviewerPort.executeReview({
          prompt,
          cwd: repoRoot,
          telemetry,
        });
      } finally {
        await this.#snapshotStorePort.remove(snapshotDir);
      }

      const combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;
      const modelsTried = execResult.modelsTried;

      const { verdict, envelope } = ReviewRejectionEnvelope.evaluate({
        output: combinedOutput,
        diffIdentity: diff,
        processStatus: execResult.status,
        processError: execResult.stderr,
      });

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
    }
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
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const chunks = [];
      const errChunks = [];
      proc.stdout.on('data', (chunk) => chunks.push(chunk));
      proc.stderr.on('data', (chunk) => errChunks.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(errChunks).toString('utf8').trim();
          reject(new Error(detail || `git ${args[0] ?? 'command'} failed with exit ${code ?? 'unknown'}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async getRepoRoot(cwd) {
    const output = await this.#runner(['rev-parse', '--show-toplevel'], cwd);
    return output.toString('utf8').trim();
  }

  async getStagedDiff(repoRoot) {
    const output = await this.#runner(['diff', '--cached', '--binary', '--no-ext-diff', '--'], repoRoot);
    return DiffIdentity.fromBuffer(output);
  }

  async getSnapshot(repoRoot) {
    const listing = await this.#runner(['ls-files', '--cached', '-z', '--stage', '--'], repoRoot);
    const entries = listing.toString('utf8').split('\0').filter(Boolean);
    const files = [];

    for (const entry of entries) {
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error('git ls-files returned an invalid staged entry');
      const metadata = entry.slice(0, separator).split(' ');
      const mode = metadata[0];
      const stage = metadata[2];
      if (stage !== '0') throw new Error('Cannot review an unmerged staged index');
      if (mode === '160000') continue;
      const objectId = metadata[1];
      const stagedPath = entry.slice(separator + 1);
      const content = await this.#runner(['cat-file', 'blob', objectId], repoRoot);
      files.push({ path: stagedPath, content });
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return new StagedSnapshot(files);
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

/**
 * Rewrites the `:effort` suffix of a concrete `provider/model[:effort]`
 * selector when OMP_REVIEW_KIT_EFFORT is set. Appends the suffix when the
 * selector has none; provider/model identity is preserved. Applied to every
 * selector bound for spawn, so probes and attempts stay consistent.
 */
function applyEffortOverride(selector) {
  const effort = process.env.OMP_REVIEW_KIT_EFFORT ?? 'low';
  if (typeof selector !== 'string') return selector;
  const slash = selector.indexOf('/');
  const colon = selector.lastIndexOf(':');
  const base = colon > slash ? selector.slice(0, colon) : selector;
  return `${base}:${effort}`;
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
  #roleResolver;
  #rolesCache;

  /**
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number, model?: string) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   modelsProvider?: () => string[]|Promise<string[]>,
   *   primaryModel?: string,
   *   maxFallbacks?: number,
   *   modelProbe?: (cwd: string, timeoutMs: number, model: string) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   probeTimeoutMs?: number,
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
    this.#progress = progress ?? (() => {});
    this.#roleResolver = roleResolver ?? OmpCliReviewerAdapter.defaultRoleResolver;
    this.#rolesCache = null;
  }

  #emitProgress(event) {
    try {
      this.#progress(event);
    } catch {
      // Progress is observability only and must never change the review verdict.
    }
  }

  /**
   * Resolves an OMP role selector (`@smol`, `@task`, ...) to the concrete
   * `provider/model[:effort]` configured by the user. `--model` accepts
   * `@role` syntax, but the `--slow`/`--smol` role *assignment* flags do not —
   * passing `@role` there fails with `Model "@role" not found`, so the
   * concrete selector must be resolved before the child is spawned.
   */
  async #resolveSelector(cwd, selector, telemetry) {
    if (typeof selector !== 'string' || !selector.startsWith('@')) return applyEffortOverride(selector);
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
    return applyEffortOverride(resolved);
  }

  async #runReviewAttempt(promptText, cwd, model, telemetry, attempts, attemptIndex) {
    const startedAt = Date.now();
    const record = { model, attemptIndex, startedAt: new Date(startedAt).toISOString() };
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
      const result = await this.#runner(promptText, cwd, undefined, resolvedModel, {
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
      });
      record.status = result?.status;
      record.durationMs = Date.now() - startedAt;
      record.providerFailure = isModelProviderFailure(result ?? {});
      record.stdoutBytes = typeof result?.stdout === 'string' ? Buffer.byteLength(result.stdout) : 0;
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
      const result = await this.#modelProbe(cwd, this.#probeTimeoutMs, resolvedModel);
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
        .filter(isSafeModelSelector);
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
   * @param {{ noTools?: boolean, onOutput?: (chunk: unknown, stream: 'stdout'|'stderr') => void, onSpawn?: (pid: number|undefined) => void }} [options]
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number }>}
   */
  static defaultRunner(prompt, cwd, timeout, model, { noTools = false, onOutput, onSpawn } = {}) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const selectedModel = model ?? process.env.OMP_REVIEW_KIT_MODEL ?? '@smol';
      if (!isSafeModelSelector(selectedModel)) {
        resolve({ status: 1, stdout: '', stderr: 'Rejected unsafe model selector' });
        return;
      }
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      const modelRoleArgs = isWindowsWrapper
        ? ['--slow', selectedModel]
        : [`--slow=${selectedModel}`];
      const commandArgs = ['-p', '--model', selectedModel, ...modelRoleArgs, ...(noTools ? ['--no-tools'] : ['--tools', 'task,read']), '--no-session'];
      const dispatchPrompt = `${prompt}\nThe CLI already pins the active and slow model roles to ${selectedModel}. Use task calls without model, outputSchema, schemaMode, or isolated fields.`;
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
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ pid, ...result });
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
      effortOverride: process.env.OMP_REVIEW_KIT_EFFORT ?? null,
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
    const combined = `${stdout}\n${stderr}`;

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
}


function assertSafeSnapshotPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(filePath) ||
    filePath.split('/').includes('..')
  ) {
    throw new Error(`Unsafe staged path in snapshot: ${filePath}`);
  }
}

export class FileSystemSnapshotAdapter extends SnapshotStorePort {
  constructor() {
    super();
  }

  async create(snapshot, artifacts) {
    const targetDir = await mkdtemp(path.join(tmpdir(), 'reviewer-kit-snapshot-'));
    try {
      await this.materialize(snapshot, targetDir);
      await this.#writeReviewArtifacts(targetDir, artifacts);
      return targetDir;
    } catch (error) {
      await this.remove(targetDir);
      throw error;
    }
  }

  async remove(snapshotDir) {
    await rm(snapshotDir, { recursive: true, force: true });
  }

  async materialize(snapshot, targetDir) {
    for (const file of snapshot.files) {
      assertSafeSnapshotPath(file.path);
      const normalized = file.path.replace(/\\/g, '/').toLowerCase();
      if (normalized === '.review' || normalized.startsWith('.review/')) {
        throw new Error(`Staged path collides with reserved snapshot artifacts directory: ${file.path}`);
      }
      const destination = path.resolve(targetDir, ...file.path.split('/'));
      const root = path.resolve(targetDir) + path.sep;
      if (!destination.startsWith(root)) {
        throw new Error(`Staged path escapes snapshot directory: ${file.path}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }

  }

  async #writeReviewArtifacts(targetDir, artifacts) {
    if (!artifacts || artifacts.diffBytes === undefined) {
      return;
    }
    const reviewDir = path.join(targetDir, '.review');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'diff.patch'), artifacts.diffBytes);
    const manifest = (artifacts.changedPaths ?? []).join('\n') + '\n';
    await writeFile(path.join(reviewDir, 'changed-files.txt'), manifest, 'utf8');
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

const REVIEW_EVENT_SCHEMA = 'review-run-event@1';
const REVIEW_LAST_RUN_SCHEMA = 'review-last-run@1';
const LAST_RUN_THROTTLE_MS = 2_000;

/**
 * Builds the user-facing message emitted when every model in the chain failed
 * with a provider/availability error. The review produced no verdict; the
 * commit is blocked by infrastructure, not by findings.
 */
function formatProviderOutageError(modelsTried, lastStderr) {
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

const NULL_RUN_TELEMETRY = Object.freeze({
  record: async () => {},
  updateLastRun: async () => {},
});

/**
 * Wraps a run telemetry sink so that throwing/rejecting sinks (custom ports,
 * injected doubles) can never change the review verdict or exit code.
 */
function safeRunTelemetry(sink) {
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
class RunTelemetry {
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

/**
 * ============================================================================
 * Public Facade / Composition Root
 * ============================================================================
 */

export function createReviewWorkflowService({ git, omp, ompOptions, clock, logger, progress, telemetry } = {}) {
  const gitPort = new SubprocessGitAdapter(git);
  const reviewerPort = new OmpCliReviewerAdapter({ runner: omp, progress, ...ompOptions });
  const reportStorePort = new FileSystemReportStoreAdapter();
  const snapshotStorePort = new FileSystemSnapshotAdapter();
  const telemetryPort = telemetry ?? new FileSystemTelemetryAdapter();

  return new ReviewWorkflowService({
    gitPort,
    reviewerPort,
    reportStorePort,
    snapshotStorePort,
    telemetryPort,
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
  ompOptions,
  now = new Date(),
  logger,
  progress,
  telemetry,
} = {}) {
  const service = createReviewWorkflowService({
    git,
    omp,
    ompOptions,
    clock: () => now,
    logger,
    progress,
    telemetry,
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
    process.stderr.write(`reviewer-kit INFRA_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
