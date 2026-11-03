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

import { describeParams, pairUp, probeArguments } from './find.mjs';

export const CONTRACT_SCHEMA = 'contract@1';
export const CONTRACT_FILE = path.join('.review', 'contract.json');
export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_PAIRS = 40;
export const MAX_PROBE_MS = 20_000;
const SCRIPT_SUFFIXES = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);

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
  for (const file of changed.slice(0, MAX_FILES)) {
    if (!SCRIPT_SUFFIXES.has(path.extname(file))) continue;
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
    const { pairs, unproven: unbuildable } = pairUp({ file, functions });
    unproven.push(...unbuildable);
    for (const pair of pairs) {
      const args = probeArguments(pair.writerParams);
      // The record must be the reader's only argument, in the only position it can be: a defaulted or
      // secondary parameter would shift the record into the wrong slot and the reader's answer would
      // then describe the misbinding, not the contract.
      const readerShape = pair.readerParams ?? [];
      const readerTakesRecordAlone = readerShape.length === 1 && readerShape[0].hasDefault !== true;
      if (args === null) {
        unproven.push(`${file} ${pair.writer}: a required parameter's domain is not known, so the pair was not probed`);
        continue;
      }
      if (!readerTakesRecordAlone) {
        unproven.push(`${file} ${pair.reader}: the reader declares ${readerShape.length} parameter(s), so the record cannot be placed in the only slot it accepts`);
        continue;
      }
      candidates.push({ ...pair, arguments: args });
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
  const probed = await probePairs(snapshotRoot, planned, probeTimeoutMs);
  const results = [];
  for (const pair of planned) {
    const found = probed.results.find(entry => entry.file === pair.file && entry.writer === pair.writer && entry.reader === pair.reader);
    results.push({
      file: pair.file,
      writer: pair.writer,
      reader: pair.reader,
      arguments: pair.arguments,
      outcome: found?.outcome ?? 'not-probed',
      error: found?.error ?? probed.failure ?? 'the probe produced no answer for this pair',
      record: found?.record ?? null,
    });
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
