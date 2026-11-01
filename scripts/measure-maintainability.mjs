// Reproduces the measurement table of the maintainability specification: JS/TS parsing through
// `@babel/parser`, Python parsing through the standard-library `ast`, and the naive all-subsets
// grouping that motivates the maximal-group rule. Read-only: it writes nothing.
//
// Usage: node scripts/measure-maintainability.mjs [--tree <path>] [--runs <n>]

import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { extractSignatures, collectExecutableFiles } from '../src/native/maintainability/extract.mjs';
import { groupClumps } from '../src/native/maintainability/group.mjs';
import { resolveConfig } from '../src/native/maintainability/config.mjs';
import { classifyFilePath } from '../src/domain/file-class.mjs';
import { spawnSync } from 'node:child_process';

/**
 * @param {{ tree?: string, runs?: number, classify?: (filePath: string) => string }} [options]
 * @returns {Promise<object>}
 */
export async function measure({ tree = process.cwd(), runs = 3, classify = classifyFilePath } = {}) {
  const config = resolveConfig({ maxScanMs: 600000, maxScanFiles: 100000 });
  const collected = trackedFiles(tree, classify) ?? await collectExecutableFiles({ rootDir: tree, config, classify });
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const extracted = await extractSignatures({ rootDir: tree, paths: collected.paths, config });
    samples.push({
      elapsedMs: Math.round(performance.now() - started),
      filesRead: extracted.filesRead,
      filesFailed: extracted.unparsedFiles.length,
      signatures: extracted.signatures.length,
      byLanguage: Object.fromEntries(extracted.languages.map(entry => [entry.language, entry.filesParsed])),
    });
  }
  const extracted = await extractSignatures({ rootDir: tree, paths: collected.paths, config });
  const naive = naiveGroupCount(extracted.signatures);
  const grouped = groupClumps({
    signatures: extracted.signatures,
    classOf: classify,
    changedPaths: collected.paths,
    config,
    supportComplete: true,
  });
  return { tree, config, files: collected.paths.length, samples, naive, maximal: grouped.groups.length, excluded: grouped.excluded.length };
}

/**
 * The analyzer reads what a staged snapshot contains, and a snapshot holds tracked files only.
 * Measuring the working tree would count untracked scratch directories, so a Git tree is listed
 * through the index and anything else falls back to a walk.
 */
function trackedFiles(tree, classify) {
  const listed = spawnSync('git', ['-C', tree, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) return null;
  const paths = String(listed.stdout ?? '').split('\u0000').filter(Boolean).filter(file => classify(file) === 'executable');
  return { paths: paths.sort(), skipped: [] };
}

/** Every subset of size 2..4 of every signature, without the maximality rule. */
function naiveGroupCount(signatures) {
  const index = new Map();
  let signaturesWithGroup = 0;
  for (const signature of signatures) {
    const names = signature.params;
    if (names.length < 2) continue;
    signaturesWithGroup += 1;
    const upper = Math.min(4, names.length);
    for (let size = 2; size <= upper; size += 1) {
      for (const combination of combinations(names, size)) index.set(combination.join('\u0000'), (index.get(combination.join('\u0000')) ?? 0) + 1);
    }
  }
  let top = { params: [], count: 0 };
  for (const [key, count] of index) {
    if (count > top.count) top = { params: key.split('\u0000'), count };
  }
  return { signatures: signaturesWithGroup, groups: index.size, top };
}

function combinations(names, size) {
  const out = [];
  const pick = (start, current) => {
    if (current.length === size) {
      out.push([...current]);
      return;
    }
    for (let position = start; position < names.length; position += 1) {
      current.push(names[position]);
      pick(position + 1, current);
      current.pop();
    }
  };
  pick(0, []);
  return out;
}

function parseArgs(argv) {
  const options = { tree: process.cwd(), runs: 3 };
  for (let position = 0; position < argv.length; position += 1) {
    if (argv[position] === '--tree') options.tree = path.resolve(argv[position + 1]);
    if (argv[position] === '--runs') options.runs = Number.parseInt(argv[position + 1], 10);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await measure(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
