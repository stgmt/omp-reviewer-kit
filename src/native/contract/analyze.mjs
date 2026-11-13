// The deterministic stage: read the changed JavaScript/TypeScript modules of the staged snapshot, find
// producer/consumer pairs, and settle them in a child process. It answers one question — does the
// record the writer actually produces survive the reader — and answers "not proven" when it cannot.
//
// A pair that throws is evidence; nothing else is. The stage never claims agreement it did not observe,
// never blocks on a pair it could not call, and reports its own limits (unparsed files, truncated scan)
// instead of presenting a partial pass as complete.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

import { READER, WRITER, describeParams, pairUp, probeArguments, recordFamily } from './find.mjs';
import { extractPythonFunctions } from './python.mjs';

export const CONTRACT_SCHEMA = 'contract@1';
export const CONTRACT_FILE = path.join('.review', 'contract.json');
export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_PAIRS = 40;
export const MAX_PROBE_MS = 20_000;
const SCRIPT_SUFFIXES = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const PYTHON_SUFFIXES = new Set(['.py', '.pyi']);

/**
 * The plugin name, read once: `OMP_REVIEW_KIT_CONTRACT` decides what the verdict may do with the
 * stage's answer (`off`, `advisory`, `block`; default `block`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'off'|'advisory'|'block'}
 */
export function contractPolicy(env = process.env) {
  const raw = String(env.OMP_REVIEW_KIT_CONTRACT ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'advisory' || raw === 'block') return raw;
  // `advisory` until the probe's argument grounding has a record in the field: a heuristic input must
  // never be the reason a valid commit is refused. `OMP_REVIEW_KIT_CONTRACT=block` opts in today.
  return 'advisory';
}

/**
 * @param {string} snapshotRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ status: string, files: number, unparsedFiles: string[], pairs: Array<object>, policy: string, note: string }>}
 */
export async function runContractAnalysis(snapshotRoot, env = process.env, { changedPaths = null } = {}) {
  const policy = contractPolicy(env);
  const policyNote = policy === 'block'
    ? 'A pair whose reader rejects the written record blocks the commit.'
    : policy === 'advisory'
      ? 'A pair whose reader rejects the written record is reported for the reviewer, never blocking on its own.'
      : 'The stage is off; nothing was probed.';
  const manifest = await readChangedFiles(snapshotRoot);
  if (manifest === null && !Array.isArray(changedPaths)) {
    // Without the manifest the stage cannot know what changed; saying "no pairs" would be a claim about
    // modules it never looked at.
    return {
      status: 'failed',
      files: 0,
      unparsedFiles: [],
      unproven: [],
      pairs: [],
      policy,
      note: 'the changed-file manifest is unreadable and the caller supplied no paths, so nothing was analysed',
    };
  }
  const changed = manifest ?? changedPaths ?? [];
  if (policy === 'off') {
    return { status: 'off', files: changed.length, unparsedFiles: [], pairs: [], policy, note: policyNote };
  }
  const candidates = [];
  const unparsedFiles = [];
  const unproven = [];
  if (changed.length > MAX_FILES) {
    unproven.push(`${changed.length - MAX_FILES} changed path(s) beyond the ${MAX_FILES}-file scan budget were not read`);
  }
  const pythonPaths = [];
  // One rule for both languages: the record must be the reader's only argument, in the only position
  // it can be. A defaulted or secondary parameter would shift the record into the wrong slot, and the
  // reader's answer would then describe the misbinding, not the contract.
  const buildCandidate = (pair, language) => {
    const args = probeArguments(pair.writerParams);
    const readerShape = pair.readerParams ?? [];
    const readerTakesRecordAlone = readerShape.length === 1 && readerShape[0].hasDefault !== true;
    if (args === null) {
      unproven.push(`${pair.file} ${pair.writer}: a required parameter's domain is not known, so the pair was not probed`);
      return null;
    }
    if (!readerTakesRecordAlone) {
      unproven.push(`${pair.file} ${pair.reader}: the reader declares ${readerShape.length} parameter(s), so the record cannot be placed in the only slot it accepts`);
      return null;
    }
    return { ...pair, arguments: args, language };
  };
  const collect = ({ file, functions, language }) => {
    const { pairs, unproven: unbuildable } = pairUp({ file, functions });
    unproven.push(...unbuildable);
    for (const pair of pairs) {
      const candidate = buildCandidate(pair, language);
      if (candidate) candidates.push(candidate);
    }
  };
  for (const file of changed.slice(0, MAX_FILES)) {
    const extension = path.extname(file);
    if (PYTHON_SUFFIXES.has(extension)) {
      try {
        if ((await stat(path.join(snapshotRoot, file))).size > MAX_FILE_BYTES) {
          unproven.push(`${file}: larger than ${MAX_FILE_BYTES} bytes, not parsed`);
          continue;
        }
      } catch {
        unproven.push(`${file}: unreadable in the snapshot`);
        continue;
      }
      pythonPaths.push(file);
      continue;
    }
    if (!SCRIPT_SUFFIXES.has(extension)) continue;
    const absolute = path.join(snapshotRoot, file);
    let source;
    try {
      if ((await stat(absolute)).size > MAX_FILE_BYTES) {
        unproven.push(`${file}: larger than ${MAX_FILE_BYTES} bytes, not parsed`);
        continue;
      }
      source = await readFile(absolute, 'utf8');
    } catch {
      unproven.push(`${file}: unreadable in the snapshot`);
      continue;
    }
    let functions;
    try {
      functions = parseFunctions(source, file);
    } catch (error) {
      unparsedFiles.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (functions === null) {
      unparsedFiles.push(`${file}: the syntax is not something this stage parses`);
      continue;
    }
    collect({ file, functions, language: 'javascript' });
  }
  if (pythonPaths.length > 0) {
    const python = await extractPythonFunctions({
      rootDir: snapshotRoot,
      paths: pythonPaths,
      pythonBin: env.OMP_REVIEW_KIT_PYTHON ?? 'python',
      timeoutMs: MAX_PROBE_MS,
    });
    unparsedFiles.push(...python.unparsed);
    for (const module of python.modules) collect({ file: module.file, functions: module.functions, language: 'python' });
    // A writer whose reader lives in another changed module is settled by that pair; the local
    // "no reader in this module" note would then describe work that was in fact done.
    for (const pair of pythonCrossPairs(python.modules)) {
      const candidate = buildCandidate(pair, 'python');
      if (candidate) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    const skipped = unproven.length + unparsedFiles.length;
    return {
      status: skipped > 0 ? 'partial' : 'no-pairs',
      files: changed.length,
      unparsedFiles,
      unproven,
      pairs: [],
      policy,
      note: skipped > 0
        ? `No pair was probed, and ${skipped} item(s) were skipped: that is not agreement.`
        : 'No producer/consumer pair was found among the changed modules, so no contract was checked.',
    };
  }

  if (candidates.length === 0) {
    return {
      status: unproven.length + unparsedFiles.length > 0 ? 'partial' : 'no-pairs',
      files: changed.length,
      unparsedFiles,
      unproven,
      pairs: [],
      policy,
      note: unproven.length + unparsedFiles.length > 0
        ? `No pair could be probed, and ${unproven.length + unparsedFiles.length} item(s) were skipped: that is not agreement.`
        : 'No producer/consumer pair was found among the changed modules, so no contract was checked.',
    };
  }

  const planned = candidates.slice(0, MAX_PAIRS);
  const dropped = candidates.length - planned.length;
  if (dropped > 0) unproven.push(`${dropped} pair(s) beyond the ${MAX_PAIRS} budget were not probed`);

  const probeTimeoutMs = Number(env.OMP_REVIEW_KIT_CONTRACT_TIMEOUT_MS) || MAX_PROBE_MS;
  const jsPairs = planned.filter(pair => pair.language !== 'python');
  const pythonPairs = planned.filter(pair => pair.language === 'python');
  const jsProbed = jsPairs.length > 0 ? await probePairs(snapshotRoot, jsPairs, probeTimeoutMs) : { results: [], failure: null };
  const pythonProbed = pythonPairs.length > 0
    ? await probePythonPairs(snapshotRoot, pythonPairs, probeTimeoutMs, env)
    : { results: [], failure: null };
  const probed = {
    results: [...jsProbed.results, ...pythonProbed.results],
    failure: jsProbed.failure ?? pythonProbed.failure,
  };
  const results = [];
  for (const pair of planned) {
    const found = probed.results.find(entry => entry.file === pair.file && entry.writer === pair.writer && entry.reader === pair.reader);
    results.push({
      file: pair.file,
      writerFile: pair.writerFile ?? pair.file,
      writer: pair.writer,
      reader: pair.reader,
      language: pair.language ?? null,
      crossModule: pair.crossModule === true,
      arguments: pair.arguments,
      outcome: found?.outcome ?? 'not-probed',
      error: found?.error ?? (found?.outcome === 'round-trip-ok' ? null : probed.failure ?? 'the probe produced no answer for this pair'),
      record: found?.record ?? null,
    });
  }
  // A note belongs to one file and one writer, and it is cleared only by a pair the probe actually
  // settled: two modules may export the same writer name, and a rejected import edge settles nothing.
  const settledCross = new Set(
    results
      .filter(result => result.crossModule === true && ['round-trip-ok', 'reader-rejects-written-record'].includes(result.outcome))
      .map(result => `${result.writerFile}\u0000${result.writer}`),
  );
  for (let index = unproven.length - 1; index >= 0; index -= 1) {
    const note = /^(\S+) (\S+): no reader of the same record family was found in this module$/.exec(unproven[index]);
    if (note && settledCross.has(`${note[1]}\u0000${note[2]}`)) unproven.splice(index, 1);
  }
  const rejected = results.filter(result => result.outcome === 'reader-rejects-written-record');
  const unprovenResults = results.filter(result => result.outcome !== 'reader-rejects-written-record' && result.outcome !== 'round-trip-ok');
  // A scan that skipped work is never reported as complete, even when every pair it did run agreed.
  const skipped = unprovenResults.length + unproven.length + unparsedFiles.length;
  const status = probed.failure ? 'failed' : rejected.length > 0 ? 'contract-violated' : skipped > 0 ? 'partial' : 'ok';
  const note = probed.failure
    ? `The probe could not run: ${probed.failure}`
    : rejected.length > 0
      ? `${rejected.length} pair(s) write a record their own reader rejects.`
      : skipped > 0
        ? `${skipped} item(s) could not be settled; that is not agreement.`
        : `${results.length} pair(s) round-tripped: every written record was accepted by its reader.`;
  const summary = {
    schema: CONTRACT_SCHEMA,
    status,
    files: changed.length,
    pairs: results,
    unparsedFiles,
    unproven,
    policy,
    note,
  };
  await writeFile(path.join(snapshotRoot, CONTRACT_FILE), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

/**
 * Cross-module Python pairs, proven by the import edge: the reader's module imports the writer by
 * name from the writer's module. A shared record family alone is not an edge, and without the edge a
 * rejection would describe two unrelated functions.
 *
 * @param {Array<{ file: string, functions: Array<object>, imports: Array<object> }>} modules
 * @returns {Array<object>}
 */
export function pythonCrossPairs(modules) {
  const byFile = new Map(modules.map(module => [module.file, module]));
  const readers = [];
  for (const module of modules) {
    for (const fn of module.functions) {
      if (READER.test(fn.name) && fn.params !== null) readers.push({ file: module.file, fn, family: recordFamily(fn.name, READER) });
    }
  }
  const pairs = [];
  for (const module of modules) {
    const localFamilies = new Set(
      module.functions.filter(fn => READER.test(fn.name) && fn.params !== null).map(fn => recordFamily(fn.name, READER)),
    );
    for (const writer of module.functions) {
      if (!WRITER.test(writer.name) || writer.params === null) continue;
      const family = recordFamily(writer.name, WRITER);
      if (localFamilies.has(family)) continue;
      for (const reader of readers) {
        if (reader.file === module.file || reader.family !== family) continue;
        if (!importsWriter(byFile.get(reader.file)?.imports ?? [], module.file, writer.name)) continue;
        pairs.push({
          file: reader.file,
          writerFile: module.file,
          readerFile: reader.file,
          writer: writer.name,
          reader: reader.fn.name,
          writerExport: writer.name,
          readerExport: reader.fn.name,
          writerParams: writer.params,
          readerParams: reader.fn.params,
          crossModule: true,
        });
      }
    }
  }
  return pairs;
}

/**
 * Whether one module's imports name the writer from the writer's module. The module path is compared
 * as a dotted suffix, because the snapshot root is not necessarily the import root.
 *
 * @param {Array<{ module: string, names: string[] }>} imports
 * @param {string} writerFile
 * @param {string} writerName
 * @returns {boolean}
 */
function importsWriter(imports, writerFile, writerName) {
  const dotted = writerFile.replace(/\.pyi?$/i, '').replace(/\\/g, '/').split('/').join('.');
  return imports.some(entry => {
    if (!entry || typeof entry.module !== 'string') return false;
    // A relative import cannot be resolved against the snapshot root, so it is not an edge.
    if (Number(entry.level ?? 0) > 0) return false;
    const matchesModule = entry.module === dotted || dotted.endsWith(`.${entry.module}`);
    if (!matchesModule) return false;
    const names = Array.isArray(entry.names) ? entry.names : [];
    return names.includes(writerName) || names.includes('*');
  });
}

/**
 * Runs the Python probe child once for every planned Python pair. The answer travels through a file
 * for the same reason the JavaScript probe uses one: a staged module may print, and those lines must
 * not be mistaken for the probe's answer.
 *
 * @param {string} snapshotRoot
 * @param {Array<object>} pairs
 * @param {number} timeoutMs
 * @param {object} env
 * @returns {Promise<{ results: Array<object>, failure: string|null }>}
 */
async function probePythonPairs(snapshotRoot, pairs, timeoutMs, env) {
  const script = path.join(import.meta.dirname, 'probe_python.py');
  const answerDir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-python-'));
  const answerFile = path.join(answerDir, 'answer.json');
  try {
    const child = spawnSync(env.OMP_REVIEW_KIT_PYTHON ?? 'python', [script], {
      input: JSON.stringify({ root: snapshotRoot, pairs, answerFile }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      cwd: snapshotRoot,
      env: { ...process.env, OMP_CONTRACT_ANSWER_FILE: answerFile },
    });
    if (child.error) return { results: [], failure: child.error.message };
    let raw = '';
    try {
      raw = (await readFile(answerFile, 'utf8')).trim();
    } catch {
      raw = '';
    }
    if (!raw) return { results: [], failure: `the python probe exited with ${child.status ?? 'no status'} and answered nothing` };
    try {
      const parsed = JSON.parse(raw);
      if (parsed.failed) return { results: [], failure: parsed.failed };
      return { results: parsed.results ?? [], failure: null };
    } catch {
      return { results: [], failure: 'the python probe answer was not JSON' };
    }
  } finally {
    await rm(answerDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The changed paths of the staged snapshot. `null` means the manifest could not be read — the caller
 * then decides whether its own list is enough.
 *
 * @param {string} snapshotRoot
 * @returns {Promise<string[]|null>}
 */
async function readChangedFiles(snapshotRoot) {
  try {
    const text = await readFile(path.join(snapshotRoot, '.review', 'changed-files.txt'), 'utf8');
    return text.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Parses one module through `@babel/parser` and returns the exported functions the pair finder can
 * use. `null` means the syntax was not understood — reported as unparsed, never as an empty module.
 */
export function parseFunctions(source, file, parser = null) {
  const api = parser ?? loadParser();
  let ast;
  try {
    ast = api.parse(source, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: false,
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAssertions', 'topLevelAwait'],
    });
  } catch {
    return null;
  }
  const functions = [];
  const add = (node, name, exportName = name) => {
    // `params: null` is kept on purpose: a function the probe cannot build is still a function the
    // finder must report as unproven, not one that quietly disappears from the scan. `name` decides the
    // record family; `exportName` says where the probe must look, since a default export is reachable
    // only as `module.default`.
    if (name) functions.push({ name, exportName, params: describeParams(node) });
  };
  for (const node of ast.program.body ?? []) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const declaration = node.declaration;
      if (declaration.type === 'FunctionDeclaration' && declaration.id) add(declaration, declaration.id.name);
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations ?? []) {
          if (declarator.init?.type === 'ArrowFunctionExpression' || declarator.init?.type === 'FunctionExpression') {
            add(declarator.init, declarator.id?.name);
          }
        }
      }
    }
    if (node.type === 'ExportDefaultDeclaration' && (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'FunctionExpression')) {
      add(node.declaration, node.declaration.id?.name ?? 'default', 'default');
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      // A plain function is not exported, and the probe cannot call it: recorded as a non-pair by name.
      add(node, node.id.name);
    }
  }
  return functions;
}

let cachedParser = null;
function loadParser() {
  if (cachedParser) return cachedParser;
  // The parser is a runtime dependency of this kit; a missing one is a stage failure, not a pass.
  const require = createRequire(import.meta.url);
  cachedParser = require('@babel/parser');
  return cachedParser;
}

/**
 * Runs the probe child once for every planned pair.
 *
 * @param {string} snapshotRoot
 * @param {Array<object>} pairs
 * @returns {{ results: Array<object>, failure: string|null }}
 */
async function probePairs(snapshotRoot, pairs, timeoutMs = MAX_PROBE_MS) {
  const script = path.join(import.meta.dirname, 'probe.mjs');
  // The child answers through a file: a staged module may log to stdout, and those lines must not be
  // mistaken for the probe's answer.
  const answerDir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-answer-'));
  const answerFile = path.join(answerDir, 'answer.json');
  try {
    const child = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ root: snapshotRoot, pairs, answerFile }),
      encoding: 'utf8',
      // Module output is not protocol data: a chatty import must not overflow the default capture
      // buffer and turn a completed observation into a failed analysis.
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      cwd: snapshotRoot,
      env: { ...process.env, OMP_CONTRACT_ANSWER_FILE: answerFile },
    });
    if (child.error) return { results: [], failure: child.error.message };
    let raw = '';
    try {
      raw = (await readFile(answerFile, 'utf8')).trim();
    } catch {
      // No answer file: the child died before it could speak.
      raw = '';
    }
    if (!raw) {
      return { results: [], failure: `the probe exited with ${child.status ?? 'no status'} and answered nothing` };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.failed) return { results: [], failure: parsed.failed };
      return { results: parsed.results ?? [], failure: null };
    } catch {
      return { results: [], failure: 'the probe answer was not JSON' };
    }
  } finally {
    await rm(answerDir, { recursive: true, force: true }).catch(() => {});
  }
}
