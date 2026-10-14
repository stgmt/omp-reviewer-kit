import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { registerReviewBatchGate } from '../src/infra/review-batch-extension.mjs';

const diffHash = 'a'.repeat(64);
const plan = {
  scouts: [{ id: 'Scout1', paths: ['src/a.mjs'] }],
  hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: ['src/a.mjs'] }],
};
const gap = {
  coverage_id: 'coverage-1', file_path: 'src/a.mjs', line_start: 1, line_end: 2,
  behavior: 'Changed calculation has no focused boundary test',
  required_tests: [
    { kind: 'edge', scenario: 'Assert add(0, 2) returns 2', mutant: '' },
    { kind: 'mutation', scenario: 'Reject a constant-zero calculation', mutant: 'Replace a + b with 0' },
  ],
};
const finding = {
  candidate_id: 'c1', lane: 'correctness', priority: 'P2', title: 'Wrong calculation',
  file_path: 'src/a.mjs', line_start: 1, line_end: 2,
  observed_behavior: 'Returns zero', expected_behavior: 'Returns the sum',
  trigger_scenario: 'add(1, 2) returns 0 instead of 3', impact: 'Caller receives a wrong total',
  evidence: ['src/a.mjs:1-2'],
};
function verifierData(withFinding = false) {
  return {
    coverage_summary: 'Inspected changed calculation, caller and test harness',
    decisions: withFinding ? [{
      candidate_id: 'c1', disposition: 'confirmed', triage: 'not_applicable',
      reason: 'Reachable wrong total', evidence: 'src/a.mjs:1-2',
    }] : [],
    confirmed_findings: withFinding ? [structuredClone(finding)] : [],
    confirmed_coverage_gaps: [structuredClone(gap)], rejected_coverage_gaps: [],
  };
}

for (const [label, modulePath] of [['source', '../src/index.mjs'], ['bundle', '../scripts/run-review.mjs']]) {
  test(`${label}: Given coverage-only verifier data, When the harness is absent, Then fromVerifier returns no coverage BLOCK`, async () => {
    // Given a valid gap with concrete edge and mutation tests, but no findings.
    const { ReviewRejectionEnvelope } = await import(modulePath);
    const data = verifierData();

    // When the caller supplies each harness classification.
    const absent = ReviewRejectionEnvelope.fromVerifier(structuredClone(data), diffHash, { harnessPresent: false });
    const present = ReviewRejectionEnvelope.fromVerifier(structuredClone(data), diffHash, { harnessPresent: true });

    // Then absent is not a coverage blocker; the same gap blocks with a harness.
    assert.equal(absent, null);
    assert.equal(present.kind, 'coverage_required');
    assert.equal(present.diffHash, diffHash);
    assert.equal(present.coverageItems[0].coverage_id, gap.coverage_id);
    assert.deepEqual(present.coverageItems[0].required_tests, gap.required_tests);
    assert.deepEqual(present.findings, []);
  });

  test(`${label}: Given a finding and coverage gap, When the harness is absent, Then fromVerifier preserves the finding BLOCK`, async () => {
    // Given a confirmed finding alongside a valid coverage gap.
    const { ReviewRejectionEnvelope } = await import(modulePath);
    for (const harnessPresent of [false, true]) {
      // When reconstructing with or without a runnable harness.
      const envelope = ReviewRejectionEnvelope.fromVerifier(verifierData(true), diffHash, { harnessPresent });

      // Then harness absence suppresses only coverage, never confirmed defects.
      assert.equal(envelope.kind, 'confirmed_findings');
      assert.equal(envelope.findings[0].finding_id, finding.candidate_id);
      assert.equal(envelope.findings[0].counterexample, finding.trigger_scenario);
      assert.match(envelope.findings[0].verifier_argument, /Returns zero.*Returns the sum/);
      assert.deepEqual(envelope.coverageItems, []);
    }
  });

  test(`${label}: Given malformed coverage gaps, When the harness is absent or findings take precedence, Then fromVerifier still rejects the payload`, async () => {
    const { ReviewRejectionEnvelope } = await import(modulePath);
    for (const harnessPresent of [false, true]) {
      for (const withFinding of [false, true]) {
        // Given an invalid mutation requirement in an otherwise valid payload.
        const data = verifierData(withFinding);
        data.confirmed_coverage_gaps[0].required_tests[1].mutant = '';

        // When findings would win or coverage would be suppressed.
        const envelope = ReviewRejectionEnvelope.fromVerifier(data, diffHash, { harnessPresent });

        // Then every gap is validated before either precedence decision.
        assert.equal(envelope, null, `harnessPresent=${harnessPresent}, withFinding=${withFinding}`);
      }
    }
  });

  for (const scenario of ['present-coverage', 'absent-coverage', 'absent-finding']) {
    test(`${label}: Given ${scenario}, When real native tool handlers complete the stages, Then persisted verifierData drives the verdict`, async () => {
      // Given an adapter invocation whose evidence is produced by the extension,
      // not by hand-injecting completion records into the events file.
      const module = await import(modulePath);
      const harnessPresent = scenario === 'present-coverage';
      const withFinding = scenario === 'absent-finding';
      const data = verifierData(withFinding);
      let persisted;
      const adapter = new module.OmpCliReviewerAdapter({ nativeBatch: true, runner: async (_prompt, _cwd, _timeout, options) => {
        const file = options.env.OMP_REVIEW_KIT_BATCH_MANIFEST;
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        const handlers = {};
        registerReviewBatchGate({ on: (event, handler) => { handlers[event] = handler; } }, file);
        const dispatch = async (name, agent, output) => {
          const gated = await handlers.tool_call({ toolName: 'task', toolCallId: name,
            input: { context: 'Inspect the staged calculation', tasks: [{ name, agent, task: 'Inspect owned behavior' }] } });
          assert.equal(gated.block, undefined, gated.reason);
          const result = await handlers.tool_result({ toolName: 'task', toolCallId: name, content: [],
            details: { results: [{ id: name, agent, exitCode: 0, structuredOutput: { status: 'valid', data: structuredClone(output) } }] } });
          assert.notEqual(result?.isError, true, JSON.stringify(result));
          return gated;
        };
        await dispatch('Scout1', 'review-context-scout', {
          change_goal: 'Change the calculation', changed_paths: ['src/a.mjs'], reviewed_paths: ['src/a.mjs'],
          relevant_consumers: [], invariants: ['add returns the sum'], test_evidence: [],
          test_harness: harnessPresent ? 'present' : 'absent — no runnable harness for this runtime',
          coverage_map: [{ behavior: gap.behavior, file_path: gap.file_path, line_start: gap.line_start, line_end: gap.line_end, covering_test: null }],
          non_coverable_items: [], claims: [], declared_checks: [], unknowns: [],
          completion: { scope_id: 'Scout1', completed_paths: ['src/a.mjs'], unresolved: [] },
        });
        await dispatch('Hunter-correctness', 'review-risk-hunter', {
          coverage_summary: 'Inspected changed calculation', candidates: withFinding ? [finding] : [],
          coverage_gaps: [gap], suppressed_coverage_items: [],
        });

        // When the verifier and orchestrator finish through registered handlers.
        const verifierCall = await dispatch('Verifier', 'review-finding-verifier', data);
        assert.match(verifierCall.input.context, /Authoritative completed hunter outputs/);
        assert.ok(verifierCall.input.context.includes(gap.coverage_id));
        await dispatch('ReviewerKit', 'reviewer-kit', {});
        const events = (await readFile(`${file}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

        // Then the producer persists the exact validated, invocation-bound data.
        assert.deepEqual(events.map((event) => event.stage), ['review-context-scout', 'review-risk-hunter', 'review-finding-verifier', 'reviewer-kit']);
        assert.ok(events.every((event) => event.complete && event.invocationToken === manifest.invocationToken));
        persisted = events[2];
        assert.deepEqual(persisted.tasks, ['Verifier']);
        assert.deepEqual(persisted.verifierData, data);
        assert.equal(persisted.blocksApproval, harnessPresent || withFinding);
        assert.ok(events.filter((event) => event.stage !== 'review-finding-verifier').every((event) => !Object.hasOwn(event, 'verifierData')));
        return { status: 0, stdout: 'Original synthesis\nREVIEW_RESULT=PASS\n', stderr: '' };
      } });
      const result = await adapter.executeReview({
        prompt: module.ReviewPrompt.forDiff(diffHash, '', [], { batchPlan: plan }), cwd: process.cwd(),
      });
      const normalized = module.ReviewRejectionEnvelope.evaluate({ output: result.combined, diffIdentity: diffHash, processStatus: result.status });

      // Then coverage-only absent-harness output permits PASS, but a harness or
      // a real finding yields substantive BLOCK from the produced verifier data.
      assert.ok(persisted, 'the actual producer ran');
      assert.equal(result.status, 0, 'complete successful provenance is not an infrastructure failure');
      assert.equal(normalized.verdict.isPass(), !harnessPresent && !withFinding);
      if (harnessPresent) {
        assert.equal(normalized.envelope.kind, 'coverage_required');
        assert.equal(normalized.envelope.coverageItems[0].coverage_id, gap.coverage_id);
      } else if (withFinding) {
        assert.equal(normalized.envelope.kind, 'confirmed_findings');
        assert.equal(normalized.envelope.findings[0].finding_id, finding.candidate_id);
      } else {
        assert.equal(normalized.envelope, null);
        assert.equal(result.combined.trimEnd().split('\n').at(-1), 'REVIEW_RESULT=PASS');
      }
    });
  }
}

test('Given bounded scout discovery, When reading the prompt contract, Then completion distinguishes unfinished inspection from epistemic unknowns', async () => {
  // Given the shipped scout prompt, not a duplicated fixture.
  const text = await readFile(new URL('../agents/review-context-scout.md', import.meta.url), 'utf8');
  const paragraph = text.split(/\r?\n/).find((line) => line.startsWith('When your task text names a context pack path,'));

  // Then the changed completion policy retains both negative-result acceptance
  // and the obligation to disclose an uninspected concrete deciding contract.
  assert.ok(paragraph);
  for (const contract of [
    '`completion.unresolved` is for unfinished required inspection of the supplied snapshot (an unread owned path, a failed necessary query, or unexamined deciding evidence), not every epistemic unknown.',
    'An inspected snapshot with no package manifest, no references, or no declared external contract is a bounded negative result: record the inspected scope in invariants/test_evidence and any uncertainty in unknowns.',
    'Do not require proof that hypothetical external or dynamic consumers cannot exist.',
    'When repository evidence identifies a concrete deciding caller or contract you cannot inspect, list that specific unfinished obligation in completion.unresolved; never claim completion of it.',
  ]) assert.ok(paragraph.includes(contract), `Missing scout contract: ${contract}`);
});

test('Given the native task schema, When reading the orchestrator prompt contract, Then required assignment shape is explicit without model or schema overrides', async () => {
  // Given the shipped orchestrator prompt.
  const text = await readFile(new URL('../agents/reviewer-kit.md', import.meta.url), 'utf8');
  const paragraph = text.split(/\r?\n/).find((line) => line.startsWith('OMP owns the active model roles,'));

  // Then native assignment metadata follows the advertised shape and leaves
  // model policy and specialist output schema ownership untouched.
  assert.ok(paragraph);
  for (const contract of [
    'Every child task call must include explicit `name`, `agent`, and `task`, plus batch `context` and `tasks` where applicable.',
    'Include `solutionSpace` when the advertised native schema requires it, describing the actual scope of investigation; do not omit native required assignment metadata.',
    'These assignment fields are not model overrides; omit `model`, `outputSchema`, `schemaMode`, and `isolated` so each specialist owns its declared output schema.',
  ]) assert.ok(paragraph.includes(contract), `Missing native assignment contract: ${contract}`);
});
