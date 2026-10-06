import { DiffIdentity } from './diff-identity.mjs';

/**
 * Escapes control characters in attacker-controllable text (staged file paths)
 * before it is rendered into instruction lines. Filenames may legally contain
 * newlines and other control bytes; unescaped they could forge prompt lines
 * such as a fake `Review profile for this diff:` directive.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizePromptToken(value) {
  if (typeof value !== 'string') return '';
  // C0 + DEL + full C1 range, NEL/CSI included as named members of it;
  // Unicode line/paragraph separators; bidi marks (embeddings, overrides,
  // isolates); zero-width and word-joiner characters; variation selectors;
  // TAG characters (U+E0000-E007F, supplement U+E0100-E01EF) and deprecated
  // format marks (ALM U+061C, Mongolian FVS U+180E); BOM. Legal filename
  // bytes that can inject terminal escapes or spoof path lists must never
  // reach prompts/log lines raw.
  return value.replace(/[\x00-\x1f\x7f-\x9f\u00ad\u034f\u070f\u061c\u17b4-\u17b5\u180e\u2028\u2029\u202a-\u202e\u200b-\u200f\u2060-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u115f-\u1160\u3164\uffa0\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    switch (cp) {
      case 0x0a: return '\\n';
      case 0x0d: return '\\r';
      case 0x09: return '\\t';
      default: return cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\u{${cp.toString(16)}}`;
    }
  });
}

/**
 * Domain specification and builder for reviewer agent prompt instructions.
 */
export class ReviewPrompt {
  #snapshotDir;
  #diffHash;
  #changedPaths;
  #suspicionMapText;
  #inlineDiff;
  #reviewProfile;
  #fileClasses;
  #executionEvidenceText;
  #roundContextText;
  #scoutBaselineText;
  #reportPath;
  #contextPackPath;
  #riskLanes;
  #hunterShardsText;
  #reemitOutput;
  #repairEnvelope = false;

  constructor(diffHash, snapshotDir = '', changedPaths = [], extras = {}) {
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
    this.#suspicionMapText = typeof extras?.suspicionMapText === 'string' ? extras.suspicionMapText : '';
    this.#executionEvidenceText = typeof extras?.executionEvidenceText === 'string' ? extras.executionEvidenceText : '';
    this.#roundContextText = typeof extras?.roundContextText === 'string' ? extras.roundContextText : '';
    this.#scoutBaselineText = typeof extras?.scoutBaselineText === 'string' ? extras.scoutBaselineText : '';
    this.#inlineDiff = typeof extras?.inlineDiff === 'string' && extras.inlineDiff.length > 0 ? extras.inlineDiff : null;
    this.#reviewProfile = typeof extras?.reviewProfile === 'string' ? extras.reviewProfile : null;
    this.#fileClasses = Array.isArray(extras?.fileClasses) ? extras.fileClasses : [];
    this.#reportPath = typeof extras?.reportPath === 'string' && extras.reportPath.length > 0 ? extras.reportPath : null;
    this.#contextPackPath = typeof extras?.contextPackPath === 'string' && extras.contextPackPath.length > 0 ? extras.contextPackPath : null;
    this.#hunterShardsText = typeof extras?.hunterShardsText === 'string' ? extras.hunterShardsText : '';
    this.#riskLanes = Array.isArray(extras?.riskLanes) && extras.riskLanes.length > 0 ? extras.riskLanes.filter((l) => typeof l === 'string' && l.length > 0) : null;
  }

  static forDiff(target, snapshotDir = '', changedPaths = [], extras = {}) {
    const hash = target instanceof DiffIdentity ? target.hash : target;
    const paths = target instanceof DiffIdentity ? target.changedPaths : changedPaths;
    return new ReviewPrompt(hash, snapshotDir, paths, extras);
  }

  /**
   * Builds the bounded verbatim re-emit re-prompt used to recover a completed
   * review whose output carried no standalone REVIEW_RESULT marker.
   *
   * @param {string} originalOutput
   * @returns {ReviewPrompt}
   */
  static forReemit(originalOutput, { repairEnvelope = false } = {}) {
    const prompt = new ReviewPrompt('verbatim-reemit');
    prompt.#repairEnvelope = repairEnvelope === true;
    prompt.#reemitOutput = String(originalOutput ?? '');
    return prompt;
  }

  toString() {
    if (this.#reemitOutput !== undefined) return this.#toReemitString();
    const lines = [
      'You are the OMP headless review dispatcher.',
      'Run exactly one native task with agent "reviewer-kit".',
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',
      'The task must run exactly the risk lanes named below under "Risk lanes for this diff" (each lane = one blocking review-risk-hunter task in a single batch). A lane list of ["correctness","security"] restores both standard lanes; only the correctness lane inspects focused tests and YAGNI, and only when a concrete reachable P1/P2 impact is proven.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'Invoke the task with only the supported name, agent, and task fields; omit model, outputSchema, schemaMode, and isolated so the reviewer agent owns its declared schema and model roles.',
      'After the task returns, reproduce its complete report verbatim; if the result says it was truncated or provides an agent URI, read that URI first, and never summarize or omit a rejection envelope. If the agent URI cannot be read, read the durable report copy at the per-run report path named in this prompt (the orchestrator writes it before yielding — pass that path to the reviewer-kit task in its task text) and reproduce that file verbatim instead.',
      'If the task fails, returns empty, or its result cannot be read, do not summarize: emit exactly one review_failure envelope — the line REVIEW_REJECTION_ENVELOPE_BEGIN, then one JSON object {"schema":"review-rejection-envelope@1","kind":"review_failure","diff_hash":"<the staged diff hash from this prompt>","findings":[],"non_coverable_items":[],"failure":{"code":"execution_failure","message":"<the observed task error>"}}, then REVIEW_REJECTION_ENVELOPE_END, then REVIEW_RESULT=BLOCK on its own line.',
      'Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.',
      'The verdict contract in this prompt overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line as the last non-empty line of the output — markers anywhere else are ignored — even if a skill describes a different verdict vocabulary.',
    ];
    if (this.#inlineDiff) {
      lines.push(
        `The staged snapshot directory is ${this.#snapshotDir}.`,
        'The complete staged diff is inlined below between the STAGED DIFF markers — it is authoritative. You MUST NOT run git diff, git show, or git cat-file to obtain review content; the snapshot directory is for reading full source files only.',
        'Embed the inline diff verbatim into every subagent task text: the context scout keeps file paths for repository context, while both risk hunters and the verifier receive the diff inline instead of the .review/diff.patch path.',
        'Read every source file from that staged snapshot directory, never from the working tree. Use the repository only for read-only Git metadata and project skill discovery.',
        '---STAGED DIFF (inline, authoritative)---',
        this.#inlineDiff,
        '---END STAGED DIFF---',
      );
    } else if (this.#snapshotDir) {
      lines.push(
        `The staged snapshot directory is ${this.#snapshotDir}.`,
        `The complete staged diff is materialized at ${this.#snapshotDir}/.review/diff.patch and the changed-file list at ${this.#snapshotDir}/.review/changed-files.txt. Read them as files; do not run git diff or git show to obtain review content.`,
        'Read every source file from that staged snapshot directory, never from the working tree. Use the repository only for read-only Git metadata and project skill discovery.',
      );
    }
    if (this.#changedPaths.length > 0) {
      lines.push(
        `The changed paths for this review are: ${this.#changedPaths.map((p) => sanitizePromptToken(p)).join(', ')}.`,
        'Pass these paths to the context scout in its task text so it does not re-derive them from the diff.',
      );
    }
    if (this.#fileClasses.length > 0) {
      const classLines = this.#fileClasses.map((e) => `${sanitizePromptToken(e?.path)}: ${sanitizePromptToken(e?.fileClass)}`);
      lines.push(
        'File-class manifest (deterministic path-only classification, materialized at .review/file-classes.json):',
        ...classLines,
      );
    }
    if (this.#contextPackPath) {
      lines.push(
        `A deterministic context pack for the scout is at \`${this.#contextPackPath}\`: changed files, changed symbols with who references them, and the test-file mapping, all built by the runner from the staged snapshot.`,
        'Pass that path to the context scout in its task text: the scout starts from the pack and finishes in a few batches of tool calls instead of sweeping the repository. The pack is read-only input; never write to it.',
      );
    }
    if (this.#suspicionMapText) {
      lines.push('', this.#suspicionMapText);
    }
    if (this.#executionEvidenceText) {
      lines.push('', this.#executionEvidenceText);
    }
    if (this.#roundContextText) {
      lines.push('', this.#roundContextText);
    }
    if (this.#scoutBaselineText) {
      lines.push('', 'Embed the SCOUT BASELINE block below verbatim in the context scout task text only (not in the hunter or verifier tasks):', this.#scoutBaselineText);
    }
    lines.push(`The staged diff hash for this hook invocation is ${this.#diffHash}.`);
    if (this.#reportPath) lines.push(`The durable per-run report path for this review is \`${this.#reportPath}\`. Instruct the reviewer-kit task to write its complete final report verbatim to that path before yielding, as a best-effort durable copy: if a project policy guard denies the write, the task must not retry or work around it, because the runner recovers the report from the task session artifacts. It is the only path the task may write.`);
    if (this.#reviewProfile) lines.push(`Review profile for this diff: ${this.#reviewProfile}.`);
    if (Array.isArray(this.#riskLanes)) lines.push(`Risk lanes for this diff: ${JSON.stringify(this.#riskLanes)}.`);
    if (this.#hunterShardsText) lines.push(this.#hunterShardsText);
    return lines.join('\n');
  }

  #toReemitString() {
    const repair = this.#repairEnvelope
      ? 'The original verdict is BLOCK and must stay BLOCK: change no finding, priority, or verdict. Its rejection envelope is missing or malformed, so the output must contain exactly one valid envelope — the line REVIEW_REJECTION_ENVELOPE_BEGIN, one strict JSON object of schema review-rejection-envelope@1 describing exactly the findings already reported, the line REVIEW_REJECTION_ENVELOPE_END — immediately followed by the standalone REVIEW_RESULT=BLOCK line. ' : '';
    return repair + 'Reproduce the following review report verbatim as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it. The verdict contract overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line as the last non-empty line of the output — markers anywhere else are ignored — even if the input describes a different verdict vocabulary.\n\n---ORIGINAL OUTPUT---\n' + this.#reemitOutput;
  }

  get diffHash() {
    return this.#diffHash;
  }

  get reportPath() {
    return this.#reportPath;
  }

  get snapshotDir() {
    return this.#snapshotDir;
  }

  get changedPaths() {
    return [...this.#changedPaths];
  }

  get suspicionMapText() {
    return this.#suspicionMapText;
  }

  get executionEvidenceText() {
    return this.#executionEvidenceText;
  }

  get contextPackPath() {
    return this.#contextPackPath;
  }

  get scoutBaselineText() {
    return this.#scoutBaselineText;
  }

  get hunterShardsText() {
    return this.#hunterShardsText;
  }

  get roundContextText() {
    return this.#roundContextText;
  }
}
