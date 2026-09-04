import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RESULT_LINE_RE = /^REVIEW_RESULT=(PASS|BLOCK)$/gm;

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: null, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr ?? Buffer.from('git command failed')).toString().trim());
  }
  return result.stdout ?? Buffer.alloc(0);
}

function runOmp(prompt, cwd) {
  const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
  const commandArgs = ['-p', '--model', '@slow', '--no-session'];
  const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
  const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const args = isWindowsWrapper
    ? ['/d', '/c', 'call', command, ...commandArgs]
    : commandArgs;
  const result = spawnSync(
    executable,
    args,
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      input: prompt,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return {
    status: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout ?? '',
    stderr: result.error ? `${result.error}\n${result.stderr ?? ''}` : (result.stderr ?? ''),
  };
}

function lastResult(output) {
  const matches = [...output.matchAll(RESULT_LINE_RE)];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function buildPrompt(diffHash) {
  return [
    'You are the OMP headless review dispatcher.',
    'Run exactly one native task with agent "reviewer-kit".',
    'Do not review the change yourself and do not run any other agent.',
    'The task must inspect only the current staged Git change.',
    'The task must read skill://reality-first-review and then only relevant project review skills discovered by OMP.',
    'The task must not edit, stage, reset, commit, or delete anything.',
    'The task must return its complete report and finish with exactly REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK.',
    `The staged diff hash for this hook invocation is ${diffHash}.`,
  ].join('\n');
}

export async function runReview({
  cwd = process.cwd(),
  git = runGit,
  omp = runOmp,
  now = new Date(),
} = {}) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).toString().trim();
  const diff = git(['diff', '--cached', '--binary', '--no-ext-diff', '--'], root);
  if (diff.length === 0) return { exitCode: 0, skipped: true };

  const diffHash = createHash('sha256').update(diff).digest('hex');
  const reportDir = path.join(root, 'audit-reports', 'commit-reviews');
  await mkdir(reportDir, { recursive: true });

  const result = omp(buildPrompt(diffHash), root);
  const combined = `${result.stdout}\n${result.stderr}`;
  const verdict = result.status === 0 ? lastResult(combined) : undefined;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `${stamp}-${diffHash}.md`);
  const report = [
    '# OMP Review Kit commit review',
    '',
    `- staged diff hash: ${diffHash}`,
    `- result: ${verdict ?? 'BLOCK'}`,
    '',
    combined.trim(),
    '',
  ].join('\n');
  await writeFile(reportPath, report, 'utf8');

  if (result.status === 0 && verdict === 'PASS') {
    process.stdout.write(`reviewer-kit PASS: ${reportPath}\n`);
    return { exitCode: 0, skipped: false, verdict, reportPath };
  }

  process.stderr.write(`reviewer-kit BLOCK: ${reportPath}\n`);
  if (combined.trim()) process.stderr.write(`${combined.trim()}\n`);
  return { exitCode: 1, skipped: false, verdict: 'BLOCK', reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runReview();
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`reviewer-kit BLOCK: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
