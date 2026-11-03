// Deterministic signature extraction from a directory tree. Two adapters: JS/TS through
// `@babel/parser` in this process, Python through the standard-library `ast` in one child
// interpreter. Nothing here counts groups or judges meaning: it reports what the syntax says.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sourceSpan } from '../../domain/source-span.mjs';
import { unparsedRecord } from '../../domain/unparsed-record.mjs';
import { JS_EXTENSIONS, parseJavaScript } from '../scan/js-parse.mjs';
import { runPythonChild } from '../scan/python-child.mjs';

/** Extensions each adapter owns. Anything else is `unsupported-syntax` for its paths. */
const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.review', 'dist', 'build', 'out', 'coverage', 'vendor', '__pycache__', '.venv', 'venv']);

/**
 * The Python side of the extraction, run once per analysis. Reads one JSON request from stdin and
 * writes one JSON reply to stdout; a file it cannot parse becomes an entry, never an exception.
 *
 * @param {string} source
 */
const PYTHON_SCRIPT = String.raw`
import ast, json, sys

request = json.loads(sys.stdin.read())
out = []
errors = []
for item in request.get('files', []):
    try:
        with open(item['abs'], 'r', encoding='utf-8', errors='replace') as handle:
            source = handle.read()
        tree = ast.parse(source, filename=item['path'])
    except (SyntaxError, ValueError) as error:
        errors.append({'path': item['path'], 'reason': 'syntax', 'message': type(error).__name__})
        continue
    except OSError:
        errors.append({'path': item['path'], 'reason': 'unreadable', 'message': 'OSError'})
        continue
    calls = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            names = [k.arg for k in node.keywords if k.arg]
            if len(names) >= 2:
                calls[(node.lineno, node.col_offset)] = sorted(set(names))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        args = node.args
        if any(isinstance(a, ast.Tuple) for a in list(args.args)):
            continue
        params = [a.arg for a in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs) if a.arg not in ('self', 'cls')]
        params = sorted(set(params))
        if len(params) < 2:
            continue
        role = 'definition'
        body = [s for s in node.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str))]
        if len(body) == 1 and isinstance(body[0], ast.Return) and isinstance(body[0].value, ast.Call):
            forwarded = [k.arg for k in body[0].value.keywords if k.arg]
            forwarded += [a.id for a in body[0].value.args if isinstance(a, ast.Name)]
            if set(params) <= set(forwarded):
                role = 'forwarder'
                calls.pop((body[0].value.lineno, body[0].value.col_offset), None)
        out.append({
            'path': item['path'],
            'language': 'python',
            'name': node.name,
            'params': params,
            'lineStart': node.lineno,
            'lineEnd': getattr(node, 'end_lineno', node.lineno),
            'role': role,
        })
    for (line, col), names in sorted(calls.items()):
        out.append({
            'path': item['path'],
            'language': 'python',
            'name': None,
            'params': names,
            'lineStart': line,
            'lineEnd': line,
            'role': 'call-site',
        })
out.sort(key=lambda s: (s['path'], s['lineStart'], s['role'], s['name'] or '', s['params']))
json.dump({'signatures': out, 'errors': errors}, sys.stdout)
`;

/**
 * Walks a tree and returns the executable files the analysis may read, sorted by path. Files over
 * the size limit are reported, never opened, so a minified bundle cannot buy the scan's whole budget.
 *
 * @param {{ rootDir: string, config: object, classify: (filePath: string) => string }} input
 */
export async function collectExecutableFiles({ rootDir, config, classify, now = null, deadline = null, maxSkipped = Infinity }) {
  const found = [];
  const skipped = [];
  const queue = [''];
  let truncated = false;
  while (queue.length > 0) {
    if (now && deadline !== null && now() > deadline) { truncated = true; break; }
    const relative = queue.shift();
    const absolute = relative ? path.join(rootDir, relative) : rootDir;
    let entries;
    try {
      entries = await readDirSorted(absolute);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A directory with a thousand entries is one queue iteration: the budget has to be checked
      // per entry too, or a flat tree overruns the deadline it was given.
      if (now && deadline !== null && now() > deadline) { truncated = true; break; }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (classify(child) !== 'executable') continue;
      if (found.length >= config.maxScanFiles) {
        // Past the file ceiling the walk keeps going only to report what it did not read; an
        // unbounded excess list would hold the whole tree in memory for that reason alone.
        if (skipped.length < maxSkipped) skipped.push(unparsedRecord(child, 'max-scan-files'));
        else truncated = true;
        continue;
      }
      found.push(child);
    }
  }
  return { paths: found.sort(), skipped, truncated };
}

async function readDirSorted(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Extracts signatures and call-sites from one directory tree.
 *
 * @param {{
 *   rootDir: string,
 *   paths: string[],
 *   config: object,
 *   now?: () => number,
 *   pythonBin?: string,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   spawnSync?: Function,
 * }} input
 * @returns {Promise<{
 *   status: 'ok'|'failed',
 *   signatures: Array<object>,
 *   unparsedFiles: Array<unparsedRecord(string, string)>,
 *   failures: Array<{ path: string|null, reason: string, message: string }>,
 *   languages: Array<{ language: string, parser: string, filesParsed: number, filesFailed: number }>,
 *   truncated: boolean,
 *   filesRead: number,
 *   filesSkipped: number,
 *   elapsedMs: number,
 * }>}
 */
export async function extractSignatures({
  rootDir,
  paths,
  config,
  now = Date.now,
  pythonBin = 'python',
  loadParser = () => import('@babel/parser'),
  spawnSync = null,
}) {
  const started = now();
  const deadline = started + config.maxScanMs;
  const signatures = [];
  const unparsedFiles = [];
  const failures = [];
  const counts = {
    javascript: { language: 'javascript', parser: '@babel/parser', filesParsed: 0, filesFailed: 0 },
    python: { language: 'python', parser: 'ast', filesParsed: 0, filesFailed: 0 },
  };
  const pythonFiles = [];
  let filesRead = 0;
  let filesSkipped = 0;
  let truncated = false;
  let parser = null;
  let parserError = null;

  for (const relative of paths) {
    if (now() > deadline) {
      truncated = true;
      filesSkipped += 1;
      continue;
    }
    const absolute = path.join(rootDir, relative);
    const extension = path.extname(relative).toLowerCase();
    const jsPlugins = JS_EXTENSIONS.get(extension);
    if (!jsPlugins && !PYTHON_EXTENSIONS.has(extension)) {
      unparsedFiles.push(unparsedRecord(relative, 'unsupported-syntax'));
      continue;
    }
    let size = 0;
    try {
      size = (await stat(absolute)).size;
    } catch {
      unparsedFiles.push(unparsedRecord(relative, 'unreadable'));
      counts[jsPlugins ? 'javascript' : 'python'].filesFailed += 1;
      continue;
    }
    if (size > config.maxFileBytes) {
      unparsedFiles.push(unparsedRecord(relative, 'too-large'));
      continue;
    }
    let source;
    try {
      source = await readFile(absolute, 'utf8');
    } catch {
      unparsedFiles.push(unparsedRecord(relative, 'unreadable'));
      continue;
    }
    if (source.includes('\u0000')) {
      unparsedFiles.push(unparsedRecord(relative, 'unreadable'));
      continue;
    }
    filesRead += 1;
    if (PYTHON_EXTENSIONS.has(extension)) {
      pythonFiles.push({ path: relative, abs: absolute });
      continue;
    }
    if (!parser && !parserError) {
      try {
        parser = await loadParser();
      } catch (error) {
        parserError = error;
      }
    }
    if (!parser) {
      counts.javascript.filesFailed += 1;
      unparsedFiles.push(unparsedRecord(relative, 'unavailable-parser'));
      continue;
    }
    const parsed = parseJavaScriptFile({ relative, source, plugins: jsPlugins, parser });
    if (parsed.error) {
      counts.javascript.filesFailed += 1;
      unparsedFiles.push(unparsedRecord(relative, 'syntax'));
      continue;
    }
    counts.javascript.filesParsed += 1;
    signatures.push(...parsed.signatures);
  }

  if (pythonFiles.length > 0) {
    const python = await runPythonAdapter({ files: pythonFiles, pythonBin, timeoutMs: Math.max(1000, deadline - now()), spawnSync });
    if (python.status === 'timeout') {
      truncated = true;
      unparsedFiles.push(unparsedRecord('<python-adapter>', 'analysis-budget-exhausted'));
    } else if (python.status === 'failed' && python.reason === 'analysis-budget-exhausted') {
      // The budget ran out before the child answered: the scan is partial, not broken.
      truncated = true;
      unparsedFiles.push(unparsedRecord('<python-adapter>', 'analysis-budget-exhausted'));
    } else if (python.status === 'failed') {
      failures.push({ path: null, reason: python.reason, message: python.message });
      counts.python.filesFailed += pythonFiles.length;
      for (const file of pythonFiles) unparsedFiles.push(unparsedRecord(file.path, python.reason));
    } else {
      signatures.push(...python.signatures);
      counts.python.filesParsed += pythonFiles.length - python.errors.length;
      counts.python.filesFailed += python.errors.length;
      for (const error of python.errors) unparsedFiles.push(unparsedRecord(error.path, error.reason === 'syntax' ? 'syntax' : error.reason));
    }
  }

  if (parserError) failures.push({ path: null, reason: 'unavailable-parser', message: String(parserError?.message ?? parserError) });

  const uniqueUnparsed = dedupeByPath(unparsedFiles);
  return {
    status: failures.length > 0 ? 'failed' : 'ok',
    signatures: sortSignatures(signatures),
    unparsedFiles: uniqueUnparsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    failures,
    languages: [counts.javascript, counts.python].filter(entry => entry.filesParsed > 0 || entry.filesFailed > 0),
    truncated,
    filesRead,
    filesSkipped,
    elapsedMs: now() - started,
  };
}

function dedupeByPath(list) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  return out;
}

function sortSignatures(signatures) {
  return signatures.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.lineStart !== b.lineStart) return a.lineStart - b.lineStart;
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    const nameA = a.name ?? '';
    const nameB = b.name ?? '';
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return a.params.join(',') < b.params.join(',') ? -1 : a.params.join(',') > b.params.join(',') ? 1 : 0;
  });
}

/**
 * One file through `@babel/parser`. A dialect the first plugin set rejects gets one documented
 * second attempt; when both fail the file is unparsed, never silently empty.
 */
function parseJavaScriptFile({ relative, source, plugins, parser }) {
  const ast = parseJavaScript({ relative, source, plugins, parser });
  return ast ? { signatures: collectJavaScript(relative, ast) } : { error: true };
}

function collectJavaScript(relative, ast) {
  const signatures = [];
  const forwarderCalls = new Set();
  const firstPass = [];

  walk(ast, (node, parent) => {
    if (isFunctionNode(node)) {
      const params = parameterNames(node.params);
      if (!params) return;
      if (params.length < 2) return;
      const role = isForwarder(node) ? 'forwarder' : 'definition';
      if (role === 'forwarder') {
        const call = forwarderCall(node);
        if (call) forwarderCalls.add(call);
      }
      firstPass.push({
        path: relative,
        language: 'javascript',
        name: functionName(node, parent),
        params,
        ...sourceSpan(node.loc?.start?.line ?? 0, node.loc?.end?.line ?? node.loc?.start?.line ?? 0),
        role,
      });
      return;
    }
    if (node.type === 'CallExpression') {
      if (forwarderCalls.has(node)) return;
      const names = [];
      for (const argument of node.arguments) {
        const fromArgument = argumentNames(argument);
        if (!fromArgument) return;
        names.push(...fromArgument);
      }
      if (names.length < 2) return;
      firstPass.push({
        path: relative,
        language: 'javascript',
        name: null,
        params: [...new Set(names)].sort(),
        ...sourceSpan(node.loc?.start?.line ?? 0, node.loc?.end?.line ?? node.loc?.start?.line ?? 0),
        role: 'call-site',
      });
    }
  });

  for (const entry of firstPass) if (entry) signatures.push(entry);
  return signatures;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ObjectMethod',
  'ClassPrivateMethod',
]);

function isFunctionNode(node) {
  return FUNCTION_TYPES.has(node.type);
}

/**
 * Parameter names, or `null` when a parameter cannot be represented as a name. An object pattern
 * contributes its property keys: `charge({ userId, tenantId })` takes two named values, and
 * dropping them would hide the most common shape of a repeated group.
 */
function parameterNames(params) {
  const names = [];
  for (const parameter of params ?? []) {
    if (!collectParameterNames(parameter, names)) return null;
  }
  return [...new Set(names)].sort();
}

function collectParameterNames(parameter, names) {
  if (!parameter || typeof parameter !== 'object') return false;
  switch (parameter.type) {
    case 'Identifier':
      names.push(parameter.name);
      return true;
    case 'AssignmentPattern':
      return collectParameterNames(parameter.left, names);
    case 'RestElement':
      return parameter.argument ? collectParameterNames(parameter.argument, names) : false;
    case 'TSParameterProperty':
      // Babel stores the wrapped parameter in `parameter`, not `argument`.
      return collectParameterNames(parameter.parameter ?? parameter.argument, names);
    case 'ObjectPattern':
      for (const property of parameter.properties ?? []) {
        if (property.type === 'RestElement') continue;
        if (property.computed) return false;
        const key = property.key;
        const name = key?.type === 'Identifier' ? key.name : typeof key?.value === 'string' ? key.value : null;
        if (!name) return false;
        names.push(name);
      }
      return true;
    default:
      return false;
  }
}

/**
 * Names one call argument spells: a bare identifier or object-literal keys. Other shapes
 * (`request.amount`, a literal, a nested call) name nothing and contribute nothing, but they do not
 * invalidate the site. Spread and computed keys do: the names they carry are not written down.
 */
function argumentNames(argument) {
  if (argument?.type === 'Identifier') return [argument.name];
  if (argument?.type === 'SpreadElement') return null;
  if (argument?.type !== 'ObjectExpression') return [];
  const names = [];
  for (const property of argument.properties ?? []) {
    if (property.type !== 'ObjectProperty' || property.computed) return null;
    const key = property.key;
    const name = key?.type === 'Identifier' ? key.name : typeof key?.value === 'string' ? key.value : null;
    if (!name) return null;
    names.push(name);
  }
  return names;
}

function functionName(node, parent = null) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') return parent.left.name;
  if (node.key?.name) return node.key.name;
  if (node.key?.value && typeof node.key.value === 'string') return node.key.value;
  return null;
}

function forwarderCall(node) {
  if (node.type === 'ArrowFunctionExpression' && node.body?.type === 'CallExpression') return node.body;
  const body = node.type === 'ArrowFunctionExpression' && node.body?.type !== 'BlockStatement'
    ? node.body
    : singleStatement(node.body);
  if (!body) return null;
  const statement = body.type === 'ReturnStatement' ? body.argument : body.type === 'ExpressionStatement' ? body.expression : null;
  return statement?.type === 'CallExpression' ? statement : null;
}

function singleStatement(body) {
  if (body?.type !== 'BlockStatement') return null;
  const statements = body.body ?? [];
  return statements.length === 1 ? statements[0] : null;
}

function isForwarder(node) {
  const call = forwarderCall(node);
  if (!call) return false;
  const params = parameterNames(node.params) ?? [];
  if (params.length === 0) return false;
  const forwarded = new Set([
    ...call.arguments.filter(argument => argument?.type === 'Identifier').map(argument => argument.name),
  ]);
  return params.every(name => forwarded.has(name));
}

/** Walks any Babel or Python-shaped JSON tree by structural recursion over object properties. */
function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, parent);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    if (value && typeof value === 'object') walk(value, visit, node);
  }
}

export { walk as walkAst };

/**
 * Python through one child interpreter: the adapter answers with signatures or with a reason the
 * analysis can record. A missing interpreter is `no-interpreter`, never a silent skip.
 */
async function runPythonAdapter({ files, pythonBin, timeoutMs, spawnSync }) {
  const child = await runPythonChild({ script: PYTHON_SCRIPT, files, pythonBin, timeoutMs, spawnSync });
  if (child.status !== 'ok') return { status: 'failed', reason: child.reason, message: child.message };
  const payload = child.payload;
  return {
    status: 'ok',
    signatures: Array.isArray(payload?.signatures) ? payload.signatures : [],
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
  };
}
