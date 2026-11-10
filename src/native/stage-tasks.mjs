// Task texts of the host-driven review stages. The host runs one native task per stage, so the text
// that used to be composed by the orchestrator is composed here: the same inputs, the same rules,
// and no model, role, effort or fallback named anywhere.

import { buildAssignment } from './assignment.mjs';

/**
 * The staged inputs every stage reads, plus the one line that says which stage this task is.
 *
 * @param {object} input
 * @param {string} role
 * @returns {string}
 */
function stagedInputs(input, role) {
  return [buildAssignment(input), '', role].join('\n');
}

/**
 * Stage 1: the context scout.
 *
 * @param {object} input
 * @returns {string}
 */
export function scoutTask(input) {
  return stagedInputs(
    input,
    'You are the context scout stage of this review: produce the structured context your agent contract defines. Do not review, do not report defects, do not emit a verdict marker.',
  );
}

/**
 * Stage 2: one hunter for one lane. The complete scout result is supplied, so the lane never
 * re-derives the diff.
 *
 * @param {{ input: object, scout: object, lane: string, budget: number }} args
 * @returns {string}
 */
export function hunterTask({ input, scout, lane, budget }) {
  return stagedInputs(
    input,
    [
      `You are the only hunter for lane: ${lane}`,
      `Tool budget for this lane: ${budget} calls`,
      '',
      'Structured context from the context scout stage:',
      '```json',
      JSON.stringify(scout ?? null, null, 2),
      '```',
    ].join('\n'),
  );
}

/**
 * Stage 2b: the maintainability stage. Its subject is the deterministic candidate file, not the diff.
 *
 * @param {{ snapshotDir: string, candidatePath: string, policy: string, profile: string, budget: number }} args
 * @returns {string}
 */
export function maintainabilityTask({ snapshotDir, candidatePath, policy, profile, budget }) {
  return [
    `Staged snapshot directory: ${snapshotDir}`,
    `Candidate file (deterministic, written before this task): ${candidatePath}`,
    `Policy: ${policy}`,
    `Profile: ${profile}`,
    `Budget: about ${budget} tool calls for the whole candidate file`,
    '',
    'You are the maintainability stage of this review: decide every group in the candidate file exactly as your agent contract defines. Do not review the diff and do not emit a verdict marker.',
  ].join('\n');
}

/**
 * Stage 3: the adversarial verifier over every candidate of every lane and the coverage gaps.
 *
 * @param {{ input: object, scout: object, hunters: Array<{ lane: string|null, data: object|null }>, coverageGaps: object[], profile: string }} args
 * @returns {string}
 */
export function verifierTask({ input, scout, hunters, coverageGaps, profile }) {
  const candidates = hunters.flatMap(hunter =>
    (Array.isArray(hunter.data?.candidates) ? hunter.data.candidates : []).map(candidate => ({ lane: hunter.lane, candidate })),
  );
  return stagedInputs(
    input,
    [
      `Profile: ${profile}`,
      'You are the adversarial verifier stage of this review: challenge every candidate and every coverage gap against repository evidence exactly as your agent contract defines.',
      '',
      'Structured context from the context scout stage:',
      '```json',
      JSON.stringify(scout ?? null, null, 2),
      '```',
      '',
      'Candidates from every hunter lane:',
      '```json',
      JSON.stringify(candidates, null, 2),
      '```',
      '',
      'Coverage gaps from every hunter lane:',
      '```json',
      JSON.stringify(coverageGaps, null, 2),
      '```',
      '',
      'Maintainability candidates are not yours: they never enter confirmed findings or confirmed coverage gaps.',
    ].join('\n'),
  );
}

/**
 * Stage 4: synthesis. The stage results are supplied as data; the agent writes the report and its
 * single verdict marker.
 *
 * @param {{
 *   input: object,
 *   scout: object|null,
 *   hunters: Array<{ lane: string|null, data: object|null }>,
 *   maintainability: object|null,
 *   verifier: object|null,
 *   profile: string,
 *   lanes: string[],
 * }} args
 * @returns {string}
 */
export function synthesisTask({ input, scout, hunters, maintainability, verifier, profile, lanes }) {
  return stagedInputs(
    input,
    [
      `Profile: ${profile}; lanes: ${JSON.stringify(lanes)}`,
      'You are the final synthesis stage of this review. Every earlier stage already ran; their structured results are supplied below. Do not spawn a subagent and do not re-run a stage.',
      '',
      'Context scout result:',
      '```json',
      JSON.stringify(scout ?? null, null, 2),
      '```',
      '',
      'Hunter results:',
      '```json',
      JSON.stringify(hunters, null, 2),
      '```',
      '',
      'Maintainability stage result:',
      '```json',
      JSON.stringify(maintainability ?? null, null, 2),
      '```',
      '',
      'Verifier result:',
      '```json',
      JSON.stringify(verifier ?? null, null, 2),
      '```',
      '',
      'Write the report exactly as your agent contract defines, and end it with the single verdict marker.',
    ].join('\n'),
  );
}
