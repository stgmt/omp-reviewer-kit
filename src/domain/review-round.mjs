import { sanitizePromptToken } from './review-prompt.mjs';

const ROUND_SCHEMA = 'review-round@1';
const MAX_FINDINGS = 20;
const MAX_DELTA_FILES = 40;

/**
 * Added content lines per file from a unified diff (`+` lines only).
 *
 * @param {string} diffText
 * @returns {Map<string, Set<string>>}
 */
export function addedLinesByFile(diffText) {
  const byFile = new Map();
  let current = null;
  for (const line of String(diffText ?? '').split(/\r\n|\n/)) {
    if (line.startsWith('diff --git ')) {
      current = null;
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, new Set());
    } else if (current && line.startsWith('+')) {
      byFile.get(current).add(line.slice(1));
    }
  }
  return byFile;
}

/**
 * Files whose added lines differ from the previous round's diff.
 *
 * @param {string} previousDiff
 * @param {string} currentDiff
 * @returns {{ path: string, newLines: number }[]}
 */
export function deltaSincePrevious(previousDiff, currentDiff) {
  const before = addedLinesByFile(previousDiff);
  const after = addedLinesByFile(currentDiff);
  const delta = [];
  for (const [file, lines] of after) {
    const known = before.get(file);
    let newLines = 0;
    for (const line of lines) if (!known || !known.has(line)) newLines += 1;
    if (newLines > 0) delta.push({ path: file, newLines });
  }
  return delta;
}

/**
 * Condenses a BLOCK envelope into the findings carried to the next round.
 *
 * @param {{ kind: string, findings?: object[], coverage_items?: object[] }} envelope
 * @returns {{ id: string, priority: string, file: string, line: number|null, summary: string }[]}
 */
export function roundFindingsFromEnvelope(envelope) {
  const rows = [];
  for (const finding of envelope?.findings ?? []) {
    rows.push({
      id: String(finding.finding_id ?? ''),
      priority: String(finding.priority ?? ''),
      file: String(finding.file_path ?? ''),
      line: Number.isInteger(finding.line_start) ? finding.line_start : null,
      summary: String(finding.counterexample ?? finding.verifier_argument ?? ''),
    });
  }
  for (const item of envelope?.coverage_items ?? []) {
    rows.push({
      id: String(item.coverage_id ?? ''),
      priority: String(item.severity ?? 'P2'),
      file: String(item.file_path ?? ''),
      line: Number.isInteger(item.line_start) ? item.line_start : null,
      summary: `missing coverage: ${String(item.behavior ?? '')}`,
    });
  }
  return rows.slice(0, MAX_FINDINGS);
}

/**
 * Value object describing the previous BLOCKed round for the same repository.
 */
export class ReviewRound {
  static SCHEMA = ROUND_SCHEMA;

  #number;
  #previousHash;
  #previousAt;
  #findings;
  #delta;

  constructor({ number, previousHash, previousAt, findings, delta }) {
    this.#number = number;
    this.#previousHash = previousHash;
    this.#previousAt = previousAt;
    this.#findings = findings;
    this.#delta = delta;
  }

  /**
   * @param {{ record: object, currentDiffText: string, currentHash: string, now: Date, maxAgeMs: number }} params
   * @returns {ReviewRound|null}
   */
  static fromRecord({ record, currentDiffText, currentHash, now, maxAgeMs }) {
    if (!record || record.schema !== ROUND_SCHEMA) return null;
    if (!/^[0-9a-f]{64}$/.test(String(record.diffHash)) || record.diffHash === currentHash) return null;
    const age = now.getTime() - Date.parse(record.at);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    if (!Array.isArray(record.findings) || record.findings.length === 0) return null;
    return new ReviewRound({
      number: (Number.isInteger(record.round) ? record.round : 1) + 1,
      previousHash: record.diffHash,
      previousAt: record.at,
      findings: record.findings.slice(0, MAX_FINDINGS),
      delta: typeof record.diffText === 'string' ? deltaSincePrevious(record.diffText, currentDiffText) : null,
    });
  }

  get number() {
    return this.#number;
  }

  get previousHash() {
    return this.#previousHash;
  }

  get findings() {
    return this.#findings;
  }

  /** @returns {{ path: string, newLines: number }[]|null} null when the previous diff was not retained */
  get delta() {
    return this.#delta;
  }

  toPromptText() {
    const lines = [
      `PREVIOUS ROUND (this is review round ${this.#number}): the previous review of this repository BLOCKed a different staged diff (${this.#previousHash}) at ${sanitizePromptToken(this.#previousAt)}. Findings confirmed in that round:`,
      ...this.#findings.map((f) => `- ${sanitizePromptToken(f.id)} (${sanitizePromptToken(f.priority)}) ${sanitizePromptToken(f.file)}${f.line ? `:${f.line}` : ''} — ${sanitizePromptToken(f.summary).slice(0, 240)}`),
    ];
    if (this.#delta === null) {
      lines.push('The previous diff was not retained, so the lines changed since that round cannot be computed: treat the whole diff as changed.');
    } else if (this.#delta.length === 0) {
      lines.push('No added lines differ from the previous round (only removals or identical additions).');
    } else {
      lines.push(
        'Files with lines added since the previous round (the round delta):',
        ...this.#delta.slice(0, MAX_DELTA_FILES).map((d) => `- ${sanitizePromptToken(d.path)}: ${d.newLines} new line(s)`),
      );
    }
    lines.push(
      'Round rules: (1) The verifier must first decide for EVERY previous finding whether the current diff fixes it (fixed / still present), with evidence from the staged snapshot; a finding that is still present stays confirmed and blocks. (2) A new P2 finding is admissible only if it is rooted in the round delta or in a direct interaction with it; pre-existing lines unchanged since the previous round that were not flagged then must not become new P2 findings. New P1 findings (security, data loss, crash on the main path) are admissible anywhere in the diff. (3) Embed this PREVIOUS ROUND block verbatim in the task text of every hunter and the verifier.',
    );
    return lines.join('\n');
  }
}
