// Deterministic signature extraction from a directory tree. Two adapters: JS/TS through
// `@babel/parser` in this process, Python through the standard-library `ast` in one child
// interpreter. Nothing here counts groups or judges meaning: it reports what the syntax says.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Extensions each adapter owns. Anything else is `unsupported-syntax` for its paths. */
const JS_EXTENSIONS = new Map([
  ['.mjs', ['jsx', 'decorators-legacy']],
  ['.cjs', ['jsx', 'decorators-legacy']],
  ['.js', ['jsx', 'decorators-legacy']],
  ['.jsx', ['jsx', 'decorators-legacy']],
  ['.ts', ['typescript']],
  ['.mts', ['typescript']],
  ['.cts', ['typescript']],
  ['.tsx', ['typescript', 'jsx']],
]);
const SECOND_ATTEMPT = ['typescript', 'jsx', 'decorators-legacy'];
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
export async function collectExecutableFiles({ rootDir, config, classify }) {
  const found = [];
  const skipped = [];
  const queue = [''];
  while (queue.length > 0) {
    const relative = queue.shift();
    const absolute = relative ? path.join(rootDir, relative) : rootDir;
    let entries;
    try {
      entries = await readDirSorted(absolute);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (classify(child) !== 'executable') continue;
      if (found.length >= config.maxScanFiles) {
        skipped.push({ path: child, reason: 'max-scan-files' });
        continue;
      }
      found.push(child);
    }
  }
  return { paths: found.sort(), skipped };
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
 *   unparsedFiles: Array<{ path: string, reason: string }>,
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
      unparsedFiles.push({ path: relative, reason: 'unsupported-syntax' });
      continue;
    }
    let size = 0;
    try {
      size = (await stat(absolute)).size;
    } catch {
      unparsedFiles.push({ path: relative, reason: 'unreadable' });
      counts[jsPlugins ? 'javascript' : 'python'].filesFailed += 1;
      continue;
    }
    if (size > config.maxFileBytes) {
      unparsedFiles.push({ path: relative, reason: 'too-large' });
      continue;
    }
    let source;
    try {
      source = await readFile(absolute, 'utf8');
    } catch {
      unparsedFiles.push({ path: relative, reason: 'unreadable' });
      continue;
    }
    if (source.includes('\u0000')) {
      unparsedFiles.push({ path: relative, reason: 'unreadable' });
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
      unparsedFiles.push({ path: relative, reason: 'unavailable-parser' });
      continue;
    }
    const parsed = parseJavaScript({ relative, source, plugins: jsPlugins, parser });
    if (parsed.error) {
      counts.javascript.filesFailed += 1;
      unparsedFiles.push({ path: relative, reason: 'syntax' });
      continue;
    }
    counts.javascript.filesParsed += 1;
    signatures.push(...parsed.signatures);
  }

  if (pythonFiles.length > 0) {
    const python = await runPythonAdapter({ files: pythonFiles, pythonBin, timeoutMs: Math.max(1000, deadline - now()), spawnSync });
    if (python.status === 'failed') {
      failures.push({ path: null, reason: python.reason, message: python.message });
      counts.python.filesFailed += pythonFiles.length;
      for (const file of pythonFiles) unparsedFiles.push({ path: file.path, reason: python.reason });
    } else {
      signatures.push(...python.signatures);
      counts.python.filesParsed += pythonFiles.length - python.errors.length;
      counts.python.filesFailed += python.errors.length;
      for (const error of python.errors) unparsedFiles.push({ path: error.path, reason: error.reason === 'syntax' ? 'syntax' : error.reason });
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
function parseJavaScript({ relative, source, plugins, parser }) {
  const attempts = [plugins, SECOND_ATTEMPT];
  for (const attempt of attempts) {
    try {
      const ast = parser.parse(source, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: false,
        plugins: attempt,
      });
      return { signatures: collectJavaScript(relative, ast) };
    } catch {
      continue;
    }
  }
  return { error: true };
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
        lineStart: node.loc?.start?.line ?? 0,
        lineEnd: node.loc?.end?.line ?? node.loc?.start?.line ?? 0,
        role,
      });
      return;
    }
    if (node.type === 'CallExpression') {
      if (forwarderCalls.has(node)) return;
      const names = node.arguments
        .filter(argument => argument?.type === 'Identifier')
        .map(argument => argument.name);
      if (names.length < 2 || names.length !== node.arguments.length) return;
      firstPass.push({
        path: relative,
        language: 'javascript',
        name: null,
        params: [...new Set(names)].sort(),
        lineStart: node.loc?.start?.line ?? 0,
        lineEnd: node.loc?.end?.line ?? node.loc?.start?.line ?? 0,
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
 * Parameter names, or `null` when a parameter cannot be represented as a name (destructuring).
 * A signature that cannot be named is skipped: guessing would invent a group.
 */
function parameterNames(params) {
  const names = [];
  for (const parameter of params ?? []) {
    if (parameter?.type === 'Identifier') {
      names.push(parameter.name);
      continue;
    }
    if (parameter?.type === 'AssignmentPattern' && parameter.left?.type === 'Identifier') {
      names.push(parameter.left.name);
      continue;
    }
    if (parameter?.type === 'RestElement' && parameter.argument?.type === 'Identifier') continue;
    return null;
  }
  return [...new Set(names)].sort();
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

/**
 * Python through one child interpreter: the adapter answers with signatures or with a reason the
 * analysis can record. A missing interpreter is `no-interpreter`, never a silent skip.
 */
async function runPythonAdapter({ files, pythonBin, timeoutMs, spawnSync }) {
  const spawn = spawnSync ?? (await import('node:child_process')).spawnSync;
  const result = spawn(pythonBin, ['-c', PYTHON_SCRIPT], {
    input: JSON.stringify({ files }),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result?.error?.code === 'ENOENT') return { status: 'failed', reason: 'no-interpreter', message: 'python interpreter not found' };
  if (result?.error) return { status: 'failed', reason: 'failed', message: String(result.error.message ?? result.error) };
  if (result?.signal) return { status: 'failed', reason: 'failed', message: `python adapter stopped by ${result.signal}` };
  if (result?.status !== 0) return { status: 'failed', reason: 'failed', message: String(result?.stderr ?? '').slice(0, 500) || `python adapter exit ${result?.status}` };
  let payload;
  try {
    payload = JSON.parse(String(result.stdout ?? ''));
  } catch {
    return { status: 'failed', reason: 'failed', message: 'python adapter returned unreadable output' };
  }
  return {
    status: 'ok',
    signatures: Array.isArray(payload?.signatures) ? payload.signatures : [],
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
  };
}
