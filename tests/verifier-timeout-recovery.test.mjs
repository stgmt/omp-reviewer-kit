import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import * as source from '../src/index.mjs';
import * as bundle from '../scripts/run-review.mjs';

const diffHash = 'a'.repeat(64);
const report = 'Original synthesis\nREVIEW_RESULT=PASS\n';
const plan = {
  scouts: [{ id: 'Scout1', paths: ['src/a.mjs'] }],
  hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: ['src/a.mjs'] }],
};
const finding = {
  candidate_id: 'c1', lane: 'correctness', priority: 'P2', title: 'Wrong calculation',
  file_path: 'src/a.mjs', line_start: 1, line_end: 1,
  observed_behavior: 'Returns zero', expected_behavior: 'Returns the sum',
  trigger_scenario: 'add(1, 2) returns 0 instead of 3',
  impact: 'Caller receives a wrong total', evidence: ['src/a.mjs:1'],
};
const verifierData = {
  coverage_summary: 'Inspected changed calculation and caller',
  decisions: [{ candidate_id: 'c1', disposition: 'confirmed', triage: 'not_applicable', reason: 'Reachable wrong total', evidence: 'src/a.mjs:1' }],
  confirmed_findings: [finding], confirmed_coverage_gaps: [], rejected_coverage_gaps: [],
};

async function writeCompletedReview(options) {
  const manifestPath = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.invocationToken, options.invocationToken);
  const events = [
    { stage: 'review-context-scout', complete: true, mergedScout: { test_harness: 'present' } },
    { stage: 'review-risk-hunter', complete: true, requiresVerifier: true },
    { stage: 'review-finding-verifier', complete: true, blocksApproval: true, verifierData },
    { stage: 'reviewer-kit', complete: true },
  ];
  await writeFile(`${manifestPath}.events`, events.map((event) => JSON.stringify({ invocationToken: manifest.invocationToken, ...event })).join('\n'));

  // Native reviewer-kit object yield and matching artifact, bound to this attempt.
  const yielded = { verdict: 'PASS', envelope_kind: null, confirmed_findings: 0, diff_hash: diffHash, report };
  const dir = path.join(options.sessionDir, '2026-10-14T00-00-00-000Z_session');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ReviewerKit.md'), JSON.stringify(yielded));
  await writeFile(path.join(dir, 'ReviewerKit.jsonl'), [
    { type: 'session_init', agent: 'reviewer-kit', task: options.invocationToken, id: 'ReviewerKit' },
    { type: 'message', message: { role: 'toolResult', toolName: 'yield', details: { status: 'success', data: yielded } } },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
}

for (const [label, module] of [['source', source], ['bundle', bundle]]) {
  for (const scenario of [
    { name: 'inferred max-time expiry', durationMs: 60_000, explicitTimeout: false, blocked: true },
    { name: 'explicit runner timeout', durationMs: 1_000, explicitTimeout: true, blocked: true },
    { name: 'ordinary non-timeout recovery', durationMs: 1_000, explicitTimeout: false, blocked: false },
  ]) {
    test(`${label}: Given ${scenario.name}, When a PASS artifact is recovered with complete blocking verifier evidence, Then ${scenario.blocked ? 'fail without substantive repair' : 'preserve a substantive BLOCK'}`, { timeout: 5_000 }, async (t) => {
      // Given a deterministic clock and valid native stage evidence; no live child.
      let now = Date.UTC(2026, 9, 14);
      t.mock.method(Date, 'now', () => now);
      const telemetryEvents = [];
      let calls = 0;
      const adapter = new module.OmpCliReviewerAdapter({
        nativeBatch: true,
        maxTime: '60s',
        runner: async (prompt, _cwd, timeoutMs, options) => {
          calls += 1;
          assert.equal(timeoutMs, undefined, 'the review must not acquire a parent-side timer');
          assert.equal(options.maxTime, '60s');
          assert.ok(prompt.split('\n').includes(options.invocationToken));
          await writeCompletedReview(options);
          now += scenario.durationMs;
          // defaultRunner's exit-0-with-empty-stdout shape has no timedOut field.
          return { status: 0, stdout: '', stderr: '', ...(scenario.explicitTimeout ? { timedOut: true } : {}) };
        },
      });
      assert.equal(module.ReviewRejectionEnvelope.fromVerifier(verifierData, diffHash).kind, 'confirmed_findings');

      // When invocation-bound artifact recovery exposes contradictory PASS synthesis.
      const result = await adapter.executeReview({
        prompt: module.ReviewPrompt.forDiff(diffHash, '', ['src/a.mjs'], { batchPlan: plan }),
        cwd: process.cwd(),
        telemetry: { record: async (type, payload) => telemetryEvents.push({ type, payload }), updateLastRun: async () => {} },
      });

      // Then recovery occurred, without rewriting the original timeout/child record.
      assert.equal(calls, 1);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].status, 0);
      assert.equal(result.attempts[0].stdoutBytes, 0);
      assert.equal(result.attempts[0].durationMs, scenario.durationMs);
      assert.equal(result.attempts[0].timedOut, scenario.durationMs === 60_000);
      assert.deepEqual(result.attempts[0].reportRecovered, { reason: 'missing_marker', bytes: Buffer.byteLength(report) });
      assert.equal(telemetryEvents.filter((event) => event.type === 'report_artifact_recovered').length, 1);
      assert.equal(result.status, scenario.blocked ? 1 : 0, 'a timed-out child must not be serialized as a successful substantive BLOCK');
      const normalized = module.ReviewRejectionEnvelope.evaluate({ output: result.combined, diffIdentity: diffHash, processStatus: result.status });
      assert.equal(normalized.verdict.isPass(), false);
      if (scenario.blocked) {
        assert.equal(result.stdout, report, 'timeout must not manufacture a findings envelope from recovered synthesis');
        assert.match(result.stderr, /Verifier confirmed blocking findings or coverage; PASS synthesis rejected\./);
        assert.doesNotMatch(result.stdout, /REVIEW_REJECTION_ENVELOPE_BEGIN/);
        assert.equal(normalized.envelope.kind, 'review_failure');
        assert.equal(normalized.envelope.failure.code, 'execution_failure');
      } else {
        assert.equal(result.stderr, '');
        assert.equal(normalized.verdict.reason, 'explicit_block');
        assert.equal(normalized.envelope.kind, 'confirmed_findings');
        assert.equal(normalized.envelope.findings[0].counterexample, finding.trigger_scenario);
        assert.match(result.combined, /> Original synthesis\n> REVIEW_RESULT=PASS/);
        assert.equal(result.combined.trimEnd().split('\n').at(-1), 'REVIEW_RESULT=BLOCK');
      }
    });
  }
}
