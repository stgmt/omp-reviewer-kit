// One deterministic scan of a snapshot into reusable units: every function or method with enough
// shape to compare. JavaScript and TypeScript go through `@babel/parser` in this process, Python
// through the standard-library `ast` in one child interpreter. A file that cannot be parsed is
// reported, never silently skipped, and a unit is answered from the content-addressed cache when
// the same bytes were scanned before.

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyFilePath } from '../../domain/file-class.mjs';
import { sourceSpan } from '../../domain/source-span.mjs';
import { unparsedRecord } from '../../domain/unparsed-record.mjs';
import { collectExecutableFiles, walkAst } from '../maintainability/extract.mjs';
import { JS_EXTENSIONS, parseJavaScript } from '../scan/js-parse.mjs';
import { runPythonChild } from '../scan/python-child.mjs';
import { CACHE_DIR_ENV } from './config.mjs';
import { shapeOfSource } from './shape.mjs';

/** Bumped when the tokens or the unit rules change, so an old cache entry is ignored, never merged. */
export const EXTRACTOR_VERSION = 1;
export const CACHE_SCHEMA = 'reuse-cache@1';

const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);

// Test files repeat their scaffolding on purpose: a fixture that looks like production code is a
// property of the test suite, not a second implementation. A hint about it would be noise.
const TEST_PATH = /(^|\/)(tests?|__tests__|__fixtures__)\//i;
const TEST_FILE = /(\.(test|spec)\.[^/]+$|(^|\/)(test_[^/]*\.py|[^/]*_test\.(py|go))$)/i;

/**
 * True for a path that belongs to a test suite. Path-only, like the file classifier: content is
 * never inspected, so the rule cannot drift with the code.
 *
 * @param {string} relative
 */
export function isTestPath(relative) {
  const normalized = String(relative).replace(/\\/g, '/');
  return TEST_PATH.test(normalized) || TEST_FILE.test(normalized);
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ObjectMethod',
  'ClassPrivateMethod',
]);

const PYTHON_SCAN = String.raw`
import ast, json, sys

request = json.loads(sys.stdin.read())
out = []
errors = []
for item in request.get('files', []):
    try:
        with open(item['abs'], 'r', encoding='utf-8', errors='replace') as handle:
            source = handle.read()
        tree = ast.parse(source, filename=item['path'])
    except (SyntaxError, ValueError):
        errors.append({'path': item['path'], 'reason': 'syntax'})
        continue
    except OSError:
        errors.append({'path': item['path'], 'reason': 'unreadable'})
        continue
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        out.append({
            'path': item['path'],
            'name': node.name,
            'lineStart': node.lineno,
            'lineEnd': getattr(node, 'end_lineno', node.lineno),
        })
json.dump({'units': out, 'errors': errors}, sys.stdout)
`;

/**
 * A file-backed cache keyed by the content hash of the scanned bytes. Every read and write is
 * best-effort: a cache that cannot answer must not fail a review, and a stored entry of another
 * schema is ignored rather than migrated.
 *
 * @param {{ dir?: string, env?: object }} [input]
 */
export function createFileCache({ dir, env = process.env } = {}) {
  const root = dir ?? env?.[CACHE_DIR_ENV] ?? path.join(os.homedir(), '.omp', 'review-kit-cache', 'reuse');
  return {
    root,
    /**
     * @param {string} key
     * @returns {Promise<object[]|null>}
     */
    async get(key) {
      try {
        // A cache is data on disk, not a promise: an entry of another schema, of another extractor
        // version, or whose members are not units is a miss, so a corrupted file costs a reparse.
        return parseCacheEnvelope(JSON.parse(await readFile(path.join(root, `${key}.json`), 'utf8')));
      } catch {
        return null;
      }
    },
    /**
     * @param {string} key
     * @param {object[]} units
     * @returns {Promise<boolean>} false when nothing was stored; the caller counts, never throws.
     */
    async set(key, units) {
      try {
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, `${key}.json`), JSON.stringify(cacheEnvelope(units)), 'utf8');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Scans a snapshot into units. Deterministic from the bytes on disk and the config alone.
 *
 * @param {{
 *   snapshotDir: string,
 *   config: object,
 *   now?: () => number,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   spawnSync?: Function,
 *   pythonBin?: string,
 *   cache?: { get: (key: string) => Promise<object[]|null>, set: (key: string, units: object[]) => Promise<boolean> }|null,
 * }} input
 * @returns {Promise<{
 *   status: 'ok'|'failed',
 *   coverage: 'full'|'partial'|'failed',
 *   units: object[],
 *   unparsed: Array<unparsedRecord(string, string)>,
 *   truncated: boolean,
 *   filesScanned: number,
 *   cacheHits: number,
 *   cacheWrites: number,
 *   elapsedMs: number,
 * }>}
 */
export async function scanUnits({
  snapshotDir,
  config,
  now = Date.now,
  loadParser,
  spawnSync = null,
  pythonBin = 'python',
  cache = null,
}) {
  const started = now();
  const deadline = started + config.maxScanMs;
  const collected = await collectExecutableFiles({
    rootDir: snapshotDir,
    config: { maxScanFiles: config.maxFiles, maxFileBytes: config.maxFileBytes },
    classify: classifyFilePath,
    now,
    deadline,
    maxSkipped: 50,
  });
  const units = [];
  const unparsed = [];
  let truncated = collected.skipped.length > 0 || collected.truncated === true;
  let filesScanned = 0;
  let cacheHits = 0;
  let cacheWrites = 0;
  let parser = null;
  let parserFailed = false;
  const pythonFiles = [];

  for (const relative of collected.paths) {
    if (units.length >= config.maxUnits || now() > deadline) { truncated = true; break; }
    const absolute = path.join(snapshotDir, relative);
    if (isTestPath(relative)) continue;
    const extension = path.extname(relative).toLowerCase();
    const jsPlugins = JS_EXTENSIONS.get(extension);
    if (!jsPlugins && !PYTHON_EXTENSIONS.has(extension)) continue;
    let size = 0;
    try {
      size = (await stat(absolute)).size;
    } catch {
      unparsed.push(unparsedRecord(relative, 'unreadable'));
      continue;
    }
    if (size > config.maxFileBytes) {
      unparsed.push(unparsedRecord(relative, 'too-large'));
      continue;
    }
    let source;
    try {
      source = await readFile(absolute, 'utf8');
    } catch {
      unparsed.push(unparsedRecord(relative, 'unreadable'));
      continue;
    }
    filesScanned += 1;
    if (PYTHON_EXTENSIONS.has(extension)) {
      // The same content-addressed cache answers Python files: unchanged bytes are answered without
      // starting the child interpreter at all.
      const pythonKey = cacheKey('python', relative, source);
      const cachedPython = cache ? await cache.get(pythonKey) : null;
      if (cachedPython) {
        cacheHits += 1;
        units.push(...cachedPython);
        continue;
      }
      pythonFiles.push({ path: relative, abs: absolute, source, key: pythonKey });
      continue;
    }
    const language = 'javascript';
    const key = cacheKey(language, relative, source);
    const cached = cache ? await cache.get(key) : null;
    if (cached) {
      cacheHits += 1;
      units.push(...cached);
      continue;
    }
    if (!parser && !parserFailed) {
      try {
        parser = await (loadParser ?? (() => import('@babel/parser')))();
      } catch {
        parserFailed = true;
      }
    }
    if (!parser) {
      unparsed.push(unparsedRecord(relative, 'unavailable-parser'));
      continue;
    }
    const ast = parseJavaScript({ relative, source, plugins: jsPlugins, parser });
    const parsed = ast ? { units: collectUnits(relative, source, ast) } : { error: true };
    if (parsed.error) {
      unparsed.push(unparsedRecord(relative, 'syntax'));
      continue;
    }
    units.push(...parsed.units);
    if (cache && await cache.set(key, parsed.units)) cacheWrites += 1;
  }

  if (pythonFiles.length > 0 && now() < deadline) {
    const remaining = deadline - now();
    const child = await runPythonChild({ script: PYTHON_SCAN, files: pythonFiles.map(({ path: filePath, abs }) => ({ path: filePath, abs })), pythonBin, timeoutMs: Math.max(1, remaining), spawnSync });
    const ranges = child.status === 'ok'
      ? { status: 'ok', reason: null, units: Array.isArray(child.payload?.units) ? child.payload.units : [], errors: Array.isArray(child.payload?.errors) ? child.payload.errors : [] }
      : { status: 'failed', reason: child.reason, message: child.message, units: [], errors: [] };
    if (ranges.status !== 'ok') {
      unparsed.push(unparsedRecord('<python-adapter>', ranges.reason));
    } else {
      for (const error of ranges.errors) unparsed.push(unparsedRecord(error.path, error.reason));
      const byPath = new Map(pythonFiles.map(file => [file.path, file.source]));
      const perFileUnits = new Map(pythonFiles.map(file => [file.path, []]));
      for (const range of ranges.units) {
        const source = byPath.get(range.path);
        if (source === undefined) continue;
        const text = sliceLines(source, range);
        const shape = shapeOfSource(text, 'python');
        if (shape.tokens === 0) continue;
        const offsets = offsetsOf(source, range);
        const unit = { path: range.path, language: 'python', name: range.name, ...sourceSpan(range.lineStart, range.lineEnd), ...offsets, ...shape };
        units.push(unit);
        perFileUnits.get(range.path)?.push(unit);
      }
      if (cache) {
        // A successful parse is cached even when it yields no unit: a file with no eligible
        // function was still parsed, and sending it to the interpreter again next time is the cost
        // the cache exists to avoid. A file the adapter could not parse is never cached.
        const failed = new Set(ranges.errors.map(error => error.path));
        for (const file of pythonFiles) {
          if (failed.has(file.path)) continue;
          const collectedForFile = perFileUnits.get(file.path) ?? [];
          if (await cache.set(file.key, collectedForFile)) cacheWrites += 1;
        }
      }
    }
  } else if (pythonFiles.length > 0) {
    truncated = true;
    unparsed.push(unparsedRecord('<python-adapter>', 'analysis-budget-exhausted'));
  }

  const bounded = units.slice(0, config.maxUnits);
  if (units.length > bounded.length) truncated = true;
  const adapterFailed = unparsed.some(entry => entry.path === '<python-adapter>');
  const skippedSupported = unparsed.filter(entry => entry.path !== '<python-adapter>' && entry.reason !== 'unsupported-syntax').length;
  return {
    status: adapterFailed ? 'failed' : 'ok',
    coverage: adapterFailed ? 'failed' : truncated || skippedSupported > 0 ? 'partial' : 'full',
    units: bounded.sort(compareUnits),
    unparsed: dedupe(unparsed).slice(0, 20),
    // The list is capped for the artifact, the count is not: a caller that reports "how much was not
    // analysed" must not read a capped list as the whole story.
    unparsedTotal: new Set(unparsed.map(entry => `${entry.path}\u0000${entry.reason}`)).size,
    truncated,
    filesScanned,
    cacheHits,
    cacheWrites,
    elapsedMs: now() - started,
  };
}

/**
 * The one cache envelope. A written entry and a read entry come from these two functions, so a field
 * added to the envelope is added once instead of in a writer and a validator that can disagree.
 *
 * @param {object[]} units
 * @returns {{ schema: string, extractor: number, units: object[] }}
 */
export function cacheEnvelope(units) {
  return { schema: CACHE_SCHEMA, extractor: EXTRACTOR_VERSION, units };
}

/**
 * The envelope read back, or null when this machine cannot trust it: another schema, another
 * extractor version, or members that are not units all mean "parse the source again".
 *
 * @param {unknown} stored
 * @returns {object[]|null}
 */
export function parseCacheEnvelope(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const envelope = cacheEnvelope([]);
  if (stored.schema !== envelope.schema || stored.extractor !== envelope.extractor) return null;
  if (!Array.isArray(stored.units) || !stored.units.every(isUnitShape)) return null;
  return stored.units;
}

/**
 * True for a record the index can read. Anything else in the cache is a miss: a member with no
 * shingle array would throw deep inside the candidate comparison.
 *
 * @param {unknown} unit
 * @returns {boolean}
 */
export function isUnitShape(unit) {
  return Boolean(unit)
    && typeof unit === 'object'
    && typeof unit.path === 'string'
    && typeof unit.language === 'string'
    && Number.isFinite(unit.tokens)
    && Number.isFinite(unit.lineStart)
    && Number.isFinite(unit.lineEnd)
    && Array.isArray(unit.shingles)
    && Array.isArray(unit.calls)
    && unit.shingles.every(shingle => Number.isFinite(shingle));
}

/**
 * The cache key of one file: its language and its exact bytes. A review of unchanged bytes gets
 * the same units back, so the second review of one snapshot parses nothing.
 *
 * @param {string} language
 * @param {string} source
 * @returns {string}
 */
export function cacheKey(language, relative, source) {
  return createHash('sha256').update(`${EXTRACTOR_VERSION}\u0000${language}\u0000${relative}\u0000`).update(source).digest('hex');
}

function compareUnits(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.lineStart !== b.lineStart) return a.lineStart - b.lineStart;
  return (a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const key = `${entry.path}\u0000${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Character offsets of a line range, so a unit is identified by its bytes and not only by its lines.
 *
 * @param {string} source
 * @param {number} lineStart
 * @param {number} lineEnd
 * @returns {{ startOffset: number, endOffset: number }}
 */
function offsetsOf(source, span) {
  const { lineStart, lineEnd } = span;
  const text = String(source);
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  const from = starts[Math.max(0, Math.min(starts.length - 1, (lineStart ?? 1) - 1))];
  const toLine = Math.max(0, Math.min(starts.length - 1, (lineEnd ?? lineStart ?? 1) - 1));
  const to = toLine + 1 < starts.length ? starts[toLine + 1] - 1 : text.length;
  return { startOffset: from, endOffset: Math.max(from, to) };
}

function sliceLines(source, span) {
  const { lineStart, lineEnd } = span;
  const lines = String(source).split(/\r?\n/);
  const from = Math.max(0, (lineStart ?? 1) - 1);
  const to = Math.min(lines.length, lineEnd ?? lineStart ?? 1);
  return lines.slice(from, to).join('\n');
}

function collectUnits(relative, source, ast) {
  const units = [];
  walkAst(ast, (node, parent) => {
    if (!FUNCTION_TYPES.has(node.type)) return;
    const start = typeof node.start === 'number' ? node.start : null;
    const end = typeof node.end === 'number' ? node.end : null;
    if (start === null || end === null || end <= start) return;
    const shape = shapeOfSource(source.slice(start, end), 'javascript');
    if (shape.tokens === 0) return;
    units.push({
      path: relative,
      language: 'javascript',
      name: nameOf(node, parent),
      ...sourceSpan(node.loc?.start?.line ?? 1, node.loc?.end?.line ?? node.loc?.start?.line ?? 1),
      // Character offsets, not lines: two sibling definitions on one physical line have the same
      // lines and different offsets, and only the offsets tell them apart from one unit.
      startOffset: start,
      endOffset: end,
      ...shape,
    });
  });
  return units;
}

function nameOf(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') return parent.left.name;
  if (node.key?.name) return node.key.name;
  if (typeof node.key?.value === 'string') return node.key.value;
  return null;
}


