import { sanitizePromptToken } from './review-prompt.mjs';

const MAX_COVERAGE_ENTRIES = 60;
const MAX_NON_COVERABLE_ENTRIES = 20;
const MAX_TEXT_CHARS = 200;
const MAX_REPORT_CHARS = 2_000_000;

const clipText = (value, limit = MAX_TEXT_CHARS) => String(value ?? '').slice(0, limit);
const positiveLine = (value) => (Number.isInteger(value) && value > 0 ? value : null);

function decodeScoutReport(text) {
  const raw = String(text ?? '').slice(0, MAX_REPORT_CHARS).trim();
  const attempts = [raw];
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) attempts.push(raw.slice(open, close + 1));
  for (const candidate of attempts) {
    try {
      let value = JSON.parse(candidate);
      if (typeof value === 'string') value = JSON.parse(value);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // a prefix-trimmed attempt may still parse
    }
  }
  return null;
}

/**
 * Extracts the stable part of a scout report (the `coverage_map`, the waived
 * `non_coverable_items`, and the harness verdict) so the next review round can
 * reuse it instead of rebuilding a different map from scratch.
 *
 * @param {string} text - the scout's result artifact
 * @returns {{ coverageMap: object[], nonCoverable: object[], testHarness: string }|null}
 */
export function parseScoutBaseline(text) {
  const report = decodeScoutReport(text);
  if (!report || !Array.isArray(report.coverage_map)) return null;
  const coverageMap = report.coverage_map
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.file_path === 'string' && typeof entry.behavior === 'string')
    .slice(0, MAX_COVERAGE_ENTRIES)
    .map((entry) => ({
      behavior: clipText(entry.behavior),
      file_path: clipText(entry.file_path, 400),
      line_start: positiveLine(entry.line_start),
      line_end: positiveLine(entry.line_end),
      covering_test: typeof entry.covering_test === 'string' && entry.covering_test.length > 0 ? clipText(entry.covering_test, 400) : null,
    }));
  const nonCoverable = (Array.isArray(report.non_coverable_items) ? report.non_coverable_items : [])
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.file_path === 'string')
    .slice(0, MAX_NON_COVERABLE_ENTRIES)
    .map((entry) => ({
      file_path: clipText(entry.file_path, 400),
      line_start: positiveLine(entry.line_start),
      line_end: positiveLine(entry.line_end),
      reason: clipText(entry.reason),
    }));
  const harness = String(report.test_harness ?? '').toLowerCase();
  return {
    coverageMap,
    nonCoverable,
    testHarness: harness.startsWith('present') ? 'present' : harness.startsWith('absent') ? 'absent' : 'unknown',
  };
}

/**
 * Validates a baseline read back from the round store.
 *
 * @param {unknown} value
 * @returns {{ coverageMap: object[], nonCoverable: object[], testHarness: string }|null}
 */
export function normalizeStoredBaseline(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.coverageMap)) return null;
  const parsed = parseScoutBaseline(JSON.stringify({
    coverage_map: value.coverageMap,
    non_coverable_items: value.nonCoverable,
    test_harness: value.testHarness,
  }));
  return parsed && parsed.coverageMap.length > 0 ? parsed : null;
}

const locationOf = (entry) => `${sanitizePromptToken(entry.file_path)}${entry.line_start ? `:${entry.line_start}${entry.line_end && entry.line_end !== entry.line_start ? `-${entry.line_end}` : ''}` : ''}`;

/**
 * Prompt block handing the previous round's scout baseline to the scout.
 *
 * @param {{ baseline: object, deltaPaths: string[], round: number }} input
 * @returns {string}
 */
export function formatScoutBaseline({ baseline, deltaPaths, round }) {
  const lines = [
    `SCOUT BASELINE (review round ${round}): the previous round's scout map, carried so the coverage_map stays stable between rounds. Test harness then: ${baseline.testHarness}.`,
    'coverage_map entries of the previous round:',
    ...baseline.coverageMap.map((entry) => `- ${locationOf(entry)} | ${sanitizePromptToken(entry.behavior)} | covering_test: ${entry.covering_test ? sanitizePromptToken(entry.covering_test) : 'null'}`),
  ];
  if (baseline.nonCoverable.length > 0) {
    lines.push(
      'non_coverable_items of the previous round:',
      ...baseline.nonCoverable.map((entry) => `- ${locationOf(entry)} | ${sanitizePromptToken(entry.reason)}`),
    );
  }
  lines.push(
    `Files with lines added since then (the round delta): ${deltaPaths.length > 0 ? deltaPaths.map((p) => sanitizePromptToken(p)).join(', ') : 'none'}.`,
    'Scout rules for this baseline: (1) keep an entry exactly as listed (same behavior and covering_test) when its file_path is outside the round delta, its covering_test is not null, and the file named in covering_test is outside the round delta; (2) re-derive every other entry from the staged snapshot, in particular entries with covering_test null and entries whose source or test file is in the delta, and say in `unknowns` when a baseline entry could not be re-verified; (3) add entries only for executable behaviors that are new in the delta, and drop entries whose behavior no longer exists; (4) do not re-scan unchanged files for new behaviors; (5) emit the full merged coverage_map.',
  );
  return lines.join('\n');
}
