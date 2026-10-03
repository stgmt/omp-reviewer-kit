#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRunnerNewer } from '../src/domain/runner-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIPPED = [/^tp-/, /^omp-reviewer-kit-release$/];
const FILES = [
  { from: 'scripts/run-review.mjs', to: '.omp/review-kit/run-review.mjs' },
  { from: 'templates/githooks/pre-commit', to: '.githooks/pre-commit' },
];

export const isSkippedTarget = (repo) => SKIPPED.some((pattern) => pattern.test(path.basename(repo)));
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const exists = (file) => access(file).then(() => true, () => false);

export async function syncTarget(repo, { apply = false, source = root } = {}) {
  if (isSkippedTarget(repo)) return { repo, status: 'skipped', files: [] };
  if (!(await exists(path.join(repo, '.git')))) return { repo, status: 'not-a-repo', files: [] };
  const files = [];
  for (const { from, to } of FILES) {
    const wantBytes = await readFile(path.join(source, from));
    const want = sha256(wantBytes);
    const target = path.join(repo, to);
    const haveBytes = (await exists(target)) ? await readFile(target) : null;
    const have = haveBytes ? sha256(haveBytes) : null;
    // A vendored runner newer than the source is never rolled back.
    const newer = to.endsWith('run-review.mjs') && haveBytes !== null
      && isRunnerNewer(haveBytes.toString('utf8'), wantBytes.toString('utf8'));
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
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Array.isArray(config)) throw new Error(`${configPath} must contain a JSON array of repository paths`);
  return config.map((repo) => path.resolve(String(repo)));
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
