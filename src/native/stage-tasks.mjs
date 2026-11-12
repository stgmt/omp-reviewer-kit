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
 * Stage 3: the adversarial verifier over every candidate of every lane, the shapes a changed
 * function shares with an existing one, and the coverage gaps.
 *
 * @param {{ input: object, scout: object, hunters: Array<{ lane: string|null, data: object|null }>, coverageGaps: object[], duplicates?: object[], profile: string }} args
 * @returns {string}
 */
export function verifierTask({ input, scout, hunters, coverageGaps, duplicates = [], profile }) {
  const candidates = hunters.flatMap(hunter =>
    (Array.isArray(hunter.data?.candidates) ? hunter.data.candidates : []).map(candidate => ({ lane: hunter.lane, candidate })),
  );
  // The deterministic shape scan answers "does this already exist under another name". It is a lead,
  // not a finding: the pair is decided here, and a confirmed one blocks through confirmed findings.
  const duplicateCandidates = (Array.isArray(duplicates) ? duplicates : []).map((pair, index) => ({
    candidate_id: `reuse-${index + 1}`,
    lane: 'reuse',
    changed: `${pair.changedPath}:${pair.changedLine}`,
    changed_name: pair.changedName ?? null,
    existing: `${pair.existingPath}:${pair.existingLine}`,
    existing_name: pair.existingName ?? null,
    similarity: pair.similarity,
    shared_calls: Array.isArray(pair.sharedCalls) ? pair.sharedCalls : [],
  }));
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
      'Shape duplicates (deterministic scan of the snapshot, not findings): each entry pairs a changed function with an existing one whose shape it repeats. Decide each as a candidate `reuse-N`: confirm it only when both ranges implement the same responsibility and the staged side adds no product capability, and then name both `path:line` pairs in the confirmed finding. Reject boilerplate, a thin wrapper over the existing unit, a test fixture, and a pair whose difference is the product change itself.',
      '```json',
      JSON.stringify(duplicateCandidates, null, 2),
      '```',
      '',
      'Maintainability candidates are not yours: they never enter confirmed findings or confirmed coverage gaps.',
    ].join('\n'),
  );
}

/**
 * The scout fields that are prose about the change rather than facts about the diff. `change_goal`
 * and `claims` are exactly where a documented history of an earlier BLOCK re-enters the review as
 * if it described the staged change, so the synthesis stage never receives them: a finding must
 * come from a stage that read the snapshot and confirmed it.
 */
const SCOUT_NARRATIVE_FIELDS = ['change_goal', 'claims'];

function scoutFacts(scout) {
  if (!scout || typeof scout !== 'object' || Array.isArray(scout)) return null;
  const facts = { ...scout };
  for (const field of SCOUT_NARRATIVE_FIELDS) delete facts[field];
  return facts;
}

/**
 * Stage 5: the re-verification of a report whose findings no stage confirmed. The synthesis can only
 * propose: a claim it makes is settled by calling it against the staged snapshot, exactly as a
 * hunter candidate is. The claims are supplied verbatim; nothing else about the report travels.
 *
 * @param {{ snapshotDir: string, findings: string[] }} args
 * @returns {string}
 */
export function recheckTask({ snapshotDir, findings }) {
  const claims = (Array.isArray(findings) ? findings : [])
    .map((finding, index) => `${index + 1}. ${typeof finding === 'string' ? finding.replace(/\s+/g, ' ').trim() : String(finding)}`);
  return [
    `Staged snapshot directory: ${snapshotDir}`,
    `Diff file (complete staged diff, byte-exact): ${snapshotDir}/.review/diff.patch`,
    `Changed-file manifest: ${snapshotDir}/.review/changed-files.txt`,
    `File-class manifest (deterministic, do not re-classify): ${snapshotDir}/.review/file-classes.json`,
    '',
    'You are the adversarial verifier stage of this review, asked a second time. The final synthesis reported a BLOCK whose findings no stage confirmed. Decide every claim below against the staged snapshot: confirm it only when the snapshot shows the defect exactly as stated, and reject every claim the snapshot does not support.',
    '',
    'Claims the report made, verbatim:',
    ...claims,
    '',
    'Every source file read must come from the snapshot directory; the repository is for read-only Git metadata only. Emit the structured result your agent contract defines.',
  ].join('\n');
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
      'Context scout facts (its free-text change goal and claims are not supplied: prose may restate a past blocker recorded in the diff, and it is never evidence):',
      '```json',
      JSON.stringify(scoutFacts(scout), null, 2),
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
      'A confirmed finding must come from the verifier result. Write the report exactly as your agent contract defines, and end it with the single verdict marker.',
    ].join('\n'),
  );
}
