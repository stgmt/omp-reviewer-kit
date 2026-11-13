// Python side of the producer/consumer reconciliation: the exported functions a probe can call, read
// through the standard-library `ast` in one child interpreter. The shape is the same one the
// JavaScript adapter produces, so the pair finder and the argument grounding are shared, not copied.

import { runPythonChild } from '../scan/python-child.mjs';

/** Module-level functions a probe can call; an underscore prefix is the Python convention for private. */
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
    except (SyntaxError, ValueError):
        errors.append({'path': item['path'], 'reason': 'syntax'})
        continue
    except OSError:
        errors.append({'path': item['path'], 'reason': 'unreadable'})
        continue
    functions = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name.startswith('_'):
            continue
        arguments = node.args
        buildable = not arguments.vararg and not arguments.kwarg and not arguments.kwonlyargs
        positional = list(arguments.args)
        defaults = [None] * (len(positional) - len(arguments.defaults)) + list(arguments.defaults)
        params = []
        for argument, default in zip(positional, defaults):
            params.append({'kind': 'scalar', 'name': argument.arg, 'hasDefault': default is not None})
        functions.append({
            'name': node.name,
            'exportName': node.name,
            'params': params if buildable else None,
        })
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imports.append({'module': node.module, 'names': [alias.name for alias in node.names], 'level': node.level or 0})
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({'module': alias.name, 'names': []})
    out.append({'path': item['path'], 'functions': functions, 'imports': imports})

json.dump({'files': out, 'errors': errors}, sys.stdout)
`;

/**
 * @param {{ rootDir: string, paths: string[], pythonBin?: string, timeoutMs?: number, spawnSync?: Function }} input
 * @returns {Promise<{ modules: Array<{ file: string, functions: Array<object> }>, unparsed: string[] }>}
 */
export async function extractPythonFunctions({ rootDir, paths, pythonBin = 'python', timeoutMs = 20_000, spawnSync = null }) {
  if (paths.length === 0) return { modules: [], unparsed: [] };
  const child = await runPythonChild({
    script: PYTHON_SCRIPT,
    files: paths.map(relative => ({ path: relative, abs: `${rootDir}/${relative}` })),
    timeoutMs,
    pythonBin,
    spawnSync,
  });
  if (child.status !== 'ok') {
    // A missing interpreter or a rejected dialect is unparsed, never a pass and never a failure of
    // the whole stage: the same rule the maintainability extractor applies to Python.
    return { modules: [], unparsed: paths.map(relative => `${relative}: ${child.reason}`) };
  }
  const modules = (Array.isArray(child.payload?.files) ? child.payload.files : [])
    .map(entry => ({
      file: String(entry?.path ?? ''),
      functions: Array.isArray(entry?.functions) ? entry.functions : [],
      imports: Array.isArray(entry?.imports) ? entry.imports : [],
    }))
    .filter(entry => entry.file.length > 0);
  const unparsed = (Array.isArray(child.payload?.errors) ? child.payload.errors : [])
    .map(error => `${String(error?.path ?? '<python>')}: ${String(error?.reason ?? 'unparsed')}`);
  return { modules, unparsed };
}
