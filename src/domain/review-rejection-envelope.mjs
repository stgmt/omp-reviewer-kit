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

const TOP_LEVEL_KEYS = Object.freeze(['diff_hash', 'findings', 'kind', 'non_coverable_items', 'schema']);
const FAILURE_TOP_LEVEL_KEYS = Object.freeze([...TOP_LEVEL_KEYS, 'failure'].sort());
const FINDING_KEYS = Object.freeze([
  'blocking',
  'category_kind',
  'counterexample',
  'defect_class',
  'file_path',
  'finding_id',
  'line_end',
  'line_start',
  'priority',
  'severity',
  'source',
  'verifier_argument',
]);
const FAILURE_KEYS = Object.freeze(['code', 'message']);
const COVERAGE_TOP_LEVEL_KEYS = Object.freeze(['coverage_items', 'diff_hash', 'findings', 'kind', 'non_coverable_items', 'schema']);
const COVERAGE_ITEM_KEYS = Object.freeze([
  'behavior',
  'blocking',
  'category_kind',
  'coverage_id',
  'file_path',
  'line_end',
  'line_start',
  'required_tests',
  'severity',
  'source',
]);
const REQUIRED_TEST_KEYS = Object.freeze(['kind', 'mutant', 'scenario']);
// Non-coverable items travel inside the envelope (blocking: false) so the
// report's ### Notes section stays machine-readable; they never block PASS.
const NON_COVERABLE_ITEM_KEYS = Object.freeze([
  'blocking',
  'category_kind',
  'file_path',
  'line_end',
  'line_start',
  'reason',
  'severity',
  'source',
]);
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


/**
 * Model-emitted envelopes repeatedly drop fields the contract derives
 * deterministically (severity=priority, category_kind, blocking, source
 * mirroring). Filling contract-fixed derivable fields before strict
 * validation is NOT leniency: nothing content-bearing is invented, and
 * without it a schema drop turns a valid BLOCK into
 * malformed_rejection_envelope, discarding every confirmed finding.
 * Prototype-pollution keys (__proto__/constructor/prototype) are NEVER
 * normalized: the item is returned verbatim so strict validation rejects.
 */
const DANGEROUS_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
function hasDangerousKey(item) {
  return DANGEROUS_KEYS.some((k) => Object.hasOwn(item, k));
}
function normalizeFinding(finding) {
  if (!isRecord(finding)) return finding;
  if (hasDangerousKey(finding)) return finding;
  // Whitelist output: verbose model keys (impact, observed, evidence, ...)
  // are not envelope fields — keeping them would fail hasExactKeys.
  return {
    finding_id: isNonEmptyString(finding.finding_id) ? finding.finding_id : finding.candidate_id,
    priority: finding.priority,
    severity: finding.severity === undefined ? finding.priority : finding.severity,
    defect_class: isNonEmptyString(finding.defect_class) ? finding.defect_class : finding.lane,
    category_kind: finding.category_kind === undefined ? 'finding' : finding.category_kind,
    blocking: finding.blocking !== undefined ? finding.blocking : true,
    source: finding.source !== undefined
      ? finding.source
      : (isNonEmptyString(finding.defect_class) ? finding.defect_class : finding.lane),
    file_path: finding.file_path,
    line_start: finding.line_start,
    line_end: finding.line_end,
    verifier_argument: finding.verifier_argument,
    counterexample: finding.counterexample,
  };
}

function normalizeCoverageItem(item) {
  if (!isRecord(item)) return item;
  if (hasDangerousKey(item)) return item;
  // Whitelist output — see normalizeFinding.
  return {
    coverage_id: isNonEmptyString(item.coverage_id) ? item.coverage_id : item.candidate_id,
    category_kind: item.category_kind === undefined ? 'coverage' : item.category_kind,
    // Mandatory coverage gaps are contract-fixed P2 (blockers) — derive.
    severity: item.severity === undefined ? 'P2' : item.severity,
    blocking: item.blocking !== undefined ? item.blocking : true,
    source: item.source !== undefined ? item.source : 'correctness',
    file_path: item.file_path,
    line_start: item.line_start,
    line_end: item.line_end,
    behavior: item.behavior,
    required_tests: item.required_tests,
  };
}

function normalizeNonCoverableItem(item) {
  if (!isRecord(item)) return item;
  if (hasDangerousKey(item)) return item;
  // r34: producers emit different vocabularies — scout records carry
  // `reason`, hunter `ground`, verifier `coverage_id`+`ground`. Map aliases
  // onto the envelope contract and emit ONLY the 8 contract keys: producer
  // bookkeeping ids (coverage_id, candidate_id, ...) are not envelope
  // fields and must be stripped, else hasExactKeys rejects the whole
  // envelope. `source` defaults by producer shape: coverage_id → verifier,
  // ground → hunter, else scout (reason-bearing records).
  const reason = item.reason !== undefined ? item.reason
    : (item.ground !== undefined ? item.ground : item.rejection_ground);
  const source = item.source !== undefined ? item.source
    : (isNonEmptyString(item.producer) ? item.producer
      : (isNonEmptyString(item.stage) ? item.stage
        : (isNonEmptyString(item.lane) ? item.lane
          : (isNonEmptyString(item.coverage_id) ? 'verifier'
            : (isNonEmptyString(item.ground) ? 'hunter' : 'scout')))));
  return {
    category_kind: item.category_kind === undefined ? 'non_coverable' : item.category_kind,
    severity: item.severity === undefined ? 'none' : item.severity,
    blocking: item.blocking !== undefined ? item.blocking : false,
    source,
    file_path: item.file_path,
    line_start: item.line_start,
    line_end: item.line_end,
    reason,
  };
}

function validateFinding(finding, identifiers) {
  if (!hasExactKeys(finding, FINDING_KEYS)) return false;
  if (!isNonEmptyString(finding.finding_id) || identifiers.has(finding.finding_id)) return false;
  if (finding.priority !== 'P1' && finding.priority !== 'P2') return false;
  if (!['correctness', 'security', 'content-risk'].includes(finding.defect_class)) return false;
  if (finding.category_kind !== 'finding') return false;
  if (finding.severity !== finding.priority) return false;
  if (finding.blocking !== true) return false;
  if (!isNonEmptyString(finding.source)) return false;
  if (!isRelativeRepositoryPath(finding.file_path)) return false;
  if (!Number.isInteger(finding.line_start) || finding.line_start < 1) return false;
  if (!Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) return false;
  if (!isNonEmptyString(finding.verifier_argument) || !isNonEmptyString(finding.counterexample)) return false;
  identifiers.add(finding.finding_id);
  return true;
}

function validateRequiredTest(test) {
  if (!hasExactKeys(test, REQUIRED_TEST_KEYS)) return false;
  if (test.kind !== 'edge' && test.kind !== 'mutation') return false;
  if (!isNonEmptyString(test.scenario)) return false;
  if (test.kind === 'mutation' && !isNonEmptyString(test.mutant)) return false;
  if (test.kind === 'edge' && typeof test.mutant !== 'string') return false;
  return true;
}

function validateCoverageItem(item, identifiers) {
  if (!hasExactKeys(item, COVERAGE_ITEM_KEYS)) return false;
  if (!isNonEmptyString(item.coverage_id) || identifiers.has(item.coverage_id)) return false;
  if (item.category_kind !== 'coverage') return false;
  if (item.severity !== 'P1' && item.severity !== 'P2') return false;
  if (item.blocking !== true) return false;
  if (!isNonEmptyString(item.source)) return false;
  if (!isRelativeRepositoryPath(item.file_path)) return false;
  if (!Number.isInteger(item.line_start) || item.line_start < 1) return false;
  if (!Number.isInteger(item.line_end) || item.line_end < item.line_start) return false;
  if (!isNonEmptyString(item.behavior)) return false;
  if (!Array.isArray(item.required_tests) || item.required_tests.length === 0) return false;
  if (!item.required_tests.every(validateRequiredTest)) return false;
  identifiers.add(item.coverage_id);
  return true;
}

function validateNonCoverableItem(item, identifiers) {
  if (!hasExactKeys(item, NON_COVERABLE_ITEM_KEYS)) return false;
  if (item.category_kind !== 'non_coverable') return false;
  if (item.severity !== 'none') return false;
  if (item.blocking !== false) return false;
  if (!isNonEmptyString(item.source)) return false;
  if (!isRelativeRepositoryPath(item.file_path)) return false;
  if (!Number.isInteger(item.line_start) || item.line_start < 1) return false;
  if (!Number.isInteger(item.line_end) || item.line_end < item.line_start) return false;
  if (!isNonEmptyString(item.reason)) return false;
  const identity = `${item.file_path}:${item.line_start}:${item.line_end}:${item.reason}:${item.source}`;
  if (identifiers.has(identity)) return false;
  identifiers.add(identity);
  return true;
}

function validateNonCoverableItems(value) {
  if (!Array.isArray(value)) return false;
  const identifiers = new Set();
  return value.every((item) => validateNonCoverableItem(item, identifiers));
}

function validateEnvelope(value, diffHash) {
  if (!isRecord(value) || value.schema !== ENVELOPE_SCHEMA || value.diff_hash !== diffHash) return false;
  // Contract-fixed absent-means-empty: models repeatedly drop the field
  // wholesale; [] is the only legal meaning, so default before the
  // strict top-level key check rather than discarding the envelope.
  if (value.non_coverable_items === undefined) value.non_coverable_items = [];
  // r32 correctness-2: normalize ONCE at the top so all three kinds —
  // including review_failure — share the same derivable-field contract.
  if (Array.isArray(value.non_coverable_items)) {
    value.non_coverable_items = value.non_coverable_items.map(normalizeNonCoverableItem);
  } else {
    value.non_coverable_items = [];
  }
  if (value.kind === 'confirmed_findings') {
    if (!hasExactKeys(value, TOP_LEVEL_KEYS) || !Array.isArray(value.findings) || value.findings.length === 0) return false;
    value.findings = value.findings.map(normalizeFinding);
    if (!validateNonCoverableItems(value.non_coverable_items)) return false;
    const identifiers = new Set();
    return value.findings.every((finding) => validateFinding(finding, identifiers));
  }
  if (value.kind === 'coverage_required') {
    if (!hasExactKeys(value, COVERAGE_TOP_LEVEL_KEYS)) return false;
    if (!Array.isArray(value.findings) || value.findings.length !== 0) return false;
    if (!Array.isArray(value.coverage_items) || value.coverage_items.length === 0) return false;
    value.coverage_items = value.coverage_items.map(normalizeCoverageItem);
    if (!validateNonCoverableItems(value.non_coverable_items)) return false;
    const identifiers = new Set();
    return value.coverage_items.every((item) => validateCoverageItem(item, identifiers));
  }
  if (value.kind === 'review_failure') {
    return hasExactKeys(value, FAILURE_TOP_LEVEL_KEYS)
      && Array.isArray(value.findings)
      && value.findings.length === 0
      && validateNonCoverableItems(value.non_coverable_items)
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
    non_coverable_items: [],
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
      non_coverable_items: Object.freeze(
        value.non_coverable_items.map((item) => Object.freeze({ ...item })),
      ),
      ...(value.coverage_items
        ? {
            coverage_items: Object.freeze(
              value.coverage_items.map((item) =>
                Object.freeze({
                  ...item,
                  required_tests: Object.freeze(item.required_tests.map((test) => Object.freeze({ ...test }))),
                }),
              ),
            ),
          }
        : {}),
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

    const lines = rawOutput.split(/\r\n|[\n\r\u2028\u2029]/);
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

    const blockIndex = lines.lastIndexOf('REVIEW_RESULT=BLOCK');
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

  get coverageItems() {
    return this.#value.coverage_items ?? [];
  }

  get nonCoverableItems() {
    return this.#value.non_coverable_items;
  }

  toJSON() {
    return {
      schema: this.#value.schema,
      kind: this.#value.kind,
      diff_hash: this.#value.diff_hash,
      findings: this.#value.findings.map((finding) => ({ ...finding })),
      non_coverable_items: this.#value.non_coverable_items.map((item) => ({ ...item })),
      ...(this.#value.coverage_items
        ? {
            coverage_items: this.#value.coverage_items.map((item) => ({
              ...item,
              required_tests: item.required_tests.map((test) => ({ ...test })),
            })),
          }
        : {}),
      ...(this.#value.failure ? { failure: { ...this.#value.failure } } : {}),
    };
  }

  toString() {
    return JSON.stringify(this.toJSON(), null, 2);
  }
}
