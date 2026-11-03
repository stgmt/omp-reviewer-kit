// Candidate reuse pairs, computed from the scanned units alone. A shingle inverted index narrows
// the field first, then the exact Jaccard decides — but only on *distinctive* shingles: the
// fragments every unit shares (`try {`, `catch (error)`, a logger call) say nothing about whether
// two pieces of code are the same idea, and counting them turns boilerplate into a perfect match.
//
// The question it answers is the one a limited context cannot: "does this code already exist
// somewhere else under another name" — a renamed copy keeps its shape, so its shingles still meet.

import { jaccard } from './shape.mjs';

/** The least number of units that must share a shingle before it is boilerplate. */
export const MIN_COMMON_UNITS = 12;

/**
 * @typedef {{
 *   path: string, language: string, name: string|null, lineStart: number, lineEnd: number,
 *   tokens: number, shingles: number[], calls: string[],
 * }} Unit
 */

/**
 * @param {{
 *   units: Unit[],
 *   changedPaths: string[],
 *   config: {
 *     minShapeTokens: number, minDistinctiveShingles: number, minSharedShingles: number,
 *     minSimilarity: number, maxCandidates: number,
 *   },
 * }} input
 * @returns {{
 *   candidates: Array<{
 *     changedPath: string, changedLine: number, changedName: string|null,
 *     existingPath: string, existingLine: number, existingName: string|null,
 *     similarity: number, sharedCalls: string[], existingIsInDiff: boolean,
 *   }>,
 *   considered: number,
 * }}
 */
export function findReuseCandidates({ units, changedPaths, config }) {
  const changed = new Set(changedPaths);
  const shaped = units.filter(unit => unit.tokens >= config.minShapeTokens && unit.shingles.length > 0);

  // A shingle that appears in a large share of units is boilerplate. It narrows nothing and would
  // make every unit a candidate for every other, so it is dropped before anything is compared.
  const postings = new Map();
  for (let index = 0; index < shaped.length; index += 1) {
    for (const shingle of shaped[index].shingles) {
      const bucket = postings.get(shingle);
      if (bucket === undefined) postings.set(shingle, [index]);
      else bucket.push(index);
    }
  }
  const commonLimit = commonShingleLimit(shaped.length);
  const common = new Set();
  for (const [shingle, bucket] of postings) if (bucket.length > commonLimit) common.add(shingle);
  // A shingle in more units than the tenth-plus-floor is boilerplate; at or below it, it may be the
  // very fragment that proves two units are the same idea.

  const distinctive = shaped.map(unit => unit.shingles.filter(shingle => !common.has(shingle)));
  const eligible = [];
  for (let index = 0; index < shaped.length; index += 1) {
    if (distinctive[index].length < config.minDistinctiveShingles) continue;
    eligible.push(index);
  }
  const considered = eligible.length;

  const distinctivePostings = new Map();
  for (const index of eligible) {
    for (const shingle of distinctive[index]) {
      const bucket = distinctivePostings.get(shingle);
      if (bucket === undefined) distinctivePostings.set(shingle, [index]);
      else bucket.push(index);
    }
  }

  const candidates = [];
  const seenPairs = new Set();
  for (const index of eligible) {
    const unit = shaped[index];
    if (!changed.has(unit.path)) continue;
    const hits = new Map();
    for (const shingle of distinctive[index]) {
      for (const other of distinctivePostings.get(shingle) ?? []) {
        if (other === index) continue;
        hits.set(other, (hits.get(other) ?? 0) + 1);
      }
    }
    for (const [otherIndex, shared] of hits) {
      if (shared < config.minSharedShingles) continue;
      const other = shaped[otherIndex];
      // The same unit, not the same lines: two sibling definitions on one physical line share their
      // lines and differ in their offsets, and only the offsets identify one unit with itself.
      if (isSameUnit(unit, other)) continue;
      if (isNested(unit, other)) continue;
      const similarity = round(jaccard(distinctive[index], distinctive[otherIndex]));
      if (similarity < config.minSimilarity) continue;
      const [left, right] = canonicalOrder(unit, other, changed);
      // The pair's identity is the two units, not two line numbers: distinct siblings can share a line.
      const key = `${unitKey(left)}\u0000${unitKey(right)}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      candidates.push({
        changedPath: left.path,
        changedLine: left.lineStart,
        changedName: left.name,
        existingPath: right.path,
        existingLine: right.lineStart,
        existingName: right.name,
        similarity,
        sharedCalls: sharedCalls(left, right).slice(0, 8),
        existingIsInDiff: changed.has(right.path),
      });
    }
  }

  candidates.sort((a, b) => (b.similarity - a.similarity)
    || (a.changedPath < b.changedPath ? -1 : a.changedPath > b.changedPath ? 1 : 0)
    || (a.changedLine - b.changedLine)
    || (a.existingPath < b.existingPath ? -1 : a.existingPath > b.existingPath ? 1 : 0)
    || (a.existingLine - b.existingLine));
  return { candidates: candidates.slice(0, config.maxCandidates), considered };
}

/**
 * How many units may share a shingle before it counts as boilerplate: a tenth of the shaped units,
 * and never fewer than `MIN_COMMON_UNITS` — in a set of five units "a tenth" would otherwise erase
 * every shingle and no copy could ever be found.
 *
 * @param {number} unitCount
 * @returns {number}
 */
export function commonShingleLimit(unitCount) {
  return Math.max(MIN_COMMON_UNITS, Math.ceil(Math.max(0, unitCount) / 10));
}

/**
 * A definition nested inside another shares the outer unit's text; it is a part of it, not a
 * second implementation.
 */
function isSameUnit(left, right) {
  if (left.path !== right.path) return false;
  if (Number.isFinite(left.startOffset) && Number.isFinite(right.startOffset)) {
    return left.startOffset === right.startOffset && left.endOffset === right.endOffset;
  }
  return left.lineStart === right.lineStart && left.lineEnd === right.lineEnd;
}

function isNested(left, right) {
  if (left.path !== right.path || isSameUnit(left, right)) return false;
  if (Number.isFinite(left.startOffset) && Number.isFinite(right.startOffset)) {
    return Math.max(left.startOffset, right.startOffset) < Math.min(left.endOffset, right.endOffset);
  }
  return Math.max(left.lineStart, right.lineStart) <= Math.min(left.lineEnd, right.lineEnd);
}

/**
 * Orders a pair so the diff-side unit is first: the hint reads as "the change looks like that
 * code". Two changed units are ordered by location, so one pair is reported once, not twice.
 */
function canonicalOrder(left, right, changed) {
  const rank = unit => (changed.has(unit.path) ? 0 : 1);
  if (rank(left) !== rank(right)) return rank(left) < rank(right) ? [left, right] : [right, left];
  if (left.path !== right.path) return left.path < right.path ? [left, right] : [right, left];
  if (left.lineStart !== right.lineStart) return left.lineStart < right.lineStart ? [left, right] : [right, left];
  // Two definitions on one line differ only by their offsets: without this tie-break the same pair
  // would be emitted twice, once per direction.
  const leftOffset = Number.isFinite(left.startOffset) ? left.startOffset : 0;
  const rightOffset = Number.isFinite(right.startOffset) ? right.startOffset : 0;
  return leftOffset <= rightOffset ? [left, right] : [right, left];
}

/**
 * A unit's identity: its path and its character range, or its lines when the scan had no offsets.
 *
 * @param {Unit} unit
 * @returns {string}
 */
function unitKey(unit) {
  const start = Number.isFinite(unit.startOffset) ? unit.startOffset : unit.lineStart;
  const end = Number.isFinite(unit.endOffset) ? unit.endOffset : unit.lineEnd;
  return `${unit.path}:${start}-${end}`;
}

function sharedCalls(left, right) {
  const rightSet = new Set(right.calls ?? []);
  return (left.calls ?? []).filter(call => rightSet.has(call));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
