import { diffBlockPaths } from './diff-identity.mjs';
import { isTestPath, parseDiffBlocks } from './suspicion-map.mjs';

const MAX_SYMBOLS = 40;
const MIN_SYMBOL_LENGTH = 4;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_HITS_PER_SYMBOL = 5;
const MAX_TESTS_PER_FILE = 6;
const MAX_LINE_CHARS = 140;
const MAX_PACK_CHARS = 60_000;

const SYMBOL_STOP_WORDS = new Set([
  'function', 'constructor', 'return', 'static', 'async', 'await', 'export', 'default', 'import', 'from',
  'class', 'const', 'else', 'this', 'true', 'false', 'null', 'undefined', 'void', 'main', 'test', 'describe',
  'expect', 'assert', 'switch', 'catch', 'while', 'yield', 'typeof', 'self', 'args', 'data', 'result', 'value',
  'index', 'name', 'path', 'text', 'type', 'error', 'items', 'list', 'file', 'files', 'line', 'lines',
]);

// One pattern per declaration style; group 1 is the declared name.
const DECLARATION_PATTERNS = [
  /\bfunction\*?\s+([A-Za-z_$][\w$]*)/,
  /\bclass\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?#?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
  /\bdef\s+([A-Za-z_]\w*)\s*\(/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /\bfn\s+([A-Za-z_]\w*)/,
  /\binterface\s+([A-Za-z_$][\w$]*)/,
  /\btype\s+([A-Za-z_$][\w$]*)\s*=/,
];

function symbolsFromLine(line) {
  const found = [];
  for (const pattern of DECLARATION_PATTERNS) {
    const match = pattern.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

function acceptableSymbol(name) {
  return name.length >= MIN_SYMBOL_LENGTH && !SYMBOL_STOP_WORDS.has(name.toLowerCase());
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names declared, changed or removed by the diff: the symbols whose users the
 * reviewer has to look at. Taken from added and removed declaration lines and
 * from the enclosing-scope text git prints after `@@` hunk headers.
 *
 * @param {string} diffText
 * @returns {{ name: string, path: string }[]}
 */
export function changedSymbols(diffText) {
  const seen = new Map();
  const add = (name, path) => {
    if (seen.size >= MAX_SYMBOLS || !acceptableSymbol(name) || seen.has(name)) return;
    seen.set(name, path);
  };
  for (const block of parseDiffBlocks(diffText)) {
    for (const line of [...block.addedLines, ...block.removedLines]) {
      for (const name of symbolsFromLine(line)) add(name, block.path);
    }
  }
  // Hunk-header scope text names the function a hunk sits in, which a body
  // edit never declares.
  for (const raw of diffText.split(/^diff --git /m).slice(1)) {
    const { oldPath, newPath } = diffBlockPaths(raw);
    const path = newPath ?? oldPath;
    if (!path) continue;
    for (const header of raw.matchAll(/^@@ [^@]*@@ ?(.*)$/gm)) {
      for (const name of symbolsFromLine(header[1])) add(name, path);
    }
  }
  return [...seen].map(([name, path]) => ({ name, path }));
}

function lineNumberAt(text, index, cursor) {
  let { line, offset } = cursor;
  for (let i = offset; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  cursor.line = line;
  cursor.offset = index;
  return line;
}

function clip(line) {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}...` : trimmed;
}

/**
 * Deterministic context for the scout: what changed, who uses the changed
 * symbols, and which tests touch the changed files. Built from the staged
 * snapshot alone, no model involved, so it is identical for identical input.
 *
 * @param {{ files: { path: string, content: Buffer }[], diffText: string, changedPaths: string[], fileClasses?: { path: string, fileClass: string }[], testPathPatterns?: string[] }} input
 * @returns {{ text: string, stats: { symbols: number, referencedSymbols: number, mappedFiles: number, truncated: boolean } }}
 */
export function buildContextPack({ files, diffText, changedPaths, fileClasses = [], testPathPatterns } = {}) {
  const classByPath = new Map(fileClasses.map((entry) => [entry.path, entry.fileClass]));
  const isTest = (p) => isTestPath(p, testPathPatterns);
  const blocks = new Map(parseDiffBlocks(diffText).map((block) => [block.path, block]));
  const contentByPath = new Map();
  let scanned = 0;
  let scanTruncated = false;
  for (const file of files) {
    if (file.path.startsWith('.review/')) continue;
    if (file.content.length > MAX_FILE_BYTES || file.content.includes(0)) continue;
    if (scanned + file.content.length > MAX_SCAN_BYTES) {
      scanTruncated = true;
      break;
    }
    scanned += file.content.length;
    contentByPath.set(file.path, file.content.toString('utf8'));
  }

  const lines = [
    '# Review context pack',
    '',
    'Deterministic input built by the runner from the staged snapshot (no model involved). Start here: it replaces broad repository sweeps. Verify a hit against the file before relying on it.',
    '',
    '## Changed files',
    '| path | class | status | +added / -removed | lines |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const changed of changedPaths) {
    const block = blocks.get(changed);
    const content = contentByPath.get(changed);
    const status = block?.deleted ? 'deleted' : content === undefined ? 'binary-or-large' : 'present';
    lines.push(`| \`${changed}\` | ${classByPath.get(changed) ?? '-'} | ${status} | +${block?.addedLines.length ?? 0} / -${block?.removedLines.length ?? 0} | ${content === undefined ? '-' : content.split('\n').length} |`);
  }

  const symbols = changedSymbols(diffText);
  lines.push('', '## Changed symbols and who references them', '');
  if (symbols.length === 0) {
    lines.push('No declared symbol was added, changed or removed by the diff.');
  }
  const definingPaths = new Map(symbols.map((s) => [s.name, s.path]));
  const hits = new Map(symbols.map((s) => [s.name, { total: 0, files: new Set(), shown: [], tests: [] }]));
  if (symbols.length > 0) {
    const combined = new RegExp(`(?<![\\w$])(?:${symbols.map((s) => escapeRegex(s.name)).join('|')})(?![\\w$])`, 'g');
    for (const [filePath, text] of contentByPath) {
      const cursor = { line: 1, offset: 0 };
      for (const match of text.matchAll(combined)) {
        const entry = hits.get(match[0]);
        entry.total += 1;
        entry.files.add(filePath);
        if (filePath === definingPaths.get(match[0])) continue;
        const target = isTest(filePath) ? entry.tests : entry.shown;
        if (target.length >= MAX_HITS_PER_SYMBOL || target.some((hit) => hit.path === filePath)) continue;
        const lineNo = lineNumberAt(text, match.index, cursor);
        const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        target.push({ path: filePath, line: lineNo, text: clip(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)) });
      }
    }
  }
  let referenced = 0;
  for (const { name, path } of symbols) {
    const entry = hits.get(name);
    if (entry.total > 0) referenced += 1;
    lines.push(`- \`${name}\` (declared in \`${path}\`): ${entry.total} reference(s) in ${entry.files.size} file(s)`);
    for (const hit of entry.shown) lines.push(`  - \`${hit.path}:${hit.line}\` ${hit.text}`);
    for (const hit of entry.tests) lines.push(`  - test \`${hit.path}:${hit.line}\` ${hit.text}`);
  }

  lines.push('', '## Test mapping', '');
  const testFiles = [...contentByPath.keys()].filter(isTest);
  const symbolsByPath = new Map();
  for (const { name, path } of symbols) symbolsByPath.set(path, [...(symbolsByPath.get(path) ?? []), name]);
  let mapped = 0;
  for (const changed of changedPaths) {
    if (isTest(changed)) continue;
    const stem = changed.split('/').pop().replace(/\.[^.]+$/, '');
    const needles = [stem, ...(symbolsByPath.get(changed) ?? [])].filter((n) => n.length >= 3);
    const covering = [];
    for (const testPath of testFiles) {
      if (testPath === changed) continue;
      const text = contentByPath.get(testPath);
      const matched = needles.find((needle) => new RegExp(`(?<![\\w$])${escapeRegex(needle)}(?![\\w$])`).test(text));
      if (matched) covering.push({ testPath, matched });
      if (covering.length >= MAX_TESTS_PER_FILE) break;
    }
    mapped += covering.length > 0 ? 1 : 0;
    lines.push(covering.length > 0
      ? `- \`${changed}\` is referenced by: ${covering.map((c) => `\`${c.testPath}\` (via \`${c.matched}\`)`).join(', ')}`
      : `- \`${changed}\`: no test file in the snapshot mentions it or its changed symbols`);
  }
  const changedTests = changedPaths.filter(isTest);
  if (changedTests.length > 0) lines.push('', `Changed test files: ${changedTests.map((p) => `\`${p}\``).join(', ')}`);
  if (scanTruncated) lines.push('', `Note: the snapshot scan stopped at ${MAX_SCAN_BYTES} bytes; references from unscanned files are missing.`);

  let text = `${lines.join('\n')}\n`;
  const truncated = text.length > MAX_PACK_CHARS;
  if (truncated) text = `${text.slice(0, MAX_PACK_CHARS)}\n\n[context pack truncated at ${MAX_PACK_CHARS} characters]\n`;
  return { text, stats: { symbols: symbols.length, referencedSymbols: referenced, truncated, mappedFiles: mapped } };
}
