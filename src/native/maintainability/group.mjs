// Deterministic grouping: maximal parameter groups whose occurrences cross the support threshold.
// No model, no heuristics over meaning: subsets, counts, and the maximality rule of the spec.

const GENERATED_SEGMENTS = new Set(['dist', 'build', 'out', 'coverage', 'vendor', 'generated']);
const GENERATED_SUFFIXES = ['.min.js', '.min.mjs', '.bundle.js', '.generated.js', '.generated.mjs', '.g.js'];

/** A path the analysis never turns into a candidate: a build product or a checked-in bundle. */
export function isGeneratedPath(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some(segment => GENERATED_SEGMENTS.has(segment))) return true;
  const base = segments[segments.length - 1] ?? '';
  return GENERATED_SUFFIXES.some(suffix => base.endsWith(suffix));
}

/**
 * Records every signature the analysis refuses, with the ground, then groups what is left.
 *
 * @param {{
 *   signatures: Array<object>,
 *   classOf: (filePath: string) => string,
 *   changedPaths: string[],
 *   config: object,
 *   supportComplete: boolean,
 * }} input
 * @returns {{
 *   groups: Array<{
 *     groupId: string, language: string, params: string[], support: number,
 *     supportComplete: boolean, stagedTouchCount: number, occurrences: Array<object>,
 *   }>,
 *   excluded: Array<{ path: string, ground: string }>,
 * }}
 */
export function groupClumps({ signatures, classOf, changedPaths, config, supportComplete }) {
  const changed = new Set(changedPaths);
  const excluded = [];
  const kept = [];
  for (const signature of signatures) {
    if (classOf(signature.path) === 'test') {
      excluded.push({ path: signature.path, ground: 'test-class' });
      continue;
    }
    if (isGeneratedPath(signature.path)) {
      excluded.push({ path: signature.path, ground: 'generated' });
      continue;
    }
    if (signature.params.length > config.maxSignatureParams) {
      excluded.push({ path: signature.path, ground: 'oversized-signature' });
      continue;
    }
    kept.push(signature);
  }

  const byLanguage = new Map();
  for (const signature of kept) {
    const list = byLanguage.get(signature.language) ?? [];
    list.push(signature);
    byLanguage.set(signature.language, list);
  }

  const candidates = [];
  for (const [language, list] of [...byLanguage.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const index = new Map();
    list.forEach((signature, position) => {
      const names = signature.params;
      const upper = Math.min(config.maxGroupSize, names.length);
      for (let size = config.minSize; size <= upper; size += 1) {
        for (const combination of combinations(names, size)) {
          const key = combination.join('\u0000');
          const entry = index.get(key) ?? { params: combination, occurrences: new Set() };
          entry.occurrences.add(position);
          index.set(key, entry);
        }
      }
    });
    const maximal = maximalEntries(index, list, config);
    for (const entry of maximal) {
      const occurrences = [...entry.occurrences]
        .map(position => list[position])
        .sort(compareOccurrence);
      const touched = occurrences.filter(occurrence => changed.has(occurrence.path)).length;
      if (touched === 0) continue;
      candidates.push({
        language,
        params: entry.params,
        support: occurrences.length,
        supportComplete,
        stagedTouchCount: touched,
        occurrences: occurrences.map(occurrence => ({
          path: occurrence.path,
          lineStart: occurrence.lineStart,
          lineEnd: occurrence.lineEnd,
          inStagedDiff: changed.has(occurrence.path),
          role: occurrence.role,
        })),
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.support !== a.support) return b.support - a.support;
    if (b.params.length !== a.params.length) return b.params.length - a.params.length;
    const left = a.params.join(',');
    const right = b.params.join(',');
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const delivered = candidates.slice(0, config.maxGroups);

  return {
    groups: delivered.map((entry, position) => ({ groupId: `g${position + 1}`, ...entry })),
    excluded,
    // Groups beyond the ceiling are reported, never dropped silently: the analysis is partial then.
    dropped: candidates.length - delivered.length,
  };
}

/**
 * A group is kept only when no strict superset has at least the same support. Supersets are looked
 * up in the index by key, generated only from the signatures that already carry the group, so the
 * cost follows the occurrences rather than the whole index.
 */
function maximalEntries(index, list, config) {
  const kept = [];
  for (const entry of index.values()) {
    if (entry.occurrences.size < config.minSupport) continue;
    let dominated = false;
    for (const position of entry.occurrences) {
      const names = list[position].params;
      const upper = Math.min(config.maxGroupSize, names.length);
      for (const combination of supersetsOf(entry.params, names, upper)) {
        const other = index.get(combination.join('\u0000'));
        if (other && other !== entry && other.occurrences.size >= entry.occurrences.size) {
          dominated = true;
          break;
        }
      }
      if (dominated) break;
    }
    if (!dominated) kept.push(entry);
  }
  return kept;
}

/** Every combination of `names` that contains all of `params`, for sizes above `params.length`. */
function supersetsOf(params, names, upper) {
  const rest = names.filter(name => !params.includes(name));
  const out = [];
  for (let size = params.length + 1; size <= upper; size += 1) {
    const extra = size - params.length;
    if (extra > rest.length) break;
    for (const addition of combinations(rest, extra)) out.push([...params, ...addition].sort());
  }
  return out;
}

function combinations(names, size) {
  const out = [];
  const pick = (start, current) => {
    if (current.length === size) {
      out.push([...current]);
      return;
    }
    for (let position = start; position < names.length; position += 1) {
      current.push(names[position]);
      pick(position + 1, current);
      current.pop();
    }
  };
  pick(0, []);
  return out;
}

function compareOccurrence(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.lineStart !== b.lineStart) return a.lineStart - b.lineStart;
  return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
}
