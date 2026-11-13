// Verdict over OMP's native task results. Pure: it reads the reviewer's final yield and the
// nested stage results OMP attaches to that yield. It never reads, sets or compares a model,
// role, effort or fallback: those belong to OMP and the owner's configuration.

export const PASS_MARKER = 'REVIEW_RESULT=PASS';
export const BLOCK_MARKER = 'REVIEW_RESULT=BLOCK';
export const SCOUT_AGENT = 'review-context-scout';
export const HUNTER_AGENT = 'review-risk-hunter';
export const VERIFIER_AGENT = 'review-finding-verifier';
export const MAINTAINABILITY_AGENT = 'review-maintainability';

/**
 * Reads the single verdict marker of a reviewer's Markdown. The marker must be the only line
 * that starts with `REVIEW_RESULT=`, it must be exactly `PASS` or `BLOCK`, and it must be the
 * last non-empty line, so a marker quoted inside the report never counts.
 *
 * @param {string} text
 * @returns {{ verdict: 'PASS'|'BLOCK'|null, reason: string|null }}
 */
export function readVerdictMarker(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim());
  const nonEmpty = lines.filter(line => line.length > 0);
  const markers = nonEmpty.filter(line => line.startsWith('REVIEW_RESULT='));
  if (markers.length !== 1) return { verdict: null, reason: `reviewer verdict markers: ${markers.length} (expected 1)` };
  const [marker] = markers;
  if (marker !== PASS_MARKER && marker !== BLOCK_MARKER) return { verdict: null, reason: 'reviewer verdict marker is not PASS or BLOCK' };
  if (nonEmpty[nonEmpty.length - 1] !== marker) return { verdict: null, reason: 'reviewer verdict marker is not the last line' };
  return { verdict: marker === PASS_MARKER ? 'PASS' : 'BLOCK', reason: null };
}

/** A stage counts as evidence only when OMP completed it with a valid structured result. */
export function stageCompleted(stage) {
  return stage.exitCode === 0 && stage.aborted !== true && stage.structuredStatus === 'valid';
}

/**
 * Whether one verifier-confirmed coverage gap may block the commit. The gate never demands a
 * test for code that its own file class exempts, for a file class no runnable harness can
 * execute, or for a gap whose impact was not proven. A gap that omits the new fields keeps the
 * legacy fail-closed behavior: an omitted severity is treated as blocking.
 *
 * @param {object} gap
 * @param {{ harnessAbsent?: boolean, fileClasses?: Map<string, string> }} [context]
 * @returns {boolean}
 */
export function coverageGapBlocks(gap, { harnessAbsent = false, fileClasses = new Map() } = {}) {
  if (!gap || typeof gap !== 'object') return true;
  if (harnessAbsent) return false;
  if (gap.severity === 'advisory') return false;
  if (gap.test_harness === 'absent') return false;
  const fromManifest = fileClasses.get(normalizePath(gap.file_path));
  const declaredClass = fromManifest ?? (typeof gap.file_class === 'string' ? gap.file_class : undefined);
  if (declaredClass === 'test') return false;
  if (gap.severity === 'blocking') return hasText(gap.impact);
  return true;
}

function normalizePath(filePath) {
  return typeof filePath === 'string' ? filePath.replace(/\\/g, '/') : '';
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A lane identifier folded for comparison: trimmed and lower-cased. Anything that is not a string
 * names no lane, which is different from naming an unexpected one.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeLane(value) {
  if (typeof value !== 'string') return null;
  const lane = value.trim().toLowerCase();
  return lane.length > 0 ? lane : null;
}

function classIndex(fileClasses) {
  const index = new Map();
  for (const entry of Array.isArray(fileClasses) ? fileClasses : []) {
    if (!entry || typeof entry.path !== 'string') continue;
    index.set(normalizePath(entry.path), entry.fileClass);
  }
  return index;
}

/**
 * Whether one maintainability candidate may stop the commit. Blocking needs all four machine
 * fields at once: a confirmed decision, a stated maintenance cost, priority `P2`, and not being a
 * pure forwarder. Text in the report never contributes.
 *
 * @param {object} candidate
 * @returns {boolean}
 */
export function maintainabilityBlocks(candidate, { centralization = new Set() } = {}) {
  if (!candidate || typeof candidate !== 'object') return false;
  const id = candidate.candidate_id ?? candidate.groupId ?? candidate.id;
  // A group that is one shared contract with its consumers and its test is the shape of a single
  // definition, not a duplicated design: it is centralisation, and the policy exempts it.
  if (id && centralization.has(id)) return false;
  if (candidate.decision !== 'confirmed') return false;
  if (candidate.forwarding_only === true) return false;
  if (candidate.priority !== 'P2') return false;
  return hasText(candidate.stated_cost);
}

/**
 * What the completed stages themselves confirmed. A hunter candidate is a lead, not evidence: only
 * the verifier's confirmation, a blocking coverage gap under the same rules the PASS gate applies,
 * and a maintainability item the policy lets block, count. Nothing here decides the verdict; it
 * decides which reason a BLOCK carries, so a block no stage supported cannot read as a finding.
 */
function confirmedFindingCount(stage) {
  // One claim has one record: a confirmed claim may arrive as a confirmed finding or as a confirmed
  // disposition, so the larger count is the answer and the two never add up.
  const findings = listLength(stage.data?.confirmed_findings);
  // The verifier's published vocabulary has two confirming dispositions; the gate must read the
  // same two the host reads, or a confirmed defect is reported as unsupported narration.
  const confirmedDecisions = Array.isArray(stage.data?.decisions)
    ? stage.data.decisions.filter(decision => ['confirmed', 'still_present'].includes(String(decision?.disposition ?? ''))).length
    : 0;
  return Math.max(findings, confirmedDecisions);
}

function confirmedStageEvidence({ verifiers, scouts, fileClasses, maintainabilitySummary, maintainabilityStages, maintainabilityCentralization }) {
  const confirmedFindings = verifiers.reduce((count, stage) => count + confirmedFindingCount(stage), 0);
  const harnessAbsent = !scouts.map(stage => stage.data?.test_harness).includes('present');
  const classes = classIndex(fileClasses);
  const confirmedGaps = verifiers.flatMap(stage => (Array.isArray(stage.data?.confirmed_coverage_gaps)
    ? stage.data.confirmed_coverage_gaps
    : []));
  const blockingGaps = confirmedGaps.filter(gap => coverageGapBlocks(gap, { harnessAbsent, fileClasses: classes })).length;
  const blockingMaintainability = maintainabilitySummary && maintainabilitySummary.policy === 'block'
    ? maintainabilityStages
      .flatMap(stage => (Array.isArray(stage.data?.candidates) ? stage.data.candidates : []))
      .filter(candidate => maintainabilityBlocks(candidate, { centralization: maintainabilityCentralization })).length
    : 0;
  return { confirmedFindings, blockingGaps, blockingMaintainability };
}

// A sentence that reports the absence of findings is not a finding: it names what the section does
// not contain, and it must not turn a clean PASS into a block or a recheck. A bullet that cites a
// file or a line is a finding whatever it says about absence, so the two tests are read together.
const ABSENT_FINDING = /^(?:no|none|nothing|zero)\b[^:]{0,60}\b(?:findings?|issues?|defects?|problems?)\b/i;
const FINDING_SIGNAL = /\.(?:mjs|js|ts|tsx|jsx|py|go|rb|java|cs|rs|php|md|json|ya?ml|html?|css)\b|:\d+/i;
const absentFinding = key => ABSENT_FINDING.test(key) && !FINDING_SIGNAL.test(key);

const EMPTY_FINDING = new Set(['none', 'none required', 'no findings', 'n/a', '-', '—', '–', 'нет', 'нет находок']);

/**
 * The bullets the report itself states under `### Confirmed findings`. A bullet with a P1/P2
 * priority is a structured finding; any other non-empty bullet still claims a finding, which is
 * what lets the verdict name a report that contradicts the stages instead of repeating it.
 * @param {string|null|undefined} text
 * @returns {{ bullets: number, structured: number, items: string[] }}
 */
export function reportFindings(text) {
  if (typeof text !== 'string') return { bullets: 0, structured: 0, items: [] };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^#{2,3}\s+confirmed findings\s*$/i.test(line.trim()));
  if (start === -1) return { bullets: 0, structured: 0, items: [] };
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3}\s+\S/.test(line)) break;
    section.push(line);
  }
  // A finding is one entry at the shallowest marker depth of the section: the report writes a
  // finding as a bullet or a numbered item and its eight fields as indented sub-bullets, so a
  // nested field line is never a claim of its own. A section indented as a whole still reads.
  const markers = section
    .map(line => /^(\s*)(?:[-*]|\d+[.)])\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(match => ({ indent: match[1].length, text: match[2] }));
  if (markers.length === 0) return { bullets: 0, structured: 0, items: [] };
  const depth = Math.min(...markers.map(marker => marker.indent));
  const items = [];
  for (const marker of markers) {
    if (marker.indent !== depth) continue;
    const plain = marker.text.replace(/[*_`]/g, '').trim();
    const key = plain.replace(/[.;:,]+$/, '').trim().toLowerCase();
    if (key.length === 0 || EMPTY_FINDING.has(key) || absentFinding(key)) continue;
    items.push(plain);
  }
  return { bullets: items.length, structured: items.filter(item => /\bP[12]\b/.test(item)).length, items };
}

/**
 * @param {{
 *   reviewer: { exitCode: number|null, aborted: boolean, yieldStatus: string|null, text: string } | undefined,
 *   stages: Array<{ agent: string|null, exitCode: number|null, aborted: boolean, structuredStatus: string|null, data: object|null }>,
 *   profile: 'full'|'spec-docs',
 *   lanes: string[],
 *   fileClasses?: Array<{ path: string, fileClass: string }>,
 *   planned?: string[],
 *   maintainability?: { policy: 'off'|'advisory'|'block', status: string|null, coverage: string|null, planned: boolean }|null,
 *   recheck?: { verdict: 'confirmed'|'rejected'|'unsettled'|'failed', findings: number, confirmed?: number }|null,
 * }} input
 * @returns {{ pass: boolean, verdict: 'PASS'|'BLOCK', reasons: string[], notes: string[], recheckNeeded: boolean }}
 *
 * `recheck` is the host's report of a stage it ran over the report's own claims; the function never
 * invents one. A `rejected` recheck may pass the review only when every claim was decided, and the
 * recheck stage itself is excluded from the mandatory-stage checks by its `recheck` marker.
 */
export function evaluateReview({ reviewer, stages, profile, lanes, fileClasses = [], planned = [], maintainability = null, contract = null, maintainabilityCentralization = new Set(), recheck = null }) {
  const reasons = [];
  const notes = [];
  if (!reviewer) {
    reasons.push('reviewer task result missing');
  } else {
    if (reviewer.aborted) reasons.push('reviewer task aborted');
    if (reviewer.exitCode !== 0) reasons.push(`reviewer task exit ${reviewer.exitCode}`);
    if (reviewer.yieldStatus !== 'success') reasons.push(`reviewer yield ${reviewer.yieldStatus ?? 'missing'}`);
  }

  const marker = reviewer?.text == null
    ? { verdict: null, reason: null }
    : readVerdictMarker(reviewer.text);
  if (reviewer && reviewer.text == null) {
    const payload = Array.isArray(reviewer.yieldPayload) && reviewer.yieldPayload.length > 0 ? ` (payload: ${reviewer.yieldPayload.join(', ')})` : '';
    reasons.push(`reviewer yield carries no Markdown report${payload}`);
  }
  if (marker.reason) reasons.push(marker.reason);

  // A re-verification is evidence about the report, never a substitute for a planned stage: it is
  // excluded from the mandatory-stage checks and still feeds the confirmed-evidence calculation.
  const completed = agent => stages.filter(stage => stage.recheck !== true && stage.agent === agent && stageCompleted(stage));
  const scouts = completed(SCOUT_AGENT);
  if (scouts.length < 1) reasons.push(`no completed stage evidence for ${SCOUT_AGENT}`);

  const hunters = completed(HUNTER_AGENT);
  // A lane is an identifier, not a sentence: case and surrounding spaces must not decide whether a
  // hunter that ran counts as evidence. A stage that reported no lane at all still cannot satisfy a
  // planned lane, and the reason then names what did arrive so the next occurrence is diagnosable.
  const coveredLanes = new Set(hunters.map(stage => normalizeLane(stage.data?.lane)).filter(lane => lane !== null));
  const observedLanes = [...coveredLanes].sort();
  const missingLanes = lanes.filter(lane => !coveredLanes.has(normalizeLane(lane)));
  if (missingLanes.length > 0) {
    const observed = observedLanes.length > 0 ? ` (observed: ${observedLanes.join(', ')})` : ' (observed: none)';
    reasons.push(`no completed ${HUNTER_AGENT} task for planned lane(s): ${missingLanes.join(', ')}${observed}`);
  }

  const verifiers = completed(VERIFIER_AGENT);
  const verifierEvidence = stages.filter(stage => stage.agent === VERIFIER_AGENT && stageCompleted(stage));
  if (profile === 'full' && verifiers.length < 1) reasons.push(`no completed stage evidence for ${VERIFIER_AGENT}`);

  if (Array.isArray(planned) && planned.length > 0) {
    const missing = planned.filter(name => completed(name).length === 0);
    if (missing.length > 0) reasons.push(`no completed stage evidence for planned agent(s): ${missing.join(', ')}`);
  }

  const maintainabilitySummary = maintainability && typeof maintainability === 'object' ? maintainability : null;
  const maintainabilityStages = completed(MAINTAINABILITY_AGENT);
  if (maintainabilitySummary && maintainabilitySummary.policy !== 'off') {
    if (maintainabilitySummary.status === 'failed') reasons.push('maintainability analysis failed');
    if (maintainabilitySummary.planned === true && maintainabilityStages.length === 0) {
      reasons.push(`no completed stage evidence for ${MAINTAINABILITY_AGENT}`);
    }
  }

  const evidence = confirmedStageEvidence({
    verifiers: verifierEvidence,
    scouts,
    fileClasses,
    maintainabilitySummary,
    maintainabilityStages,
    maintainabilityCentralization,
  });
  const findings = reportFindings(reviewer?.text);
  const recheckState = recheck && typeof recheck === 'object' ? recheck : null;
  // A PASS may not stand against the stages' own confirmed results.
  if (marker.verdict === 'PASS') {
    if (evidence.confirmedFindings > 0) reasons.push(`verifier confirmed ${evidence.confirmedFindings} finding(s) but the reviewer passed`);
    if (evidence.blockingGaps > 0) {
      reasons.push(`verifier confirmed ${evidence.blockingGaps} blocking coverage gap(s) with a test harness but the reviewer passed`);
    }
    if (evidence.blockingMaintainability > 0) {
      reasons.push(`${MAINTAINABILITY_AGENT} confirmed ${evidence.blockingMaintainability} maintainability item(s) with a stated cost but the reviewer passed`);
    }
    if (findings.structured > 0) {
      reasons.push(`report lists ${findings.structured} finding(s) with a priority but the reviewer passed`);
    }
  }

  const reasonsBeforeBlock = reasons.length;
  if (marker.verdict === 'BLOCK') {
    const stageConfirmed = evidence.confirmedFindings + evidence.blockingGaps + evidence.blockingMaintainability;
    if (stageConfirmed > 0) {
      reasons.push('reviewer verdict BLOCK');
      if (recheckState?.verdict === 'confirmed') {
        reasons.push(`re-verification confirmed ${recheckState.confirmed ?? 0} finding(s) the report raised`);
      }
    } else if (recheckState?.verdict === 'rejected') {
      // The narrator named findings no stage confirmed, and a verifier was asked to settle exactly
      // those claims against the snapshot and rejected them. The evidence is complete and the
      // contradiction was adjudicated, so the block is the report's, not the change's.
      notes.push(`re-verification rejected ${recheckState.findings ?? 0} finding(s) the report raised; the stages confirmed none`);
    } else if (recheckState?.verdict === 'failed') {
      reasons.push('reviewer verdict BLOCK without stage confirmation');
      reasons.push('re-verification did not settle the finding(s) the report raised');
    } else if (recheckState?.verdict === 'unsettled') {
      reasons.push('reviewer verdict BLOCK without stage confirmation');
      reasons.push('re-verification left the finding(s) the report raised unproven');
    } else {
      // Fail-closed is unchanged: the commit is still blocked. The reason says what actually
      // happened, so a block no stage supported cannot be read as a defect of the change.
      reasons.push('reviewer verdict BLOCK without stage confirmation');
      if (findings.bullets > 0) {
        reasons.push(`report lists ${findings.bullets} confirmed finding(s) that no stage confirmed`);
      }
    }
  }
  const reasonsAddedByBlock = reasons.length - reasonsBeforeBlock;
  // A producer/consumer pair is settled by calling it: the reader either accepts the record the
  // writer produces or throws. That answer needs no model and no interpretation.
  const contractSummary = contract && typeof contract === 'object' ? contract : null;
  if (contractSummary && contractSummary.policy !== 'off') {
    if (contractSummary.status === 'failed') reasons.push(`contract analysis failed: ${contractSummary.note ?? 'no reason recorded'}`);
    if (contractSummary.status === 'contract-violated' && contractSummary.policy === 'block') {
      for (const rejection of contractSummary.rejected ?? []) {
        reasons.push(`contract violated: ${rejection.file} ${rejection.writer} produces a record ${rejection.reader} rejects (${rejection.error})`);
      }
    }
  }
  const recheckNeeded = recheckState === null
    && marker.verdict === 'BLOCK'
    && evidence.confirmedFindings + evidence.blockingGaps + evidence.blockingMaintainability === 0
    && findings.bullets > 0
    // A second verifier pass cannot remove any other blocker, so it is spent only when the report's
    // contradiction is the one thing keeping the commit refused.
    && reasons.length === reasonsAddedByBlock;
  const adjudicated = marker.verdict === 'BLOCK' && recheckState?.verdict === 'rejected';
  const pass = reasons.length === 0 && (marker.verdict === 'PASS' || adjudicated);
  return { pass, verdict: pass ? 'PASS' : 'BLOCK', reasons, notes, recheckNeeded };
}

function listLength(value) {
  return Array.isArray(value) ? value.length : 0;
}
