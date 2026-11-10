// One journal entry per review of one exact index state: the key that identifies it, the stage plan
// of a review, and the rules that decide whether a stored entry may be reused. Pure: no file system,
// no process and no model lives here, so every rule below is testable without a review run.

import { createHash } from 'node:crypto';

export const JOURNAL_SCHEMA = 'review-journal@1';
export const STAGE_SCHEMA = 'review-stage@1';
export const JOURNAL_POLICIES = Object.freeze(['off', 'read-write']);
export const JOURNAL_POLICY_ENV = 'OMP_REVIEW_KIT_JOURNAL';
export const JOURNAL_DIR_ENV = 'OMP_REVIEW_KIT_JOURNAL_DIR';

export const SCOUT_STAGE = 'review-context-scout';
export const HUNTER_STAGE = 'review-risk-hunter';
export const MAINTAINABILITY_STAGE = 'review-maintainability';
export const VERIFIER_STAGE = 'review-finding-verifier';
export const SYNTHESIS_STAGE = 'reviewer-kit';

const VERDICTS = new Set(['PASS', 'BLOCK']);

/**
 * A configuration object reduced to sorted primitive entries, so the fingerprint depends on the values
 * and not on the order in which a caller happened to build the object.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>|null}
 */
function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (typeof entry === 'number' && Number.isFinite(entry)) normalized[key] = entry;
    else if (typeof entry === 'string') normalized[key] = entry;
    else if (typeof entry === 'boolean') normalized[key] = entry;
  }
  return normalized;
}

/** A digest over the parts, joined so two different tuples cannot produce the same string. */
function digest(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * The configuration a verdict was produced under. Two runs that differ in profile, lanes or a stage
 * policy asked different questions, so their answers must not be swapped.
 *
 * @param {{
 *   profile?: string|null,
 *   lanes?: string[],
 *   maintainabilityPolicy?: string|null,
 *   reusePolicy?: string|null,
 *   contractPolicy?: string|null,
 *   reuseMaxLines?: number|null,
 *   maintainabilityConfig?: object|null,
 * }} [input]
 * @returns {string}
 */
export function configFingerprint({
  profile = null,
  lanes = [],
  maintainabilityPolicy = null,
  reusePolicy = null,
  contractPolicy = null,
  reuseMaxLines = null,
  maintainabilityConfig = null,
} = {}) {
  const normalized = {
    profile: typeof profile === 'string' ? profile : null,
    lanes: [...new Set((Array.isArray(lanes) ? lanes : []).map(lane => String(lane).trim().toLowerCase()).filter(Boolean))].sort(),
    maintainabilityPolicy: maintainabilityPolicy ?? null,
    reusePolicy: reusePolicy ?? null,
    contractPolicy: contractPolicy ?? null,
    reuseMaxLines: typeof reuseMaxLines === 'number' && Number.isFinite(reuseMaxLines) ? reuseMaxLines : null,
    // The maintainability thresholds decide which groups are delivered, so a verdict decided under
    // one set must not answer a review run under another.
    maintainabilityConfig: normalizeConfig(maintainabilityConfig),
  };
  return digest([JSON.stringify(normalized)]);
}

/**
 * The key of one review: the repository, the exact index tree, the diff it was read from, and the
 * kit that asked the question. `treeOid` is what makes staged junk matter: an ignored file that
 * reaches the index changes the tree, so an older verdict cannot be reused for a different tree.
 *
 * @param {{
 *   repoIdentity?: string|null,
 *   treeOid?: string|null,
 *   diffHash?: string|null,
 *   kitVersion?: string|null,
 *   agentsDigest?: string|null,
 *   configFingerprint?: string|null,
 * }} [input]
 * @returns {string|null} null when a part is missing: no key is better than a wrong one
 */
export function reviewKey({
  repoIdentity = null,
  treeOid = null,
  diffHash = null,
  kitVersion = null,
  agentsDigest = null,
  configFingerprint: fingerprint = null,
} = {}) {
  const parts = [repoIdentity, treeOid, diffHash, kitVersion, agentsDigest, fingerprint];
  if (parts.some(part => typeof part !== 'string' || part.length === 0)) return null;
  return digest(parts);
}

/**
 * The identity of one stage inside a review: its agent and, for a hunter, the lane it hunts.
 *
 * @param {string} agent
 * @param {string|null} [lane]
 * @returns {string}
 */
export function stageId(agent, lane = null) {
  const name = typeof agent === 'string' ? agent.trim() : '';
  const laneName = typeof lane === 'string' ? lane.trim().toLowerCase() : '';
  return laneName.length > 0 ? `${name}:${laneName}` : name;
}

/**
 * The stages a review must produce, in order, before synthesis. The verifier is added by the caller
 * once the profile and the candidates are known.
 *
 * @param {{ lanes?: string[], maintainabilityPlanned?: boolean }} [input]
 * @returns {string[]}
 */
export function planStages({ lanes = [], maintainabilityPlanned = false } = {}) {
  const hunters = (Array.isArray(lanes) ? lanes : []).map(lane => stageId(HUNTER_STAGE, lane));
  return [
    SCOUT_STAGE,
    ...hunters,
    ...(maintainabilityPlanned ? [MAINTAINABILITY_STAGE] : []),
  ];
}

/**
 * Whether a stored stage entry may be used for this review. The entry must belong to the same key and
 * stage, carry the current schema, and describe a completed structured result.
 *
 * @param {object|null|undefined} entry
 * @param {{ key: string, stageId: string }} expected
 * @returns {boolean}
 */
export function stageEntryValid(entry, { key, stageId: id } = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.schema !== STAGE_SCHEMA) return false;
  if (typeof key !== 'string' || entry.key !== key) return false;
  if (typeof id !== 'string' || entry.stageId !== id) return false;
  if (entry.exitCode !== 0) return false;
  if (entry.aborted === true) return false;
  return entry.structuredStatus === 'valid';
}

/**
 * Whether a stored journal may answer this review without running it. Only a finished verdict for
 * the same key counts; a journal of another schema, key or state is ignored, never migrated.
 *
 * @param {object|null|undefined} record
 * @param {{ key: string }} expected
 * @returns {boolean}
 */
export function verdictReusable(record, { key } = {}) {
  if (!record || typeof record !== 'object') return false;
  if (record.schema !== JOURNAL_SCHEMA) return false;
  if (typeof key !== 'string' || record.key !== key) return false;
  if (record.state !== 'done') return false;
  const verdict = record.verdict;
  if (!verdict || typeof verdict !== 'object') return false;
  if (typeof verdict.pass !== 'boolean') return false;
  return VERDICTS.has(verdict.verdict);
}

/**
 * The first stage of the plan without a valid entry. `null` means every planned stage is journaled.
 *
 * @param {string[]} plan
 * @param {Array<{ stageId?: string }|null|undefined>} entries
 * @returns {string|null}
 */
export function nextStage(plan, entries = []) {
  const present = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter(entry => entry && typeof entry === 'object' && typeof entry.stageId === 'string')
      .map(entry => entry.stageId),
  );
  for (const id of Array.isArray(plan) ? plan : []) {
    if (!present.has(id)) return id;
  }
  return null;
}

/**
 * The journal policy. A value that is not a known policy keeps the default `read-write`: a typo must
 * not silently disable reuse, and it must never turn a stored verdict into a fresh one.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {'off'|'read-write'}
 */
export function resolveJournalPolicy(env = {}) {
  const raw = typeof env?.[JOURNAL_POLICY_ENV] === 'string' ? env[JOURNAL_POLICY_ENV].trim().toLowerCase() : '';
  return raw === 'off' ? 'off' : 'read-write';
}
