// Verdict over OMP's native task results. Pure: it reads the reviewer's final yield and the
// nested stage results OMP attaches to that yield. It never reads, sets or compares a model,
// role, effort or fallback: those belong to OMP and the owner's configuration.

export const PASS_MARKER = 'REVIEW_RESULT=PASS';
export const BLOCK_MARKER = 'REVIEW_RESULT=BLOCK';
export const SCOUT_AGENT = 'review-context-scout';
export const HUNTER_AGENT = 'review-risk-hunter';
export const VERIFIER_AGENT = 'review-finding-verifier';

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
 * @param {{
 *   reviewer: { exitCode: number|null, aborted: boolean, yieldStatus: string|null, text: string } | undefined,
 *   stages: Array<{ agent: string|null, exitCode: number|null, aborted: boolean, structuredStatus: string|null, data: object|null }>,
 *   profile: 'full'|'spec-docs',
 *   lanes: string[],
 * }} input
 * @returns {{ pass: boolean, verdict: 'PASS'|'BLOCK', reasons: string[] }}
 */
export function evaluateReview({ reviewer, stages, profile, lanes }) {
  const reasons = [];
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
  if (reviewer && reviewer.text == null) reasons.push('reviewer yield carries no Markdown report');
  if (marker.reason) reasons.push(marker.reason);

  const completed = agent => stages.filter(stage => stage.agent === agent && stageCompleted(stage));
  const scouts = completed(SCOUT_AGENT);
  if (scouts.length < 1) reasons.push(`no completed stage evidence for ${SCOUT_AGENT}`);

  const hunters = completed(HUNTER_AGENT);
  const coveredLanes = new Set(hunters.map(stage => stage.data?.lane));
  const missingLanes = lanes.filter(lane => !coveredLanes.has(lane));
  if (missingLanes.length > 0) {
    reasons.push(`no completed ${HUNTER_AGENT} task for planned lane(s): ${missingLanes.join(', ')}`);
  }

  const verifiers = completed(VERIFIER_AGENT);
  if (profile === 'full' && verifiers.length < 1) reasons.push(`no completed stage evidence for ${VERIFIER_AGENT}`);

  // A PASS may not stand against the stages' own confirmed results.
  if (marker.verdict === 'PASS') {
    const confirmedFindings = verifiers.reduce((count, stage) => count + listLength(stage.data?.confirmed_findings), 0);
    if (confirmedFindings > 0) reasons.push(`verifier confirmed ${confirmedFindings} finding(s) but the reviewer passed`);
    const testHarness = scouts.map(stage => stage.data?.test_harness);
    const confirmedGaps = verifiers.reduce((count, stage) => count + listLength(stage.data?.confirmed_coverage_gaps), 0);
    if (confirmedGaps > 0 && testHarness.includes('present')) {
      reasons.push(`verifier confirmed ${confirmedGaps} coverage gap(s) with a test harness but the reviewer passed`);
    }
  }

  if (marker.verdict === 'BLOCK') reasons.push('reviewer verdict BLOCK');
  const pass = reasons.length === 0 && marker.verdict === 'PASS';
  return { pass, verdict: pass ? 'PASS' : 'BLOCK', reasons };
}

function listLength(value) {
  return Array.isArray(value) ? value.length : 0;
}
