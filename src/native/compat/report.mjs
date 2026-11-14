// The assignment lines that carry the version census. The census is evidence about the snapshot:
// which versions are produced, consumed and listed, and which of them no producer in this snapshot
// writes. The block is bounded as a whole, and it never claims that a compatibility surface is junk
// — that decision belongs to the hunter and the verifier.

import { sanitizePromptToken } from '../../domain/prompt-token.mjs';
import { COMPAT_FILE } from './config.mjs';

/**
 * @param {object} analysis
 * @param {{ maxLines?: number }} [options]
 * @returns {string[]}
 */
export function renderCompatLines(analysis, { maxLines = 12 } = {}) {
  if (!analysis) return [];
  const budget = Math.max(3, maxLines);
  const scan = analysis.scan ?? {};
  const families = Array.isArray(analysis.families) ? analysis.families : [];
  const dead = Array.isArray(analysis.deadVersions) ? analysis.deadVersions : [];
  const unproduced = Array.isArray(analysis.unproducedVersions) ? analysis.unproducedVersions : [];
  const heading = analysis.status === 'failed'
    ? 'Version census (deterministic scan failed): no evidence was produced.'
    : families.length === 0
      ? `Version census (deterministic scan of ${scan.files ?? 0} changed code file(s), coverage ${analysis.coverage ?? 'unknown'}): no versioned schema literal was found.`
      : `Version census (deterministic scan of ${scan.files ?? 0} file(s), ${families.length} family(ies), coverage ${analysis.coverage ?? 'unknown'}; evidence, never a finding):`;
  const rows = [];
  for (const family of families) rows.push(renderFamily(family));
  for (const entry of dead) rows.push(renderDead(entry));
  for (const entry of unproduced) rows.push(renderUnproduced(entry));
  const limits = analysis.coverage === 'full' ? [] : [renderLimits(analysis)];
  const lines = [heading, ...rows, ...limits];
  if (lines.length <= budget) return lines;
  const shown = lines.slice(0, budget - 1);
  const hidden = lines.length - shown.length;
  return [...shown, `- … ${hidden} more in ${COMPAT_FILE}`].slice(0, budget);
}

/**
 * One family row: the versions it produces, consumes and lists, each with its sites.
 *
 * @param {object} family
 * @returns {string}
 */
function renderFamily(family) {
  const parts = [];
  const produced = family.versions.filter(version => version.produced.length > 0);
  const consumed = family.versions.filter(version => version.consumed.length > 0);
  const listed = family.versions.filter(version => version.listed.length > 0);
  if (produced.length > 0) parts.push(`produced ${produced.map(version => `${version.version.split('/').pop()} (${sites(version.produced)})`).join(', ')}`);
  if (consumed.length > 0) parts.push(`consumed ${consumed.map(version => `${version.version.split('/').pop()} (${sites(version.consumed)})`).join(', ')}`);
  if (listed.length > 0) parts.push(`listed ${listed.map(version => version.version.split('/').pop()).join(', ')} (${sites(listed.flatMap(version => version.listed))})`);
  return `- ${sanitizePromptToken(family.family)}: ${parts.join('; ') || 'no site'}.`;
}

/**
 * One dead version: read or accepted, written by no producer in this snapshot.
 *
 * @param {object} entry
 * @returns {string}
 */
function renderDead(entry) {
  const where = sites([...entry.consumed, ...entry.listed]);
  const how = entry.consumed.length > 0 && entry.listed.length > 0 ? 'consumed and listed' : entry.consumed.length > 0 ? 'consumed' : 'listed';
  return `- DEAD ${sanitizePromptToken(entry.family)} ${entry.version.split('/').pop()}: ${how} at ${where}; no producer of this version exists in the snapshot.`;
}

/**
 * One version the change only reads while an unchanged module still writes the literal.
 *
 * @param {object} entry
 * @returns {string}
 */
function renderUnproduced(entry) {
  const where = sites([...entry.consumed, ...entry.listed]);
  const label = `- NOT PRODUCED BY THIS CHANGE ${sanitizePromptToken(entry.family)} ${entry.version.split('/').pop()}: read at ${where}; `;
  if (entry.reason === 'site-scan-truncated') {
    return `${label}the site scan was truncated, so a producer may have been dropped.`;
  }
  if (entry.reason === 'snapshot-scan-truncated') {
    return `${label}the snapshot scan was truncated, so a producer outside the scanned files is possible.`;
  }
  return `${label}the literal also appears at ${sites(entry.elsewhere ?? [])}, outside the changed files.`;
}

/**
 * What the scan did not read. A partial scan must never read as "nothing found".
 *
 * @param {object} analysis
 * @returns {string}
 */
function renderLimits(analysis) {
  const scan = analysis.scan ?? {};
  const parts = [];
  if (analysis.status === 'failed') parts.push(`scan failed${analysis.failures?.[0]?.message ? `: ${analysis.failures[0].message}` : ''}`);
  if (scan.unparsedTotal > 0) parts.push(`${scan.unparsedTotal} unparsed file(s)`);
  if (scan.truncated) parts.push('scan truncated');
  if (scan.droppedFamilies > 0) parts.push(`${scan.droppedFamilies} family(ies) beyond the cap`);
  return `- Limits: ${parts.join(', ') || 'partial coverage'}.`;
}

/**
 * `path:line` sites, deduplicated and bounded.
 *
 * @param {Array<{ path: string, line: number }>} entries
 * @param {number} [max]
 * @returns {string}
 */
function sites(entries, max = 4) {
  const seen = new Set();
  const rendered = [];
  for (const entry of entries) {
    const key = `${entry.path}:${entry.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rendered.push(`${sanitizePromptToken(entry.path)}:${entry.line}`);
  }
  if (rendered.length === 0) return 'no site';
  const shown = rendered.slice(0, max).join(', ');
  return rendered.length > max ? `${shown}, …` : shown;
}
