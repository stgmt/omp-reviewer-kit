import { diffBlockPaths } from './diff-identity.mjs';
import { sanitizePromptToken } from './review-prompt.mjs';

const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'init', '__init__', 'readme', 'package', 'config', 'types', 'utils', 'helpers']);

/**
 * Grouping key of a changed file: a source file and its tests share one key
 * (`src/total.mjs`, `tests/total.test.mjs`, `test_total.py` -> `total`), so a
 * shard keeps a behavior and the tests that pin it together. Generic names
 * never merge across directories.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function shardGroupKey(filePath) {
  const parts = filePath.split('/');
  const base = parts.pop().toLowerCase();
  const stem = base
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](?:test|tests|spec)$/, '')
    .replace(/^test[._-]/, '');
  return GENERIC_STEMS.has(stem) ? filePath.toLowerCase() : stem;
}

/**
 * Splits a large diff into file groups of similar size so several hunters can
 * work in parallel. Deterministic: same diff, same plan. Returns null when the
 * diff is small enough for one hunter, when sharding is disabled, or when the
 * files form fewer than two groups.
 *
 * @param {{ diffText: string, thresholdBytes: number, maxShards: number }} input
 * @returns {{ totalBytes: number, shards: { index: number, files: string[], bytes: number }[] }|null}
 */
export function planHunterShards({ diffText, thresholdBytes, maxShards }) {
  if (!Number.isInteger(thresholdBytes) || thresholdBytes <= 0 || !Number.isInteger(maxShards) || maxShards < 2) return null;
  const text = String(diffText ?? '');
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= thresholdBytes) return null;

  const groups = new Map();
  for (const raw of text.split(/^diff --git /m).slice(1)) {
    const { oldPath, newPath } = diffBlockPaths(raw);
    const filePath = newPath ?? oldPath;
    if (!filePath) continue;
    const key = shardGroupKey(filePath);
    const group = groups.get(key) ?? { files: new Set(), bytes: 0 };
    group.files.add(filePath);
    group.bytes += Buffer.byteLength(raw);
    groups.set(key, group);
  }
  const ordered = [...groups.values()]
    .map((group) => ({ files: [...group.files].sort(), bytes: group.bytes }))
    .sort((a, b) => b.bytes - a.bytes || (a.files[0] < b.files[0] ? -1 : 1));
  const shardCount = Math.min(maxShards, Math.ceil(totalBytes / thresholdBytes), ordered.length);
  if (shardCount < 2) return null;

  const shards = Array.from({ length: shardCount }, () => ({ files: [], bytes: 0 }));
  for (const group of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.bytes < best.bytes ? shard : best));
    lightest.files.push(...group.files);
    lightest.bytes += group.bytes;
  }
  return {
    totalBytes,
    shards: shards.map((shard, i) => ({ index: i + 1, files: shard.files.sort(), bytes: shard.bytes })),
  };
}

/**
 * Prompt block instructing the orchestrator to run one correctness hunter per shard.
 *
 * @param {{ totalBytes: number, shards: { index: number, files: string[], bytes: number }[] }} plan
 * @returns {string}
 */
export function formatHunterShards(plan) {
  const count = plan.shards.length;
  return [
    `HUNTER SHARDS for the correctness lane (the staged diff is ${plan.totalBytes} bytes, too large for one hunter): spawn ${count} blocking review-risk-hunter tasks for the correctness lane instead of one, all in the same batch as the other lanes, one per shard below. Every hunter task text carries its shard header, the full scout report, and the shared digest.`,
    ...plan.shards.map((shard) => `- Shard ${shard.index}/${count} (${shard.bytes} diff bytes): ${shard.files.map((f) => sanitizePromptToken(f)).join(', ')}`),
    `Shard rules: (1) Each hunter hunts defects whose location is in its shard files and emits \`candidate_id\` values of the form \`correctness-s<shard>-<ordinal>\` (for example \`correctness-s2-1\`); (2) a hunter may read any other staged file to verify a cross-file contract of its shard's changes, but must not emit a candidate located only in another shard's files; (3) \`coverage_gaps\` and the Neuroslop pass cover only the scout coverage_map entries and assertions of the hunter's own shard files; (4) the shared digest is a single block you write once before spawning, at most 15 lines, listing every changed path with its shard number and the cross-shard contracts from the scout report (callers and callees whose files sit in different shards), and every hunter task embeds it verbatim; (5) after the batch returns, merge the candidate lists and coverage_gaps of all shards into one list for the verifier, dropping exact duplicates (same file, line range and defect), and tell the verifier which shard each candidate came from.`,
  ].join('\n');
}
