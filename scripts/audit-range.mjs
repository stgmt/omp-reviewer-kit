#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SuspicionMap } from '../src/domain/suspicion-map.mjs';

function git(args, cwd = process.cwd()) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function usage(message) {
  if (message) {
    process.stderr.write(`Error: ${message}\n\n`);
  }
  process.stderr.write('Usage: node scripts/audit-range.mjs <base>..<head> [--json] [--out <path>] [--llm]\n');
  process.exit(2);
}

function validateRange(range, cwd) {
  if (!range || !range.includes('..')) {
    usage(`Invalid range format "${range}". Expected <base>..<head>.`);
  }

  const [base, head] = range.split('..');
  if (!base || !head) {
    usage(`Invalid range format "${range}". Expected non-empty base and head.`);
  }

  const baseCheck = git(['rev-parse', '--verify', base], cwd);
  if (baseCheck.status !== 0) {
    usage(`Invalid git revision range: base "${base}" cannot be resolved.`);
  }

  const headCheck = git(['rev-parse', '--verify', head], cwd);
  if (headCheck.status !== 0) {
    usage(`Invalid git revision range: head "${head}" cannot be resolved.`);
  }

  return { base, head };
}

export function buildDeterministicReport(range, cwd = process.cwd()) {
  validateRange(range, cwd);

  const listRes = git(['rev-list', '--reverse', range], cwd);
  if (listRes.status !== 0) {
    usage(`Failed to resolve commit list for range ${range}: ${listRes.stderr}`);
  }

  const shas = listRes.stdout.trim().split(/\r?\n/).filter(Boolean);
  const commits = [];

  const netDeltasByFile = new Map();
  const deletedFilesSet = new Set();
  const removedDeclsSet = new Set();

  for (const sha of shas) {
    const showRes = git(['show', '--format=', '--patch', '--no-color', sha], cwd);
    const logRes = git(['log', '-1', '--format=%s', sha], cwd);
    const subject = logRes.stdout.trim();
    const patchText = showRes.stdout;

    const suspicionMap = SuspicionMap.compute({
      diffBytes: Buffer.from(patchText, 'utf8'),
    });

    const entries = suspicionMap.entries;
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      entries,
    });

    for (const entry of entries) {
      if (entry.kind === 'assert_delta') {
        const prev = netDeltasByFile.get(entry.path) ?? 0;
        netDeltasByFile.set(entry.path, prev + entry.net);
      } else if (entry.kind === 'deleted_test_file') {
        deletedFilesSet.add(entry.path);
      } else if (entry.kind === 'removed_test_declarations') {
        removedDeclsSet.add(entry.path);
      }
    }
  }

  const negativeAssertDeltaFiles = [];
  for (const [filePath, net] of netDeltasByFile) {
    if (net < 0) {
      negativeAssertDeltaFiles.push(filePath);
    }
  }

  const aggregate = {
    negativeAssertDeltaFiles: [...negativeAssertDeltaFiles].sort(),
    deletedTestFiles: [...deletedFilesSet].sort(),
    removedDeclarationFiles: [...removedDeclsSet].sort(),
  };

  return { range, commits, aggregate };
}

export function formatMarkdownReport(report) {
  const lines = [
    `# Range audit: ${report.range}`,
    '',
    '## Per-commit suspicion map',
    '',
  ];

  for (const c of report.commits) {
    lines.push(`### ${c.shortSha} ${c.subject}`);
    if (c.entries.length === 0) {
      lines.push('- no suspicion entries');
    } else {
      for (const e of c.entries) {
        if (e.kind === 'assert_delta') {
          const netStr = e.net > 0 ? `+${e.net}` : `${e.net}`;
          lines.push(`- ${e.path}: assert lines +${e.added}/-${e.removed} (net ${netStr})`);
        } else if (e.kind === 'deleted_test_file') {
          lines.push(`- ${e.path}: deleted test file (${e.removed} removed lines)`);
        } else if (e.kind === 'removed_test_declarations') {
          lines.push(`- ${e.path}: ${e.removed} test declaration${e.removed === 1 ? '' : 's'} removed`);
        }
      }
    }
    lines.push('');
  }

  lines.push('## Aggregate flags', '');
  lines.push(`- Files with net negative assert delta: ${report.aggregate.negativeAssertDeltaFiles.length > 0 ? report.aggregate.negativeAssertDeltaFiles.join(', ') : 'none'}`);
  lines.push(`- Deleted test files: ${report.aggregate.deletedTestFiles.length > 0 ? report.aggregate.deletedTestFiles.join(', ') : 'none'}`);
  lines.push(`- Files with removed test declarations: ${report.aggregate.removedDeclarationFiles.length > 0 ? report.aggregate.removedDeclarationFiles.join(', ') : 'none'}`);
  lines.push('');

  return lines.join('\n');
}

async function runLlmAudit({ range, markdownReport, cwd }) {
  const reportsDir = path.join(cwd, 'audit-reports', 'range-audits');
  await mkdir(reportsDir, { recursive: true });
  const slug = range.replace(/[^a-zA-Z0-9._-]/g, '_');
  const reportPath = path.join(reportsDir, `${slug}-${Date.now()}.md`);
  await writeFile(reportPath, markdownReport, 'utf8');

  const ompBin = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
  const model = process.env.OMP_REVIEW_KIT_MODEL ?? '@slow';

  const prompt = [
    'You are the OMP headless range audit dispatcher.',
    'Run exactly one native task with agent "review-range-auditor".',
    `The task must audit the commit range ${range} using skill://range-audit and skill://reality-first-review.`,
    `The deterministic suspicion report is at ${reportPath}. Address every flagged commit and aggregate entry.`,
    'Never emit REVIEW_RESULT=... markers — range audits are diagnostic and not commit gates.',
  ].join('\n');

  return new Promise((resolve) => {
    const child = spawn(ompBin, ['-p', '--model', model, '--no-session'], {
      cwd,
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });

    child.on('error', (err) => {
      process.stderr.write(`Failed to launch OMP for range audit: ${err.message}\n`);
      resolve(1);
    });

    child.on('close', (code) => {
      resolve(code ?? 0);
    });

    child.stdin.end(prompt);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
  }

  const range = args.find((a) => !a.startsWith('-'));
  if (!range) {
    usage('No range specified.');
  }

  const isJson = args.includes('--json');
  const isLlm = args.includes('--llm');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

  const report = buildDeterministicReport(range, process.cwd());

  if (isJson) {
    const jsonText = JSON.stringify(report, null, 2);
    if (outPath) {
      await writeFile(outPath, jsonText, 'utf8');
    } else {
      process.stdout.write(jsonText + '\n');
    }
    return;
  }

  const markdownReport = formatMarkdownReport(report);

  if (outPath) {
    await writeFile(outPath, markdownReport, 'utf8');
  } else if (!isLlm) {
    process.stdout.write(markdownReport);
  }

  if (isLlm) {
    const exitCode = await runLlmAudit({ range, markdownReport, cwd: process.cwd() });
    process.exit(exitCode);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    process.exit(1);
  });
}
