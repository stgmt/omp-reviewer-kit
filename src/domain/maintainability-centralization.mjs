// When a repeated parameter group is the shared contract itself, not a duplicated design.
//
// Every centralisation looks like a data clump to a mechanical scan: one module owns the rule, its
// consumers pass the same values to it, and its contract test names them again. Requiring
// coordinated edits in exactly those three places is the reason the rule was extracted, so such a
// group is not a maintenance cost — it is the shape of one definition with users. A group that
// reaches further than that (a second independent implementation, a copy in a sibling module that
// does not use the owner) is not centralisation and keeps blocking.

/**
 * @param {{
 *   occurrences: Array<{ path: string }>,
 *   classOf: (path: string) => string,
 *   sources?: Map<string, string>,
 * }} input
 * @returns {{ centralization: boolean, owner: string|null, consumers: string[], reason: string }}
 */
export function classifyContractCentralization({ occurrences, classOf, sources = new Map() }) {
  const counts = new Map();
  for (const occurrence of occurrences ?? []) {
    if (!occurrence?.path) continue;
    counts.set(occurrence.path, (counts.get(occurrence.path) ?? 0) + 1);
  }
  if (counts.size === 0) return not();
  const files = [...counts.keys()];
  const moduleFiles = files.filter(file => classOf(file) !== 'test');
  const testFiles = files.filter(file => classOf(file) === 'test');
  if (moduleFiles.length === 0 || testFiles.length === 0) {
    return not('no module and test pair');
  }
  // The owner is the file that defines the rule, not the file that uses it most: a consumer with
  // many call sites is still a consumer.
  const definers = moduleFiles.filter(file => (occurrences ?? []).some(occurrence => occurrence?.path === file && occurrence?.role === 'definition'));
  if (definers.length === 0) return not('no definition site among the module occurrences');
  const owner = definers.slice().sort((left, right) => (counts.get(right) - counts.get(left)) || (left < right ? -1 : 1))[0];
  const consumers = moduleFiles.filter(file => file !== owner);
  for (const consumer of consumers) {
    // A consumer that both imports the owner and defines the same rule itself is not a user of the
    // contract: it keeps its own copy next to the import, and that copy is exactly what this policy
    // exists to stop.
    if ((occurrences ?? []).some(occurrence => occurrence?.path === consumer && occurrence?.role === 'definition')) {
      return not(`${consumer} defines the rule as well as importing it`);
    }
    const source = sources.get(consumer);
    if (typeof source !== 'string') return not('consumer source unread');
    if (!mentionsModule(source, owner)) return not(`${consumer} does not use ${owner}`);
  }
  return { centralization: true, owner, consumers, reason: `${owner} with ${consumers.length} consumer(s) and ${testFiles.length} test file(s)` };
}

function not(reason = 'not a single shared contract') {
  return { centralization: false, owner: null, consumers: [], reason };
}

/**
 * The module specifiers a source really imports: the string literals that follow `from`, `import`
 * or `require(`. Comments are dropped and a string that is not a specifier is skipped, so a path
 * quoted in a comment or parked in an unrelated string never proves that a consumer depends on the
 * owner.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function moduleSpecifiers(source) {
  const text = String(source ?? '');
  const specifiers = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (character !== '"' && character !== "'" && character !== '`') { index += 1; continue; }
    const end = skipString(text, index);
    const literal = text.slice(index + 1, Math.max(index + 1, end - 1));
    const before = text.slice(Math.max(0, index - 40), index).trimEnd();
    if (/(?:\bfrom|\bimport|\brequire\s*\()$/ .test(before)) specifiers.push(literal);
    index = end;
  }
  return specifiers;
}

/**
 * True when the text really imports the owner module. The check is literal: a consumer that never
 * writes the module name in an import is not using it, whatever its shape.
 *
 * @param {string} source
 * @param {string} owner
 * @returns {boolean}
 */
function mentionsModule(source, owner) {
  const name = owner.split('/').pop();
  if (!name) return false;
  return moduleSpecifiers(source).some(specifier => specifier === name || specifier.endsWith(`/${name}`));
}

/**
 * Skips one string literal and returns the index just after it.
 *
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function skipString(text, index) {
  const quote = text[index];
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') { cursor += 2; continue; }
    if (text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

/**
 * The ids of the groups that are one shared contract, computed from the artifact and the snapshot
 * alone. `classOf` must mark test files as test: the file classifier upgrades executable-looking
 * test files, so a caller that wants the contract test recognised has to re-tag them.
 *
 * @param {{
 *   groups: Array<{ groupId?: string, occurrences?: Array<{ path: string }> }>,
 *   classOf: (path: string) => string,
 *   readSource: (path: string) => Promise<string|null>,
 *   maxFilesPerGroup?: number,
 * }} input
 * @returns {Promise<{ exempt: Set<string>, decisions: Array<{ groupId: string, owner: string|null, centralization: boolean, reason: string }> }>}
 */
export async function centralizationGroupIds({ groups, classOf, readSource, maxFilesPerGroup = 20 }) {
  const exempt = new Set();
  const decisions = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const occurrences = Array.isArray(group?.occurrences) ? group.occurrences : [];
    if (occurrences.length === 0 || !group?.groupId) continue;
    const files = [...new Set(occurrences.map(occurrence => occurrence?.path).filter(Boolean))];
    const moduleFiles = files.filter(file => classOf(file) !== 'test').slice(0, maxFilesPerGroup);
    const sources = new Map();
    for (const file of moduleFiles) {
      const text = await readSource(file);
      if (typeof text === 'string') sources.set(file, text.slice(0, 200_000));
    }
    const verdict = classifyContractCentralization({ occurrences, classOf, sources });
    if (verdict.centralization) exempt.add(group.groupId);
    decisions.push({ groupId: group.groupId, owner: verdict.owner, centralization: verdict.centralization, reason: verdict.reason });
  }
  return { exempt, decisions };
}
