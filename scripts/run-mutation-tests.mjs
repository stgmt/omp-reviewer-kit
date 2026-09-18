import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MUTANTS = [
  {
    id: 'modular-verdict-multiple-markers',
    file: 'src/domain/review-verdict.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: 'if (effective.length === 1) {',
    replacement: 'if (matches.length >= 1) {',
    description: 'Accepts multiple conflicting verdict markers instead of requiring solitary marker',
  },
  {
    id: 'runner-verdict-multiple-markers',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: 'if (effective.length === 1) {',
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
    id: 'anti-parasitic-hunter-check-removed',
    file: 'agents/review-risk-hunter.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: '## Anti-Parasitic Correctness Gate',
    replacement: '## Correctness Notes',
    description: 'Removes the named anti-parasitic hunter contract',
  },
  {
    id: 'anti-parasitic-both-to-either',
    file: 'agents/review-risk-hunter.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: 'evidence proves both conditions',
    replacement: 'evidence proves either condition',
    description: 'Allows one unproven anti-parasitic condition to block',
  },
  {
    id: 'anti-parasitic-port-protection-removed',
    file: 'agents/review-risk-hunter.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: 'Do not flag a Port/Adapter or Template Method that adds a real capability',
    replacement: 'Flag a Port/Adapter or Template Method even when it adds a real capability',
    description: 'Removes false-positive protection for justified OOP patterns',
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
  {
    id: 'modular-snapshot-content',
    file: 'src/infra/filesystem-snapshot-adapter.mjs',
    testFile: 'tests/snapshot-adapter.test.mjs',
    original: '      await writeFile(destination, file.content);',
    replacement: '      await writeFile(destination, Buffer.alloc(0));',
    description: 'Snapshot materialization writes empty files instead of staged bytes',
  },
  {
    id: 'runner-snapshot-content',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/runner-snapshot.test.mjs',
    original: '      await writeFile(destination, file.content);',
    replacement: '      await writeFile(destination, Buffer.alloc(0));',
    description: 'Distributable runner snapshot loses staged file bytes',
  },
  {
    id: 'modular-dispatcher-lanes',
    file: 'src/domain/review-prompt.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: "      'The task must run both correctness and security risk lanes; the correctness lane must inspect focused tests and YAGNI only when a concrete reachable P1/P2 impact is proven.',",
    replacement: "      'The task must run only the correctness risk lane.',",
    description: 'Dispatcher omits the mandatory security lane and bounded correctness review guidance',
  },
  {
    id: 'runner-dispatcher-lanes',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/runner-snapshot.test.mjs',
    original: "      'The task must run both correctness and security risk lanes; the correctness lane must inspect focused tests and YAGNI only when a concrete reachable P1/P2 impact is proven.',",
    replacement: "      'The task must run only the correctness risk lane.',",
    description: 'Distributable runner omits the mandatory security lane',
  },
  {
    id: 'modular-report-verified-ok',
    file: 'src/domain/review-report.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: '    if (this.#verifiedOk.length > 0 && !/^### Verified-OK\\s*$/m.test(rawOutput)) {',
    replacement: '    if (false) {',
    description: 'Report drops the verified-OK section when the reviewer omits it',
  },
  {
    id: 'runner-report-verified-ok',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/runner-snapshot.test.mjs',
    original: '    if (this.#verifiedOk.length > 0 && !/^### Verified-OK\\s*$/m.test(rawOutput)) {',
    replacement: '    if (false) {',
    description: 'Distributable runner drops the verified-OK section',
  },
  {
    id: 'multi-stage-snapshot-boundary-removed',
    file: 'skills/multi-stage-review/SKILL.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: 'absolute staged snapshot directory',
    replacement: 'absolute snapshot directory',
    description: 'Skill no longer names the staged snapshot boundary',
  },
  {
    id: 'multi-stage-yagni-boundary-removed',
    file: 'skills/multi-stage-review/SKILL.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: 'YAGNI',
    replacement: 'architecture',
    description: 'Skill loses the correctness-lane YAGNI boundary',
  },
  {
    id: 'modular-provider-outage-ux-dropped',
    file: 'src/infra/omp-cli-reviewer-adapter.mjs',
    testFile: 'tests/omp-cli-reviewer-adapter.test.mjs',
    original: '    if (providerOutage) {',
    replacement: '    if (false) {',
    description: 'Total provider outage returns raw stderr instead of the actionable infrastructure-failure message',
  },
  {
    id: 'runner-provider-outage-ux-dropped',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/telemetry.test.mjs',
    original: '    if (providerOutage) {',
    replacement: '    if (false) {',
    description: 'Distributable runner drops the actionable provider-outage message',
  },
  {
    id: 'modular-diff-artifact-empty',
    file: 'src/infra/filesystem-snapshot-adapter.mjs',
    testFile: 'tests/snapshot-adapter.test.mjs',
    original: "    await writeFile(path.join(reviewDir, 'diff.patch'), artifacts.diffBytes);",
    replacement: "    await writeFile(path.join(reviewDir, 'diff.patch'), Buffer.alloc(0));",
    description: 'Snapshot .review/diff.patch loses the staged diff bytes',
  },
  {
    id: 'runner-diff-artifact-empty',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/runner-snapshot.test.mjs',
    original: "    await writeFile(path.join(reviewDir, 'diff.patch'), artifacts.diffBytes);",
    replacement: "    await writeFile(path.join(reviewDir, 'diff.patch'), Buffer.alloc(0));",
    description: 'Distributable runner writes an empty .review/diff.patch',
  },
  {
    id: 'modular-effort-override-dropped',
    file: 'src/infra/omp-cli-reviewer-adapter.mjs',
    testFile: 'tests/omp-cli-reviewer-adapter.test.mjs',
    original: "  return REVIEW_THINKING_LEVELS.has(raw) ? raw : null;",
    replacement: '  return null;',
    description: 'OMP_REVIEW_KIT_EFFORT no longer maps to --thinking',
  },
  {
    id: 'runner-role-selector-accepts-all',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/runner-snapshot.test.mjs',
    original: "  return typeof value === 'string' && /^@[A-Za-z0-9_-]+$/.test(value);",
    replacement: '  return false;',
    description: 'Distributable runner rejects every role selector, breaking model resolution',
  },
  {
    id: 'sanitizer-identity',
    file: 'src/infra/omp-cli-reviewer-adapter.mjs',
    testFile: 'tests/omp-cli-reviewer-adapter.test.mjs',
    original: '.filter((line) => !/^\\s*Working\\.\\.\\.\\s*$/i.test(line))',
    replacement: '.filter(() => true)',
    description: 'Sanitizer becomes identity, leaving OMP progress noise in reviewer output',
  },
  {
    id: 'reemit-call-deleted',
    file: 'src/application/review-workflow-service.mjs',
    testFile: 'tests/reemit-verbatim.test.mjs',
    original: 'const reemitResult = await this.#reviewerPort.reemitVerbatim({',
    replacement: 'const reemitResult = null; if (false) await this.#reviewerPort.reemitVerbatim({',
    description: 'Deletes verbatim re-emit recovery call on missing verdict marker',
  },
  {
    id: 'reemit-looped-more-than-once',
    file: 'src/application/review-workflow-service.mjs',
    testFile: 'tests/reemit-verbatim.test.mjs',
    original: "      if (\n        verdict.reason === 'missing_verdict_marker'",
    replacement: "      for (let _loop = 0; _loop < 2; _loop++) if (\n        verdict.reason === 'missing_verdict_marker'",
    description: 'Allows re-emit to loop more than once instead of exactly once',
  },
  {
    id: 'reemit-reevaluation-marker-only',
    file: 'src/application/review-workflow-service.mjs',
    testFile: 'tests/reemit-verbatim.test.mjs',
    original: '          const reevaluated = ReviewRejectionEnvelope.evaluate({',
    replacement: '          const reevaluated = { verdict: ReviewVerdict.fromOutput(reemittedOutput), envelope: null }; if (false) ReviewRejectionEnvelope.evaluate({',
    description: 'Re-evaluates re-emitted output for marker only without full rejection envelope',
  },
  {
    id: 'reemit-timeout-not-passed',
    file: 'src/infra/omp-cli-reviewer-adapter.mjs',
    testFile: 'tests/reemit-verbatim.test.mjs',
    original: '      const result = await this.#runner(promptText, cwd, timeout, model, {',
    replacement: '      const result = await this.#runner(promptText, cwd, undefined, model, {',
    description: 'Does not pass probe-timeout budget to re-emit runner',
  },
  {
    id: 'signal-handler-noop',
    file: 'src/infra/run-signal-guard.mjs',
    testFile: 'tests/run-signal-guard.test.mjs',
    original: '  return async function handler(signal) {\n    const error = `interrupted by signal ${signal}`;',
    replacement: '  return async function handler(signal) {\n    return;\n    const error = `interrupted by signal ${signal}`;',
    description: 'Interruption signal handler becomes a no-op',
  },
  {
    id: 'stale-check-inverted',
    file: 'src/application/installer-service.mjs',
    testFile: 'tests/run-signal-guard.test.mjs',
    original: "      if (liveness === 'dead') {",
    replacement: "      if (liveness !== 'dead') {",
    description: 'Inverts process dead check during last-run liveness reconciliation',
  },
  {
    id: 'prompt-verdict-contract-sentences-deleted',
    file: 'src/domain/review-prompt.mjs',
    testFile: 'tests/bdd-scenarios.test.mjs',
    original: "      'Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.',",
    replacement: '      // prompt sentence deleted',
    description: 'Omits explicit verdict contract sentences from dispatcher prompt',
  },
  {
    id: 'reemit-on-nonzero-status',
    file: 'src/application/review-workflow-service.mjs',
    testFile: 'tests/reemit-verbatim.test.mjs',
    original: "        verdict.reason === 'missing_verdict_marker'\n        && execResult.status === 0",
    replacement: "        (verdict.reason === 'missing_verdict_marker' || execResult.status !== 0)",
    description: 'Attempts re-emit even when reviewer process exited with non-zero status',
  },
  {
    id: 'reemit-on-empty-output',
    file: 'src/application/review-workflow-service.mjs',
    testFile: 'tests/reemit-verbatim.test.mjs',
    original: "&& combinedOutput.trim() !== ''",
    replacement: '&& true',
    description: 'Attempts re-emit even when reviewer process produced empty output',
  },
  {
    id: 'anti-neuroslop-section-removed',
    file: 'skills/reality-first-review/SKILL.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: '### The red question',
    replacement: '### Notes on assertions',
    description: 'Removes the red question from reality-first-review skill',
  },
  {
    id: 'hunter-red-proof-field-removed',
    file: 'agents/review-risk-hunter.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: '"red_proof": "Concrete tree breakage that would make this check fail; empty string means the check cannot fail",',
    replacement: '// red_proof field removed',
    description: 'Removes red_proof field from risk hunter schema',
  },
  {
    id: 'verifier-triage-field-removed',
    file: 'agents/review-finding-verifier.md',
    testFile: 'tests/plugin-layout.test.mjs',
    original: '"triage": "lie | stale_record | disclosed_gap | not_applicable",',
    replacement: '// triage field removed',
    description: 'Removes triage field from verifier decisions schema',
  },
  {
    id: 'modular-suspicion-assert-delta',
    file: 'src/domain/suspicion-map.mjs',
    testFile: 'tests/suspicion-map.test.mjs',
    original: 'const net = addedAsserts - removedAsserts;',
    replacement: 'const net = removedAsserts - addedAsserts;',
    description: 'Inverts net assert delta calculation in domain suspicion map',
  },
  {
    id: 'runner-suspicion-assert-delta',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: 'const net = addedAsserts - removedAsserts;',
    replacement: 'const net = removedAsserts - addedAsserts;',
    description: 'Inverts net assert delta calculation in distributable runner suspicion map',
  },
  {
    id: 'modular-execution-fail-open',
    file: 'src/application/review-workflow-service.mjs',
    testFile: 'tests/execution-evidence.test.mjs',
    original: `          } catch (err) {
            executionEvidence = new ExecutionEvidence({
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
              staged: { ok: false, error: err.message },
              reverted: null,
            });
          }`,
    replacement: `          } catch (err) {
            throw err;
          }`,
    description: 'Replaces fail-open execution catch with throw in modular service',
  },
  {
    id: 'runner-execution-fail-open',
    file: 'scripts/run-review.mjs',
    testFile: 'tests/run-review.test.mjs',
    original: `          } catch (err) {
            executionEvidence = new ExecutionEvidence({
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
              staged: { ok: false, error: err.message },
              reverted: null,
            });
          }`,
    replacement: `          } catch (err) {
            throw err;
          }`,
    description: 'Replaces fail-open execution catch with throw in runner service',
  },
  {
    id: 'reverted-snapshot-keeps-staged',
    file: 'src/domain/reverted-snapshot.mjs',
    testFile: 'tests/reverted-snapshot.test.mjs',
    original: 'if (!changedSet.has(file.path) || isTestPath(file.path, testPathPatterns)) {',
    replacement: 'if (!changedSet.has(file.path) || true) {',
    description: 'Reverted snapshot builder keeps staged content for all files',
  },
  {
    id: 'audit-range-deleted-test-detection',
    file: 'scripts/audit-range.mjs',
    testFile: 'tests/audit-range.test.mjs',
    original: 'deletedFilesSet.add(entry.path);',
    replacement: '// deleted file ignored',
    description: 'Audit range ignores deleted test files in aggregate flags',
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
        timeout: 15_000,
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
