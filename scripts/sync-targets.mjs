#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHookNewer } from '../src/domain/hook-template.mjs';
import { isRunnerNewer } from '../src/domain/runner-version.mjs';
import { isSkippedTarget } from '../src/domain/target-policy.mjs';
import { FileTargetRegistry } from '../src/infra/target-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The vendored runner is the thin stub; its release marker (for the no-downgrade rule) lives in the plugin's algorithm.
// Each file is judged newer by its own marker: the runner by the algorithm's, the hook by its template's.
const FILES = [
  { from: 'templates/review-kit/run-review.mjs', to: '.omp/review-kit/run-review.mjs', releaseFrom: 'scripts/run-review.mjs', isNewer: isRunnerNewer },
  { from: 'templates/githooks/pre-commit', to: '.githooks/pre-commit', isNewer: isHookNewer },
];

export { isSkippedTarget };
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const exists = (file) => access(file).then(() => true, () => false);

export async function syncTarget(repo, { apply = false, source = root } = {}) {
  if (isSkippedTarget(repo)) return { repo, status: 'skipped', files: [] };
  if (!(await exists(path.join(repo, '.git')))) return { repo, status: 'not-a-repo', files: [] };
  const files = [];
  for (const { from, to, releaseFrom, isNewer } of FILES) {
    const wantBytes = await readFile(path.join(source, from));
    const want = sha256(wantBytes);
    const target = path.join(repo, to);
    const haveBytes = (await exists(target)) ? await readFile(target) : null;
    const have = haveBytes ? sha256(haveBytes) : null;
    // A vendored runner or hook newer than the source's release is never rolled back.
    const releaseBytes = releaseFrom ? await readFile(path.join(source, releaseFrom)) : wantBytes;
    const newer = haveBytes !== null && isNewer(haveBytes.toString('utf8'), releaseBytes.toString('utf8'));
    let state = have === want ? 'ok' : newer ? 'newer' : have === null ? 'missing' : 'stale';
    if (apply && state !== 'ok' && state !== 'newer') {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, from), target);
      if (to === '.githooks/pre-commit') await chmod(target, 0o755);
      state = 'updated';
    }
    files.push({ file: to, want: want.slice(0, 16), have: have ? have.slice(0, 16) : null, state });
  }
  return { repo, status: files.every((f) => f.state === 'ok' || f.state === 'updated' || f.state === 'newer') ? 'synced' : 'drift', files };
}

export async function loadTargets(argv, configPath) {
  const explicit = argv.filter((arg) => !arg.startsWith('--'));
  if (explicit.length) return explicit.map((repo) => path.resolve(repo));
  const config = await readFile(configPath, 'utf8').then(JSON.parse, (error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!Array.isArray(config)) throw new Error(`${configPath} must contain a JSON array of repository paths`);
  // the owner's file plus the repositories sessions registered next to it
  return new FileTargetRegistry({ filePath: configPath, ignoreTemp: false }).list();
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const configPath = process.env.OMP_REVIEW_KIT_TARGETS || path.join(os.homedir(), '.omp', 'review-kit-targets.json');
  const targets = await loadTargets(argv, configPath);
  let drift = 0;
  for (const repo of targets) {
    const result = await syncTarget(repo, { apply });
    if (result.status === 'drift' || result.status === 'not-a-repo') drift += 1;
    const detail = result.files.map((f) => `${path.basename(f.file)}:${f.state}(${f.have ?? '-'}→${f.want})`).join(' ');
    console.log(`${result.status.padEnd(10)} ${repo} ${detail}`);
  }
  if (!apply && drift) console.log('\nRun with --apply to copy files, then commit each repository through its own review hook.');
  process.exitCode = drift ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
