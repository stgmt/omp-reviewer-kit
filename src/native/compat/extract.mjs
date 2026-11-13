// One deterministic read of the changed code: which schema/version literals are produced, which are
// consumed, and which are listed as accepted. The census is a fact about the snapshot — it never
// decides that a version is junk; it says where each version is written, read and enumerated, so the
// hunter can ask who keeps an old format alive.
//
// JavaScript and TypeScript go through `@babel/parser` in this process, Python through the
// standard-library `ast` in one child interpreter. A file that cannot be parsed is reported as
// unparsed, never as a clean file.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { classifyFilePath } from '../../domain/file-class.mjs';
import { isTestPath } from '../../domain/suspicion-map.mjs';
import { collectExecutableFiles, walkAst } from '../maintainability/extract.mjs';
import { JS_EXTENSIONS, parseJavaScript } from '../scan/js-parse.mjs';
import { runPythonChild } from '../scan/python-child.mjs';

/** A schema literal the census understands: `family/vN`, the shape every versioned record uses. */
export const VERSION_LITERAL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/v\d+$/;

const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);
/** A name that holds accepted versions rather than a single record: a table or a supported list. */
const TABLE_NAME = /^(?:SUPPORTED_[A-Z0-9_]+|[A-Z0-9_]*_VERSIONS|SCHEMA_BY_[A-Z0-9_]+|[A-Z0-9_]+_BY_(?:KIND|TYPE|FORMAT|VERSION))$/;
/** The record fields that carry a version. */
const VERSION_FIELD = /^(?:schema|version)$/i;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVersionLiteral(value) {
  return typeof value === 'string' && VERSION_LITERAL.test(value);
}

/**
 * The family a literal belongs to: everything before the final `/vN`.
 *
 * @param {string} version
 * @returns {string}
 */
export function familyOf(version) {
  const slash = version.lastIndexOf('/');
  return slash === -1 ? version : version.slice(0, slash);
}

/**
 * Every version literal inside a value expression: a plain literal, a constant, or a literal inside
 * a conditional (`"a/v7" if kind else "a/v6"`). A writer that chooses a version at runtime still
 * writes exactly the versions its branches name, and those are what the census reports.
 *
 * @param {object|null|undefined} node
 * @param {Map<string, string>} constants
 * @returns {string[]}
 */
function versionsInJavaScript(node, constants) {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'StringLiteral') return isVersionLiteral(node.value) ? [node.value] : [];
  if (node.type === 'Identifier') return constants.has(node.name) ? [constants.get(node.name)] : [];
  const found = [];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) found.push(...versionsInJavaScript(child, constants));
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      found.push(...versionsInJavaScript(value, constants));
    }
  }
  return found;
}

/**
 * The version field a node reads: `schema`, `record.version`, or `record["schema"]`.
 *
 * @param {object|null|undefined} node
 * @returns {string|null}
 */
function versionFieldOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier' && VERSION_FIELD.test(node.name)) return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier' && VERSION_FIELD.test(node.property.name)) return node.property.name;
  if (node.type === 'MemberExpression' && node.computed && node.property?.type === 'StringLiteral' && VERSION_FIELD.test(node.property.value)) return node.property.value;
  return null;
}

function constantNameOf(node) {
  return node?.type === 'Identifier' ? node.name : null;
}

/**
 * Identifier names inside a value expression that this file does not define. A constant imported
 * from another changed module is resolved after every file is read, so `SCHEMA_V8` imported by a
 * reader still names the version its producer defines.
 *
 * @param {object|null|undefined} node
 * @param {Map<string, string>} constants
 * @returns {string[]}
 */
function unresolvedNames(node, constants) {
  const found = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'Identifier' && !constants.has(value.name)) found.add(value.name);
    for (const key of Object.keys(value)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
      const child = value[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(node);
  return [...found];
}

/**
 * @param {string} relative
 * @param {object} ast
 * @returns {{ path: string, language: string, produced: object[], consumed: object[], listed: object[], reads: object[], constants: object[] }}
 */
export function collectJavaScript(relative, ast) {
  const constants = new Map();
  const lists = new Map();
  walkAst(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'StringLiteral' && isVersionLiteral(node.init.value)) {
      constants.set(node.id.name, node.init.value);
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'ArrayExpression' && lists.has(node.id.name) === false) {
      const versions = node.init.elements.flatMap(element => versionsInJavaScript(element, constants));
      if (versions.length > 0) lists.set(node.id.name, [...new Set(versions)]);
    }
  });
  const produced = [];
  const consumed = [];
  const listed = [];
  const reads = [];
  const pending = [];
  walkAst(ast, node => {
    if (node.type === 'ObjectProperty' && !node.computed) {
      const key = node.key?.type === 'Identifier' ? node.key.name : node.key?.value;
      if (typeof key === 'string' && VERSION_FIELD.test(key)) {
        for (const version of versionsInJavaScript(node.value, constants)) {
          produced.push({ version, line: node.loc?.start?.line ?? 1, field: key });
        }
        for (const name of unresolvedNames(node.value, constants)) {
          pending.push({ kind: 'produced', name, line: node.loc?.start?.line ?? 1, field: key });
        }
      }
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && TABLE_NAME.test(node.id.name)) {
      const table = node.id.name;
      if (node.init?.type === 'ArrayExpression') {
        for (const element of node.init.elements) {
          for (const version of versionsInJavaScript(element, constants)) listed.push({ version, line: element?.loc?.start?.line ?? 1, table });
          for (const name of unresolvedNames(element, constants)) pending.push({ kind: 'listed', name, line: element?.loc?.start?.line ?? 1, table });
        }
      }
      if (node.init?.type === 'ObjectExpression') {
        for (const property of node.init.properties) {
          for (const version of versionsInJavaScript(property?.value, constants)) listed.push({ version, line: property?.loc?.start?.line ?? 1, table });
          for (const name of unresolvedNames(property?.value, constants)) pending.push({ kind: 'listed', name, line: property?.loc?.start?.line ?? 1, table });
        }
      }
    }
    if (node.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(node.operator)) {
      const left = versionFieldOf(node.left);
      const right = versionFieldOf(node.right);
      const versions = left ? versionsInJavaScript(node.right, constants) : right ? versionsInJavaScript(node.left, constants) : [];
      const other = left ? node.right : node.left;
      for (const version of versions) {
        consumed.push({ version, line: node.loc?.start?.line ?? 1, guard: 'compare', constant: constantNameOf(other) });
      }
      if (versions.length === 0) {
        for (const name of unresolvedNames(other, constants)) {
          pending.push({ kind: 'consumed', name, line: node.loc?.start?.line ?? 1, guard: 'compare' });
        }
      }
    }
    // `SUPPORTED.includes(record.schema)` and `SET.has(record.schema)` are the common supported-list
    // idiom: the versions the list accepts are consumed by the test, exactly like `in` in Python.
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed
      && ['includes', 'has'].includes(node.callee.property?.name)) {
      const list = node.callee.object;
      const line = node.loc?.start?.line ?? 1;
      const versions = versionsInJavaScript(list, constants);
      if (versions.length > 0) {
        for (const version of versions) consumed.push({ version, line, guard: `membership:${node.callee.property.name}`, constant: null });
      } else if (list?.type === 'Identifier') {
        pending.push({ kind: 'consumed', name: list.name, line, guard: `membership:${node.callee.property.name}`, list: true });
      }
    }
    // A switch on the version field consumes every case literal.
    if (node.type === 'SwitchStatement' && versionFieldOf(node.discriminant)) {
      for (const switchCase of node.cases ?? []) {
        if (!switchCase.test) continue;
        const line = switchCase.loc?.start?.line ?? 1;
        const versions = versionsInJavaScript(switchCase.test, constants);
        for (const version of versions) consumed.push({ version, line, guard: 'switch', constant: constantNameOf(switchCase.test) });
        if (versions.length === 0) {
          for (const name of unresolvedNames(switchCase.test, constants)) pending.push({ kind: 'consumed', name, line, guard: 'switch' });
        }
      }
    }
    if (node.type === 'MemberExpression' && node.computed && node.property?.type === 'StringLiteral') {
      reads.push({ name: node.property.value, line: node.loc?.start?.line ?? 1 });
    }
  });
  return {
    path: relative,
    language: 'javascript',
    produced,
    consumed,
    listed,
    reads,
    pending,
    lists: [...lists.entries()].map(([name, versions]) => ({ name, versions })),
    constants: [...constants.entries()].map(([name, version]) => ({ name, version })),
  };
}

/** One child interpreter for every Python file of the diff; the adapter reports syntax failures. */
const PYTHON_SCRIPT = String.raw`
import ast, json, re, sys

VERSION = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*/v\d+$')
FIELD = re.compile(r'^(schema|version)$', re.I)
TABLE = re.compile(r'^(SUPPORTED_[A-Z0-9_]+|[A-Z0-9_]*_VERSIONS|SCHEMA_BY_[A-Z0-9_]+|[A-Z0-9_]+_BY_(KIND|TYPE|FORMAT|VERSION))$')

request = json.loads(sys.stdin.read())
out = []
errors = []

def is_version(value):
    return isinstance(value, str) and bool(VERSION.match(value))

def const_value(node, constants):
    if isinstance(node, ast.Constant) and is_version(node.value):
        return node.value
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    return None

def versions_in(node, constants):
    found = []
    for child in ast.walk(node):
        if isinstance(child, ast.Constant) and is_version(child.value):
            found.append(child.value)
        elif isinstance(child, ast.Name) and child.id in constants:
            found.append(constants[child.id])
    return found

def unresolved_names(node, constants):
    found = []
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id not in constants and child.id not in found:
            found.append(child.id)
    return found

def field_name(node):
    if isinstance(node, ast.Name) and FIELD.match(node.id):
        return node.id
    if isinstance(node, ast.Subscript):
        sl = node.slice
        if isinstance(sl, ast.Constant) and isinstance(sl.value, str) and FIELD.match(sl.value):
            return sl.value
    if isinstance(node, ast.Attribute) and FIELD.match(node.attr):
        return node.attr
    return None

def guard_text(node):
    try:
        return ast.unparse(node)[:120]
    except Exception:
        return ''

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
    constants = {}
    lists = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if not isinstance(target, ast.Name):
                    continue
                if isinstance(node.value, ast.Constant) and is_version(node.value.value):
                    constants[target.id] = node.value.value
                if isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                    versions = []
                    for element in node.value.elts:
                        version = const_value(element, constants)
                        if version:
                            versions.append(version)
                    if versions:
                        lists[target.id] = versions
    produced, consumed, listed, reads, pending = [], [], [], [], []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and isinstance(key.value, str) and FIELD.match(key.value):
                    for version in versions_in(value, constants):
                        produced.append({'version': version, 'line': node.lineno, 'field': key.value})
                    for name in unresolved_names(value, constants):
                        pending.append({'kind': 'produced', 'name': name, 'line': node.lineno, 'field': key.value})
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if not isinstance(target, ast.Name) or not TABLE.match(target.id):
                    continue
                table = target.id
                if isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                    for element in node.value.elts:
                        version = const_value(element, constants)
                        if version:
                            listed.append({'version': version, 'line': element.lineno, 'table': table})
                        for name in unresolved_names(element, constants):
                            pending.append({'kind': 'listed', 'name': name, 'line': element.lineno, 'table': table})
                elif isinstance(node.value, ast.Dict):
                    for value in node.value.values:
                        version = const_value(value, constants)
                        if version:
                            listed.append({'version': version, 'line': value.lineno, 'table': table})
                        for name in unresolved_names(value, constants):
                            pending.append({'kind': 'listed', 'name': name, 'line': value.lineno, 'table': table})
        if isinstance(node, ast.Compare):
            if field_name(node.left):
                for op, comparator in zip(node.ops, node.comparators):
                    if isinstance(op, (ast.Eq, ast.NotEq)):
                        versions = versions_in(comparator, constants)
                        for version in versions:
                            consumed.append({'version': version, 'line': node.lineno, 'guard': guard_text(node), 'constant': comparator.id if isinstance(comparator, ast.Name) else None})
                        if not versions:
                            for name in unresolved_names(comparator, constants):
                                pending.append({'kind': 'consumed', 'name': name, 'line': node.lineno, 'guard': guard_text(node)})
                    elif isinstance(op, ast.In):
                        if isinstance(comparator, (ast.Tuple, ast.List, ast.Set)):
                            for element in comparator.elts:
                                version = const_value(element, constants)
                                if version:
                                    consumed.append({'version': version, 'line': node.lineno, 'guard': guard_text(node), 'constant': element.id if isinstance(element, ast.Name) else None})
                                for name in unresolved_names(element, constants):
                                    pending.append({'kind': 'consumed', 'name': name, 'line': node.lineno, 'guard': guard_text(node)})
                        elif isinstance(comparator, ast.Name):
                            pending.append({'kind': 'consumed', 'name': comparator.id, 'line': node.lineno, 'guard': guard_text(node), 'list': True})
        if isinstance(node, ast.Subscript):
            sl = node.slice
            if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
                reads.append({'name': sl.value, 'line': node.lineno})
    out.append({
        'path': item['path'],
        'language': 'python',
        'produced': produced,
        'consumed': consumed,
        'listed': listed,
        'reads': reads,
        'pending': pending,
        'lists': [{'name': name, 'versions': versions} for name, versions in lists.items()],
        'constants': [{'name': name, 'version': version} for name, version in constants.items()],
    })

json.dump({'files': out, 'errors': errors}, sys.stdout)
`;

/**
 * Reads the changed code files of a snapshot. Files beyond the caps and files that cannot be parsed
 * are reported, never silently dropped: the census states what it did not read.
 *
 * @param {{
 *   rootDir: string,
 *   paths: string[],
 *   config: object,
 *   now?: () => number,
 *   loadParser?: () => Promise<{ parse: Function }>,
 *   pythonBin?: string,
 *   spawnSync?: Function,
 * }} input
 * @returns {Promise<{
 *   files: object[],
 *   unparsed: Array<{ path: string, reason: string }>,
 *   failures: Array<{ path: string|null, reason: string, message?: string }>,
 *   scanned: number,
 *   truncated: boolean,
 *   elapsedMs: number,
 * }>}
 */
export async function extractCompat({ rootDir, paths, config, now = Date.now, loadParser, pythonBin = 'python', spawnSync = null }) {
  const started = now();
  const deadline = started + config.maxScanMs;
  const bounded = paths.slice(0, config.maxFiles);
  const truncated = paths.length > bounded.length;
  const files = [];
  const pythonPaths = [];
  const unparsed = [];
  const failures = [];
  let parser = null;
  let parserFailed = false;

  for (const relative of bounded) {
    const extension = path.extname(relative).toLowerCase();
    if (!JS_EXTENSIONS.has(extension) && !PYTHON_EXTENSIONS.has(extension)) continue;
    const absolute = path.join(rootDir, relative);
    let source;
    try {
      if ((await stat(absolute)).size > config.maxFileBytes) {
        unparsed.push({ path: relative, reason: 'oversized' });
        continue;
      }
      source = await readFile(absolute, 'utf8');
    } catch {
      unparsed.push({ path: relative, reason: 'unreadable' });
      continue;
    }
    if (PYTHON_EXTENSIONS.has(extension)) {
      pythonPaths.push(relative);
      continue;
    }
    if (parser === null && !parserFailed) {
      try {
        parser = await (loadParser ?? (() => import('@babel/parser')))();
      } catch (error) {
        parserFailed = true;
        failures.push({ path: null, reason: 'parser-unavailable', message: String(error?.message ?? error) });
      }
    }
    if (!parser) {
      unparsed.push({ path: relative, reason: 'parser-unavailable' });
      continue;
    }
    const ast = parseJavaScript({ relative, source, plugins: JS_EXTENSIONS.get(extension) ?? [], parser });
    if (!ast) {
      unparsed.push({ path: relative, reason: 'syntax' });
      continue;
    }
    files.push(collectJavaScript(relative, ast));
  }

  // Only the paths the loop accepted: a Python file already reported as oversized or unreadable must
  // not be parsed anyway, or the size cap would not bound Python work and the unparsed list would
  // name the same file twice.
  const pythonFiles = pythonPaths.map(relative => ({ path: relative, abs: path.join(rootDir, relative) }));
  if (pythonFiles.length > 0) {
    const child = await runPythonChild({
      script: PYTHON_SCRIPT,
      files: pythonFiles,
      timeoutMs: Math.max(1000, deadline - now()),
      pythonBin,
      spawnSync,
    });
    if (child.status !== 'ok') {
      for (const file of pythonFiles) unparsed.push({ path: file.path, reason: child.reason });
    } else {
      files.push(...(Array.isArray(child.payload?.files) ? child.payload.files : []));
      for (const error of Array.isArray(child.payload?.errors) ? child.payload.errors : []) {
        unparsed.push({ path: String(error?.path ?? '<python>'), reason: String(error?.reason ?? 'unparsed') });
      }
    }
  }

  const { elsewhere, truncated: elsewhereTruncated } = await collectElsewhere({
    rootDir,
    config,
    changed: bounded,
    now,
    deadline,
  });

  return {
    files,
    unparsed,
    failures,
    elsewhere,
    elsewhereTruncated,
    scanned: bounded.filter(relative => {
      const extension = path.extname(relative).toLowerCase();
      return JS_EXTENSIONS.has(extension) || PYTHON_EXTENSIONS.has(extension);
    }).length,
    truncated,
    elapsedMs: now() - started,
  };
}

/**
 * Version literals that appear in the snapshot outside the changed files. A version that the change
 * only reads may still be produced by an unchanged module, and saying it is produced nowhere would
 * be a false claim; the census names that site instead.
 *
 * @param {{ rootDir: string, config: object, changed: string[], now: () => number, deadline: number }} input
 * @returns {Promise<{ elsewhere: Array<{ version: string, path: string, line: number }>, truncated: boolean }>}
 */
async function collectElsewhere({ rootDir, config, changed, now, deadline }) {
  const changedSet = new Set(changed);
  const found = await collectExecutableFiles({
    rootDir,
    config,
    classify: file => (isTestPath(file) ? 'test' : classifyFilePath(file)),
    now,
    deadline,
  });
  const elsewhere = [];
  const seen = new Set();
  let truncated = found.truncated || found.skipped.length > 0;
  for (const relative of found.paths) {
    if (changedSet.has(relative)) continue;
    if (now() > deadline) {
      truncated = true;
      break;
    }
    let source;
    try {
      if ((await stat(path.join(rootDir, relative))).size > config.maxFileBytes) continue;
      source = await readFile(path.join(rootDir, relative), 'utf8');
    } catch {
      continue;
    }
    const pattern = /["']([A-Za-z0-9][A-Za-z0-9._-]*\/v\d+)["']/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const version = match[1];
      if (seen.has(version)) continue;
      seen.add(version);
      elsewhere.push({ version, path: relative, line: lineAt(source, match.index) });
      if (elsewhere.length >= config.maxSites) {
        truncated = true;
        break;
      }
    }
    if (elsewhere.length >= config.maxSites) break;
  }
  return { elsewhere, truncated };
}

/**
 * The 1-based line a character offset falls on.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {number}
 */
function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}
