// The reuse artifact and the assignment lines that carry it. The artifact is evidence on its own:
// every candidate pair with the numbers that produced it. The assignment lines are a bounded hint
// list, marked as a hint — a candidate is worth reading, never a finding by itself.

import { analysisHeader } from '../../domain/analysis-header.mjs';
import { sanitizePromptToken } from '../../domain/prompt-token.mjs';
import { SCHEMA } from './config.mjs';

/** Where the reuse artifact lives inside the staged snapshot. */
export const REUSE_RELATIVE_PATH = '.review/reuse.json';

/**
 * @param {{
 *   diffHash: string, policy: string,
 *   scan: { status: string, filesScanned: number, units: number, truncated: boolean, cacheHits: number, elapsedMs: number, unparsed: Array<object> },
 *   considered: number,
 *   candidates: Array<object>,
 * }} input
 * @returns {object}
 */
export function buildReuseAnalysis({ diffHash, policy, scan, considered, candidates }) {
  return {
    ...analysisHeader({ schema: SCHEMA, diffHash, policy }),
    status: scan.status,
    coverage: scan.coverage ?? (scan.truncated ? 'partial' : 'full'),
    scan: {
      filesScanned: scan.filesScanned,
      units: scan.units,
      considered,
      truncated: scan.truncated,
      cacheHits: scan.cacheHits,
      elapsedMs: scan.elapsedMs,
      unparsed: scan.unparsed.slice(0, 20),
      unparsedTotal: Number.isFinite(scan.unparsedTotal) ? scan.unparsedTotal : scan.unparsed.length,
    },
    candidates,
  };
}

/**
 * The complete hint section for the assignment, bounded as a whole: the heading, the coverage line,
 * the candidate rows and the overflow pointer together never exceed `maxLines`. Bounding only the
 * rows would let the section grow past its declared budget as soon as it also reports coverage.
 *
 * Empty when nothing passed the thresholds: an empty section would read as "no duplicates exist",
 * which a bounded scan cannot claim.
 *
 * @param {object} analysis
 * @param {{ maxLines?: number }} [options]
 * @returns {string[]}
 */
export function renderReuseLines(analysis, { maxLines = 12 } = {}) {
  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  if (candidates.length === 0) return [];
  const budget = Math.max(3, maxLines);
  const heading = `Possible existing implementations (deterministic scan of ${analysis.scan.filesScanned} file(s), ${analysis.scan.units} unit(s); a candidate is a hint to read, never a finding):`;
  const coverage = `Reuse hint coverage: ${analysis.scan.filesScanned} file(s), ${analysis.scan.units} unit(s) scanned, coverage ${analysis.coverage ?? 'unknown'}.`;
  const rowBudget = budget - 2;
  const shown = candidates.slice(0, rowBudget);
  const overflow = candidates.length > shown.length
    ? [`- … ${candidates.length - shown.length} more in ${REUSE_RELATIVE_PATH}`]
    : [];
  const rows = shown.slice(0, budget - 2 - overflow.length);
  const pointer = candidates.length > rows.length
    ? [`- … ${candidates.length - rows.length} more in ${REUSE_RELATIVE_PATH}`]
    : [];
  return [heading, coverage, ...rows.map(renderCandidate), ...pointer].slice(0, budget);
}

/**
 * One candidate row.
 *
 * @param {object} candidate
 * @returns {string}
 */
function renderCandidate(candidate) {
  const where = `${sanitizePromptToken(candidate.changedPath)}:${candidate.changedLine}${candidate.changedName ? ` ${sanitizePromptToken(candidate.changedName)}` : ''}`;
  const twin = `${sanitizePromptToken(candidate.existingPath)}:${candidate.existingLine}${candidate.existingName ? ` ${sanitizePromptToken(candidate.existingName)}` : ''}`;
  const inside = candidate.existingIsInDiff ? ' (inside this diff)' : '';
  return `- ${where} ~ ${twin}${inside} — shape ${candidate.similarity.toFixed(2)}, shared calls: ${candidate.sharedCalls.slice(0, 6).map(sanitizePromptToken).join(', ')}`;
}
