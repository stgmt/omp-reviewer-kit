// Generates every host manifest from `package.json`, and compares them back.
//
//   node scripts/sync-host-manifests.mjs            # dry run: report what would change
//   node scripts/sync-host-manifests.mjs --apply    # write the files
//   node scripts/sync-host-manifests.mjs --check    # exit 1 when a generated file is stale
//
// The release preflight and `npm run check` call `--check`, so a version bump that forgot a manifest
// fails before a review runs, not after a release ships.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule } from '../src/infra/main-module.mjs';
import { generatedHostFiles } from '../src/domain/host-manifests.mjs';

/**
 * Compares the generated files with what is on disk.
 *
 * @param {{ root?: string, version: string, readFileImpl?: Function }} input
 * @returns {Promise<Array<{ path: string, status: 'current'|'stale'|'missing', expected: string }>>}
 */
export async function checkHostManifests({ root = process.cwd(), version, readFileImpl = readFile }) {
  const files = generatedHostFiles({ version });
  const rows = [];
  for (const file of files) {
    let actual = null;
    try {
      actual = await readFileImpl(path.join(root, file.path), 'utf8');
    } catch {
      actual = null;
    }
    const normalized = actual === null ? null : actual.replace(/\r\n/g, '\n');
    rows.push({
      path: file.path,
      status: normalized === null ? 'missing' : normalized === file.content ? 'current' : 'stale',
      expected: file.content,
    });
  }
  return rows;
}

/**
 * Writes every stale or missing file.
 *
 * @param {{ root?: string, version: string, writeFileImpl?: Function, readFileImpl?: Function }} input
 * @returns {Promise<string[]>} the paths written
 */
export async function applyHostManifests({ root = process.cwd(), version, writeFileImpl = writeFile, readFileImpl = readFile }) {
  const rows = await checkHostManifests({ root, version, readFileImpl });
  const written = [];
  for (const row of rows) {
    if (row.status === 'current') continue;
    const target = path.join(root, row.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileImpl(target, row.expected, 'utf8');
    written.push(row.path);
  }
  return written;
}

/**
 * Throws when a generated manifest disagrees with the release version. Exported so the layout gate and
 * its test share one decision instead of copying the comparison.
 *
 * @param {Array<{ path: string, status: string }>} rows
 * @param {string} version
 */
export function assertHostManifestsCurrent(rows, version) {
  const stale = (Array.isArray(rows) ? rows : []).filter(row => row.status !== 'current');
  if (stale.length === 0) return;
  throw new Error(`host manifests disagree with package.json ${version}: ${stale.map(row => row.path).join(', ')}; run node scripts/sync-host-manifests.mjs --apply`);
}

async function main(argv) {
  const root = process.cwd();
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const apply = argv.includes('--apply');
  const check = argv.includes('--check');
  const rows = await checkHostManifests({ root, version: pkg.version });
  const stale = rows.filter(row => row.status !== 'current');
  if (apply) {
    const written = await applyHostManifests({ root, version: pkg.version });
    process.stdout.write(written.length === 0 ? 'host manifests: current\n' : `host manifests: wrote ${written.join(', ')}\n`);
    return 0;
  }
  for (const row of rows) process.stdout.write(`${row.status.padEnd(8)} ${row.path}\n`);
  if (check && stale.length > 0) {
    process.stderr.write(`host manifests: ${stale.length} file(s) disagree with package.json ${pkg.version}; run node scripts/sync-host-manifests.mjs --apply\n`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
