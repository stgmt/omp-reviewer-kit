// Reproduces the reuse-hint measurement table: detection on a synthetic corpus of copies, the
// candidates the scan produces on this repository, and the cost of a cold and a warm scan.
//
//   node scripts/measure-reuse-index.mjs [--repo <path>] [--json]
//
// The synthetic corpus is generated, not committed: each case is one known copy and the scan either
// finds it or does not. The repository measurement reports what the reviewer would be told, so the
// list can be read and judged by a person instead of a threshold.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveReuseConfig } from '../src/native/reuse/config.mjs';
import { findReuseCandidates } from '../src/native/reuse/index.mjs';
import { createFileCache, scanUnits } from '../src/native/reuse/scan.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

const ORIGINAL = `export function computeChargeTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}`;

const CASES = [
  {
    name: 'renamed copy',
    copy: `export function sumOrderAmount(rows, vat) {
  let accrued = 0;
  for (const row of rows) {
    accrued += row.cost * row.count;
  }
  const fee = accrued * vat;
  return Math.round((accrued + fee) * 100) / 100;
}`,
  },
  {
    name: 'reformatted copy',
    copy: `export function computeChargeTotal(items, taxRate) {
    let total = 0;
    for (const item of items) { total += item.price * item.quantity; }
    const tax = total * taxRate;
    return Math.round((total + tax) * 100) / 100;
}`,
  },
  {
    name: 'copy with renamed inner helper',
    copy: `export function totalOf(basket, rate) {
  let sum = 0;
  for (const line of basket) {
    sum += line.price * line.quantity;
  }
  const vat = sum * rate;
  return Math.round((sum + vat) * 100) / 100;
}`,
  },
  {
    name: 'unrelated function of the same length',
    copy: `export function formatInvoiceLabel(customer, issuedAt) {
  const day = issuedAt.slice(0, 10);
  const trimmed = customer.trim();
  const label = \`\${trimmed} / \${day}\`;
  return label.toUpperCase();
}`,
    expectFound: false,
  },
];

async function syntheticCorpus() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reuse-measure-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/original.mjs'), ORIGINAL, 'utf8');
  const rows = [];
  const config = resolveReuseConfig({});
  for (const testCase of CASES) {
    const copyPath = `src/copy-${rows.length}.mjs`;
    await writeFile(path.join(root, copyPath), testCase.copy, 'utf8');
    const scan = await scanUnits({ snapshotDir: root, config, cache: null });
    const { candidates } = findReuseCandidates({ units: scan.units, changedPaths: [copyPath], config });
    const found = candidates.some(candidate => candidate.existingPath === 'src/original.mjs');
    rows.push({ case: testCase.name, expected: testCase.expectFound === false ? 'no match' : 'match', found: found ? 'match' : 'no match', similarity: candidates[0]?.similarity ?? null });
    await rm(path.join(root, copyPath), REMOVE);
  }
  await rm(root, REMOVE);
  return rows;
}

async function repositoryMeasurement(repo) {
  const config = resolveReuseConfig({ maxFiles: 4000, maxScanMs: 60000, maxUnits: 20000 });
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'reuse-measure-cache-'));
  try {
    const coldStart = Date.now();
    const cold = await scanUnits({ snapshotDir: repo, config, cache: createFileCache({ dir: cacheDir }) });
    const coldMs = Date.now() - coldStart;
    const warmStart = Date.now();
    const warm = await scanUnits({ snapshotDir: repo, config, cache: createFileCache({ dir: cacheDir }) });
    const warmMs = Date.now() - warmStart;
    const changed = [...new Set(cold.units.map(unit => unit.path))].slice(0, 400);
    const { candidates, considered } = findReuseCandidates({ units: cold.units, changedPaths: changed, config: resolveReuseConfig({ maxCandidates: 40 }) });
    return {
      files: cold.filesScanned,
      units: cold.units.length,
      considered,
      truncated: cold.truncated,
      coldMs,
      warmMs,
      cacheHits: warm.cacheHits,
      candidates: candidates.map(candidate => ({
        changed: `${candidate.changedPath}:${candidate.changedLine}`,
        existing: `${candidate.existingPath}:${candidate.existingLine}`,
        similarity: candidate.similarity,
        sharedCalls: candidate.sharedCalls,
      })),
    };
  } finally {
    await rm(cacheDir, REMOVE);
  }
}

const args = process.argv.slice(2);
const repoIndex = args.indexOf('--repo');
const repo = repoIndex >= 0 ? String(args[repoIndex + 1] ?? '') : process.cwd();
const asJson = args.includes('--json');

// A measurement command that answers with zero files for a path typo is worse than one that fails:
// the numbers look like a real result. The target must be a readable directory before anything runs.
if (repoIndex >= 0 && repo.trim() === '') {
  process.stderr.write('measure-reuse-index: --repo needs a directory\n');
  process.exit(2);
}
try {
  const info = await stat(repo);
  if (!info.isDirectory()) throw new Error('not a directory');
  await readdir(repo);
} catch (error) {
  process.stderr.write(`measure-reuse-index: cannot read ${repo} (${error instanceof Error ? error.message : String(error)})\n`);
  process.exit(2);
}

const synthetic = await syntheticCorpus();
const measured = await repositoryMeasurement(repo);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ synthetic, repository: measured }, null, 2)}\n`);
} else {
  process.stdout.write('## Synthetic corpus\n\n| Case | Expected | Found | Shape score |\n|---|---|---|---|\n');
  for (const row of synthetic) process.stdout.write(`| ${row.case} | ${row.expected} | ${row.found} | ${row.similarity ?? '—'} |\n`);
  process.stdout.write(`\n## Repository ${repo}\n\n`);
  process.stdout.write(`- files scanned: ${measured.files}, units: ${measured.units}, truncated: ${measured.truncated}\n`);
  process.stdout.write(`- cold scan: ${measured.coldMs} ms, warm scan: ${measured.warmMs} ms, cache hits: ${measured.cacheHits}\n`);
  process.stdout.write(`- candidate pairs: ${measured.candidates.length} (considered ${measured.considered} units)\n`);
  for (const candidate of measured.candidates) {
    process.stdout.write(`  - ${candidate.changed} ~ ${candidate.existing} — ${candidate.similarity} [${candidate.sharedCalls.join(', ')}]\n`);
  }
}
