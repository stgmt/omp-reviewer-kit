import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const verifiedFinding = { candidate_id: 'c1', lane: 'correctness', priority: 'P2', title: 'Wrong calculation', file_path: 'src/a.mjs', line_start: 1, line_end: 1, observed_behavior: 'Returns zero', expected_behavior: 'Returns the sum', trigger_scenario: 'add(1, 2) returns 0 instead of 3', impact: 'Caller receives a wrong total', evidence: ['src/a.mjs:1'] };
const verifiedData = { coverage_summary: 'Inspected changed calculation and caller', decisions: [{ candidate_id: 'c1', disposition: 'confirmed', triage: 'not_applicable', reason: 'Reachable wrong total', evidence: 'src/a.mjs:1' }], confirmed_findings: [verifiedFinding], confirmed_coverage_gaps: [], rejected_coverage_gaps: [] };

for (const [label, modulePath] of [['source', '../src/index.mjs'], ['bundle', '../scripts/run-review.mjs']]) {
  test(`${label}: Given an unverified runner repair flag, When ordinary output has conflicting stderr, Then do not quote away the conflict`, async () => {
    const module = await import(modulePath);
    const adapter = new module.OmpCliReviewerAdapter({ runner: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: 'REVIEW_RESULT=BLOCK\n', verifiedBlockRepair: true }) });
    const result = await adapter.executeReview({ prompt: 'ordinary review', cwd: process.cwd() });
    assert.equal(module.ReviewVerdict.fromOutput(result.combined).isPass(), false);
    assert.match(result.combined, /\nREVIEW_RESULT=BLOCK/);
    assert.doesNotMatch(result.combined, /> REVIEW_RESULT=BLOCK/);
  });

  for (const stderr of ['', 'Child diagnostic\nREVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK\n']) {
    test(`${label}: Given confirmed P2 and ${stderr ? 'marker-bearing' : 'empty'} stderr, When synthesis says PASS, Then the full workflow blocks without a permissive reemit`, async () => {
      // Given completed invocation-bound stage evidence and contradictory synthesis.
      const module = await import(modulePath);
      const root = await mkdtemp(path.join(tmpdir(), 'verified-block-workflow-'));
      let reemits = 0;
      let original;
      const diff = new module.DiffIdentity(Buffer.from('diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1 @@\n-export const add = (a,b) => a+b;\n+export const add = (a,b) => 0;\n'));
      const adapter = new module.OmpCliReviewerAdapter({ nativeBatch: true, runner: async (_prompt, _cwd, _timeout, options) => {
        if (options.noTools) { reemits += 1; return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }; }
        const file = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        const events = [
          { stage: 'review-context-scout', complete: true, mergedScout: { test_harness: 'present' } },
          { stage: 'review-risk-hunter', complete: true, requiresVerifier: true },
          { stage: 'review-finding-verifier', complete: true, blocksApproval: true, verifierData: verifiedData },
          { stage: 'reviewer-kit', complete: true },
        ];
        await writeFile(`${file}.events`, events.map((event) => JSON.stringify({ invocationToken: manifest.invocationToken, ...event })).join('\n'));
        return { status: 0, stdout: 'Original synthesis\nREVIEW_RESULT=PASS\n', stderr };
      } });
      const service = new module.ReviewWorkflowService({
        gitPort: { getRepoRoot: async () => root, getStagedDiff: async () => diff, getSnapshot: async () => ({ files: [{ path: 'src/a.mjs', mode: '100644', content: Buffer.from('export const add = (a,b) => 0;\n') }] }) },
        reviewerPort: { executeReview: async (args) => (original = await adapter.executeReview(args)), reemitVerbatim: (args) => adapter.reemitVerbatim(args) },
        snapshotStorePort: { create: async () => root, remove: async () => {} },
        reportStorePort: { saveReport: async () => 'in-memory-report' },
        telemetryPort: { forRun: () => ({ record: async () => {}, updateLastRun: async () => {} }) },
        logger: { log: () => {}, error: () => {} }, execution: { enabled: false },
      });
      try {
        // When the production workflow evaluates combined output, not just stdout.
        const result = await service.execute({ cwd: root });
        const normalized = module.ReviewRejectionEnvelope.evaluate({ output: original.combined, diffIdentity: diff.hash, processStatus: original.status });

        // Then a late PASS cannot override the substantive verifier BLOCK.
        assert.equal(result.exitCode, 1);
        assert.equal(result.verdict, 'BLOCK');
        assert.equal(reemits, 0);
        assert.equal(normalized.verdict.reason, 'explicit_block');
        assert.equal(normalized.envelope.kind, 'confirmed_findings');
        assert.equal(normalized.envelope.findings[0].counterexample, verifiedFinding.trigger_scenario);
        assert.equal(original.stderr, stderr, 'raw child diagnostics remain observable');
        assert.match(original.combined, /> Verifier confirmed blocking findings/);
        assert.equal(original.combined.trimEnd().split('\n').at(-1), 'REVIEW_RESULT=BLOCK');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
