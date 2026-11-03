// The shape of a piece of code: what it does, with its names removed. Identifiers become `I`,
// numbers `N` and strings `S`; operators, punctuation and keywords stay. A copy that was renamed,
// reformatted or moved keeps its shape, so two units with the same shape are worth reading.
// Nothing here parses or judges: it reports the tokens, their shingles and the calls they name.

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void',
  'yield', 'await', 'async', 'function', 'class', 'extends', 'super', 'this', 'const', 'let', 'var',
  'import', 'export', 'from', 'as', 'with', 'def', 'lambda', 'pass', 'raise', 'except', 'and', 'or',
  'not', 'is', 'None', 'True', 'False', 'del', 'global', 'nonlocal', 'assert', 'elif', 'match',
]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * Tokenizes source into shape tokens. Comments are dropped, string bodies become one `S` token,
 * numbers become `N` and every identifier becomes `I`. `language` decides which comment syntax is
 * stripped: a JavaScript `#private` field is not a comment, a Python `#` is.
 *
 * @param {string} source
 * @param {'javascript'|'python'} language
 * @returns {string[]}
 */
export function shapeTokens(source, language = 'javascript') {
  const text = String(source ?? '');
  const tokens = [];
  const hashComments = language === 'python';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      index += 1;
      continue;
    }
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
    if (hashComments && character === '#') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      const triple = quote !== '`' && text[index + 1] === quote && text[index + 2] === quote;
      let cursor = index + (triple ? 3 : 1);
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (triple && text[cursor] === quote && text[cursor + 1] === quote && text[cursor + 2] === quote) { cursor += 3; break; }
        if (!triple && text[cursor] === quote) { cursor += 1; break; }
        cursor += 1;
      }
      tokens.push('S');
      index = cursor;
      continue;
    }
    if (DIGIT.test(character)) {
      let cursor = index + 1;
      while (cursor < text.length && (IDENTIFIER_PART.test(text[cursor]) || text[cursor] === '.')) cursor += 1;
      tokens.push('N');
      index = cursor;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let cursor = index + 1;
      while (cursor < text.length && IDENTIFIER_PART.test(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      tokens.push(KEYWORDS.has(word) ? word : 'I');
      index = cursor;
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  return tokens;
}

/**
 * Rolling hashes of every `k` consecutive shape tokens, sorted and deduplicated. Two units that do
 * the same thing in the same order share most of their shingles even when every name differs.
 *
 * @param {string[]} tokens
 * @param {number} [k]
 * @returns {number[]}
 */
export function shinglesOf(tokens, k = 5) {
  if (!Array.isArray(tokens) || tokens.length < k || k < 1) return [];
  const hashes = new Set();
  for (let start = 0; start + k <= tokens.length; start += 1) {
    let hash = 0x811c9dc5;
    for (let offset = 0; offset < k; offset += 1) {
      const token = tokens[start + offset];
      for (let character = 0; character < token.length; character += 1) {
        hash ^= token.charCodeAt(character);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hash ^= 0x2f;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hashes.add(hash >>> 0);
  }
  return [...hashes].sort((a, b) => a - b);
}

/**
 * Jaccard similarity of two sorted hash sets. Empty input on either side is no evidence, not a
 * perfect match: a unit too small to fingerprint must not become a candidate.
 *
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number}
 */
export function jaccard(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) return 0;
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { shared += 1; i += 1; j += 1; } else if (left[i] < right[j]) i += 1; else j += 1;
  }
  const union = left.length + right.length - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Names a source calls: an identifier followed by `(`. Keywords are not calls, and neither is a
 * name shorter than three characters — those are too common to narrow anything down.
 *
 * @param {string} source
 * @param {'javascript'|'python'} language
 * @returns {string[]}
 */
export function callsOf(source, language = 'javascript') {
  const text = String(source ?? '');
  const names = new Set();
  const hashComments = language === 'python';
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
    if (hashComments && character === '#') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      index = skipString(text, index);
      continue;
    }
    if (!IDENTIFIER_START.test(character)) { index += 1; continue; }
    const chain = [];
    let cursor = index;
    while (cursor < text.length) {
      let end = cursor + 1;
      while (end < text.length && IDENTIFIER_PART.test(text[end])) end += 1;
      chain.push(text.slice(cursor, end));
      let after = end;
      while (after < text.length && (text[after] === ' ' || text[after] === '\t' || text[after] === '\n' || text[after] === '\r')) after += 1;
      if (text[after] === '.') {
        let next = after + 1;
        while (next < text.length && (text[next] === ' ' || text[next] === '\t' || text[next] === '\n' || text[next] === '\r')) next += 1;
        if (next < text.length && IDENTIFIER_START.test(text[next])) { cursor = next; continue; }
        cursor = after;
        break;
      }
      cursor = after;
      break;
    }
    if (text[cursor] === '(' && !KEYWORDS.has(chain[0])) {
      const name = chain.join('.');
      if (name.length >= 3) names.add(name);
    }
    index = Math.max(cursor, index + 1);
  }
  return [...names].sort();
}

/**
 * Skips a string literal and returns the index after it. A call-shaped word inside a string is text,
 * not an invocation, so it must never reach the shared-call evidence.
 */
function skipString(text, index) {
  const quote = text[index];
  const triple = quote !== '`' && text[index + 1] === quote && text[index + 2] === quote;
  let cursor = index + (triple ? 3 : 1);
  while (cursor < text.length) {
    if (text[cursor] === '\\') { cursor += 2; continue; }
    if (triple && text[cursor] === quote && text[cursor + 1] === quote && text[cursor + 2] === quote) return cursor + 3;
    if (!triple && text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

/**
 * Everything the reuse scan needs about one piece of source.
 *
 * @param {string} source
 * @param {'javascript'|'python'} language
 * @param {{ k?: number }} [options]
 * @returns {{ tokens: number, shingles: number[], calls: string[] }}
 */
export function shapeOfSource(source, language = 'javascript', { k = 5 } = {}) {
  const tokens = shapeTokens(source, language);
  return {
    tokens: tokens.length,
    shingles: shinglesOf(tokens, k),
    calls: callsOf(source, language),
  };
}
