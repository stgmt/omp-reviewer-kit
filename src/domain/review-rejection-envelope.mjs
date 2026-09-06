import { ReviewVerdict } from './review-verdict.mjs';

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
      && isNonEmptyString(value.failure.message);
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
