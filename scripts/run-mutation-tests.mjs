import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MUTANTS = [
  {
    id: 'modular-verdict-multiple-markers',
    file: 'src/domain/review-verdict.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: 'if (matches.length === 1) {',
    replacement: 'if (matches.length >= 1) {',
    description: 'Accepts multiple conflicting verdict markers instead of requiring solitary marker',
  },
  {
    id: 'runner-verdict-multiple-markers',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: 'if (matches.length === 1) {',
    replacement: 'if (matches.length >= 1) {',
    description: 'Distributable runner accepts multiple verdict markers',
  },
  {
    id: 'modular-workflow-process-status',
    file: 'src/domain/review-rejection-envelope.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: 'if (processStatus !== 0) {',
    replacement: 'if (false) {',
    description: 'Reviewer process failure no longer forces a normalized BLOCK',
  },
  {
    id: 'runner-workflow-process-status',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: 'if (processStatus !== 0) {',
    replacement: 'if (false) {',
    description: 'Distributable runner ignores reviewer process failure',
  },
  {
    id: 'modular-staged-isolation',
    file: 'src/infra/subprocess-git-adapter.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: "['diff', '--cached', '--binary', '--no-ext-diff', '--']",
    replacement: "['diff', '--binary', '--no-ext-diff', '--']",
    description: 'Removes --cached flag, leaking unstaged changes into diff inspection',
  },
  {
    id: 'runner-staged-isolation',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: "['diff', '--cached', '--binary', '--no-ext-diff', '--']",
    replacement: "['diff', '--binary', '--no-ext-diff', '--']",
    description: 'Distributable runner removes --cached flag from diff inspection',
  },
  {
    id: 'modular-report-overwrite',
    file: 'src/domain/review-report.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: 'return `${stamp}-${this.#diffHash}.md`;',
    replacement: 'return `${this.#diffHash}.md`;',
    description: 'Removes timestamp prefix, breaking report uniqueness and overwriting audits',
  },
  {
    id: 'runner-report-overwrite',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: 'return `${stamp}-${this.#diffHash}.md`;',
    replacement: 'return `${this.#diffHash}.md`;',
    description: 'Distributable runner removes timestamp prefix from report filenames',
  },
  {
    id: 'modular-dispatcher-protocol',
    file: 'src/domain/review-prompt.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original:
      "'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',",
    replacement:
      "'The task must read skill://reality-first-review and then only relevant project review skills discovered by OMP.',",
    description: 'Removes multi-stage-review protocol requirement from dispatcher prompt',
  },
  {
    id: 'runner-dispatcher-protocol',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original:
      "'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',",
    replacement:
      "'The task must read skill://reality-first-review and then only relevant project review skills discovered by OMP.',",
    description: 'Distributable runner prompt omits mandatory multi-stage-review protocol clause',
  },
  {
    id: 'envelope-unsupported-class-modular',
    file: 'src/domain/review-rejection-envelope.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: "finding.defect_class !== 'correctness' && finding.defect_class !== 'security'",
    replacement: "finding.defect_class !== 'correctness' && finding.defect_class !== 'security' && finding.defect_class !== 'maintainability'",
    description: 'Allows an unsupported defect class outside the stable schema',
  },
  {
    id: 'envelope-unsupported-class-runner',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: "finding.defect_class !== 'correctness' && finding.defect_class !== 'security'",
    replacement: "finding.defect_class !== 'correctness' && finding.defect_class !== 'security' && finding.defect_class !== 'maintainability'",
    description: 'Distributable runner accepts an unsupported defect class',
  },
];

const DIRECTORIES_TO_COPY = ['src', 'scripts', 'agents', 'skills', 'tests', 'templates', '.omp-plugin'];
const FILES_TO_COPY = ['package.json', 'README.md', 'AGENTS.md', 'ROADMAP.md', 'CHANGELOG.md'];

async function copyRepoTree(targetDir) {
  for (const dir of DIRECTORIES_TO_COPY) {
    await cp(dir, path.join(targetDir, dir), { recursive: true });
  }
  for (const file of FILES_TO_COPY) {
    await cp(file, path.join(targetDir, file));
  }
}

async function runMutationGate() {
  console.log(`Starting safety mutation gate: ${MUTANTS.length} curated mutants...`);
  let killedCount = 0;
  let survivedCount = 0;

  for (const mutant of MUTANTS) {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'omp-mutant-'));
    try {
      await copyRepoTree(tempDir);

      const targetPath = path.join(tempDir, mutant.file);
      const originalContent = await readFile(targetPath, 'utf8');

      // Guarded single replacement
      const occurrences = originalContent.split(mutant.original).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Mutation target guard failed for [${mutant.id}]: expected 1 occurrence of original string in ${mutant.file}, found ${occurrences}`
        );
      }

      const mutatedContent = originalContent.replace(mutant.original, mutant.replacement);
      await writeFile(targetPath, mutatedContent, 'utf8');

      // Run owning test suite in isolated directory
      const testResult = spawnSync('node', ['--test', mutant.testFile], {
        cwd: tempDir,
        encoding: 'utf8',
        windowsHide: true,
      });

      if (testResult.status !== 0) {
        killedCount++;
        console.log(`  ✔ [KILLED]   ${mutant.id} (${mutant.description})`);
      } else {
        survivedCount++;
        console.error(`  ✖ [SURVIVED] ${mutant.id} (${mutant.description})`);
        console.error(`    Test output:\n${testResult.stdout}\n${testResult.stderr}`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const total = MUTANTS.length;
  const killRate = ((killedCount / total) * 100).toFixed(1);
  console.log(`\nMutation gate result: ${killedCount}/${total} killed (${killRate}%).`);

  if (survivedCount > 0) {
    console.error(`Mutation gate FAILED: ${survivedCount} mutants survived.`);
    process.exit(1);
  }

  console.log('Mutation gate PASSED: 100% of curated safety mutants killed.');
}

runMutationGate().catch((err) => {
  console.error('Fatal mutation gate error:', err);
  process.exit(1);
});
