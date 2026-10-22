#!/usr/bin/env bun
// Entry point of the native review. Run by the Node launcher (`scripts/run-review.mjs`) under Bun,
// because OMP's library runs on Bun. Usage: bun native-host.mjs <repository>
// Exit 0 only when the reviewer's single verdict marker is PASS; any other outcome exits 1.

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoReportsDir } from '../infra/filesystem-report-store-adapter.mjs';
import { runNativeReview } from './native-review.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { env = process.env, stderr = process.stderr, stdout = process.stdout, runReview = runNativeReview } = {}) {
  const repo = path.resolve(argv[0] ?? process.cwd());
  let lastProgress = '';
  const log = line => {
    if (line === lastProgress) return;
    lastProgress = line;
    stderr.write(`${line}\n`);
  };
  try {
    const result = await runReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env,
      onProgress: log,
    });
    if (!result.staged) {
      log('review: SKIPPED (no staged changes)');
      return 0;
    }

    const { verdict, provenance, stages } = result;
    log(`review: reviewer role=${provenance.role ?? 'none'} model=${provenance.model ?? 'none'}`);
    for (const stage of stages) {
      log(`review: stage ${stage.agent} role=${stage.role ?? 'none'} model=${stage.model ?? 'none'} exit=${stage.exitCode} structured=${stage.structuredStatus ?? 'none'}`);
    }
    const reportPath = await saveReport(repo, result, env);
    stdout.write(result.text ? `${result.text}\n` : '');
    log(verdict.pass ? 'review: PASS' : `review: BLOCK (${verdict.reasons.join('; ')})`);
    log(`review: report ${reportPath}`);
    return verdict.pass ? 0 : 1;
  } catch (error) {
    stderr.write(`review: BLOCK (host error: ${error instanceof Error ? error.message : String(error)})\n`);
    return 1;
  }
}

/**
 * The audit trail lives outside the repository, next to the reports of earlier releases.
 *
 * @param {string} repo
 * @param {Awaited<ReturnType<typeof runNativeReview>>} result
 * @param {NodeJS.ProcessEnv} env
 */
async function saveReport(repo, result, env) {
  const dir = repoReportsDir(repo, { env });
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${result.diffHash.slice(0, 12)}.md`);
  const lines = [
    `# reviewer-kit review: ${result.verdict.verdict}`,
    '',
    `- Diff SHA-256: ${result.diffHash}`,
    `- Profile: ${result.profile}; lanes: ${result.lanes.join(', ')}`,
    `- Reviewer role/model (OMP resolved): ${result.provenance.role ?? 'none'} / ${result.provenance.model ?? 'none'}`,
    `- Staged paths: ${result.changedPaths.length}`,
    '',
    '## Stage evidence',
    '',
    ...result.stages.map(stage => `- ${stage.agent}: role ${stage.role ?? 'none'}, model ${stage.model ?? 'none'}, exit ${stage.exitCode}, structured ${stage.structuredStatus ?? 'none'}${stage.aborted ? ', aborted' : ''}`),
    '',
    '## Verdict reasons',
    '',
    ...(result.verdict.reasons.length > 0 ? result.verdict.reasons.map(reason => `- ${reason}`) : ['- none']),
    '',
    '## Reviewer report',
    '',
    result.text,
    '',
  ];
  await writeFile(file, lines.join('\n'), 'utf8');
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
