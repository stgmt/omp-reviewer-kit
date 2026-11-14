// Given/When/Then over the native verdict rule. Pure: no OMP, no model, no Git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReview, readVerdictMarker, reportFindings } from '../src/native/verdict.mjs';

const done = (agent, data = {}) => ({
  agent,
  exitCode: 0,
  aborted: false,
  structuredStatus: 'valid',
  data,
  role: 'task',
  model: 'resolved-by-omp',
});
const reviewerPass = text => ({ exitCode: 0, aborted: false, yieldStatus: 'success', text });
const FULL = { profile: 'full', lanes: ['correctness'] };
const everyStage = [
  done('review-context-scout', { test_harness: 'present' }),
  done('review-risk-hunter', { lane: 'correctness' }),
  done('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
];

test('Given one PASS marker as the last line and every stage completed, When evaluated, Then the review passes', () => {
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'), stages: everyStage, ...FULL });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.reasons, []);
});

test('Given a BLOCK marker and no stage confirmation, When evaluated, Then the review blocks naming the missing confirmation', () => {
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=BLOCK'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK without stage confirmation']);
});

test('Given a PASS and a verifier that confirmed only a coverage gap, When evaluated, Then the confirmed gap is not a finding against the PASS', () => {
  const stages = [
    everyStage[0],
    done('review-risk-hunter', { lane: 'correctness', candidates: [] }),
    done('review-finding-verifier', {
      confirmed_findings: [],
      confirmed_coverage_gaps: [{ coverage_id: 'coverage-1', severity: 'advisory', file_path: 'a.mjs', impact: 'no reachable failure proven' }],
      decisions: [{ candidate_id: 'coverage-1', disposition: 'confirmed', triage: 'disclosed_gap', reason: 'advisory', evidence: 'a.mjs:1' }],
    }),
  ];
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given a replayed verifier stage that carries the ids it saw, When the recomputed list is empty, Then its reuse decision still counts', () => {
  const verifier = done('review-finding-verifier', {
    confirmed_findings: [],
    confirmed_coverage_gaps: [],
    decisions: [{ candidate_id: 'reuse-1', disposition: 'confirmed', triage: 'lie', reason: 'the same responsibility twice', evidence: 'src/a.mjs:1' }],
  });
  verifier.candidateIds = ['reuse-1'];
  const result = evaluateReview({
    reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'),
    stages: [everyStage[0], done('review-risk-hunter', { lane: 'correctness', candidates: [] }), verifier],
    ...FULL,
    reuseCandidateIds: [],
  });
  assert.equal(result.pass, false, 'a stored verifier decision is bound to the list it saw');
  assert.ok(result.reasons.includes('verifier confirmed 1 finding(s) but the reviewer passed'));
});

test('Given a PASS and a verifier that confirms a reuse lead only as a decision, When evaluated, Then the PASS is refused', () => {
  const stages = [
    everyStage[0],
    done('review-risk-hunter', { lane: 'correctness', candidates: [] }),
    done('review-finding-verifier', {
      confirmed_findings: [],
      confirmed_coverage_gaps: [],
      decisions: [{ candidate_id: 'reuse-1', disposition: 'confirmed', triage: 'lie', reason: 'the same responsibility twice', evidence: 'src/a.mjs:1' }],
    }),
  ];
  const result = evaluateReview({
    reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'),
    stages,
    ...FULL,
    reuseCandidateIds: ['reuse-1'],
  });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('verifier confirmed 1 finding(s) but the reviewer passed'));
});

test('Given a PASS and a verifier decision that confirms a hunter candidate, When evaluated, Then the PASS is refused', () => {
  const stages = [
    everyStage[0],
    done('review-risk-hunter', { lane: 'correctness', candidates: [{ candidate_id: 'correctness-1' }] }),
    done('review-finding-verifier', {
      confirmed_findings: [],
      confirmed_coverage_gaps: [],
      decisions: [{ candidate_id: 'correctness-1', disposition: 'confirmed', triage: 'lie', reason: 'reachable', evidence: 'a.mjs:1' }],
    }),
  ];
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('verifier confirmed 1 finding(s) but the reviewer passed'));
});

test('Given a BLOCK marker and a verifier-confirmed finding, When evaluated, Then the block keeps the reviewer verdict as its reason', () => {
  const stages = [everyStage[0], everyStage[1], done('review-finding-verifier', { lane: 'correctness', confirmed_findings: [{ finding_id: 'R1' }], confirmed_coverage_gaps: [] })];
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=BLOCK'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK']);
});

test('Given a BLOCK with no stage confirmation and a report that lists a finding, When evaluated, Then the reason names the unconfirmed finding', () => {
  const text = '### Confirmed findings\n- **R1 (blocking)**: a conflict that no stage confirmed\n\n### Notes\nNone\n\nREVIEW_RESULT=BLOCK';
  const result = evaluateReview({ reviewer: reviewerPass(text), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, [
    'reviewer verdict BLOCK without stage confirmation',
    'report lists 1 confirmed finding(s) that no stage confirmed',
  ]);
});

test('Given a BLOCK with no stage confirmation and an empty findings list, When evaluated, Then no finding is counted', () => {
  const text = '### Confirmed findings\n- None.\n\nREVIEW_RESULT=BLOCK';
  const result = evaluateReview({ reviewer: reviewerPass(text), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK without stage confirmation']);
});

test('Given a BLOCK and a maintainability item the policy lets block, When evaluated, Then the block keeps the reviewer verdict as its reason', () => {
  const stages = [...everyStage, done('review-maintainability', { candidates: [{ candidate_id: 'g1', decision: 'confirmed', stated_cost: 'two copies of the same parameter group', priority: 'P2', forwarding_only: false }] })];
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=BLOCK'),
    stages,
    ...FULL,
    maintainability: { policy: 'block', status: 'analyzed', coverage: 'full', planned: true },
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK']);
});

test('Given a PASS whose report lists a P1 finding, When evaluated, Then the contradiction blocks', () => {
  const text = '### Confirmed findings\n- **P1** src/a.mjs:1-2 behaves wrong\n\nREVIEW_RESULT=PASS';
  const result = evaluateReview({ reviewer: reviewerPass(text), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['report lists 1 finding(s) with a priority but the reviewer passed']);
});

test('Given an unsupported BLOCK whose finding the re-verification rejected, When evaluated, Then the stages decide and the review passes with a note', () => {
  const text = '### Confirmed findings\n- **R1 (blocking)**: a conflict no stage found\n\nREVIEW_RESULT=BLOCK';
  const result = evaluateReview({
    reviewer: reviewerPass(text),
    stages: everyStage,
    ...FULL,
    recheck: { verdict: 'rejected', findings: 1 },
  });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.notes, ['re-verification rejected 1 finding(s) the report raised; the stages confirmed none']);
  assert.equal(result.recheckNeeded, false);
});

test('Given a re-verification that confirmed the report finding, When evaluated, Then the block is supported and names the recheck', () => {
  const verifier = done('review-finding-verifier', {
    lane: 'correctness',
    confirmed_findings: [{ candidate_id: 'report-1', lane: 'correctness', priority: 'P2', title: 'real', file_path: 'src/a.mjs' }],
    confirmed_coverage_gaps: [],
  });
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**: real\n\nREVIEW_RESULT=BLOCK'),
    stages: [everyStage[0], everyStage[1], verifier],
    ...FULL,
    recheck: { verdict: 'confirmed', findings: 1, confirmed: 1 },
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK', 're-verification confirmed 1 finding(s) the report raised']);
  assert.deepEqual(result.notes, []);
});

test('Given a re-verification that did not complete, When evaluated, Then the commit stays blocked with the reason', () => {
  const text = '### Confirmed findings\n- **R1**: a conflict\n\nREVIEW_RESULT=BLOCK';
  const result = evaluateReview({ reviewer: reviewerPass(text), stages: everyStage, ...FULL, recheck: { verdict: 'failed', findings: 1 } });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, [
    'reviewer verdict BLOCK without stage confirmation',
    're-verification did not settle the finding(s) the report raised',
  ]);
});

test('Given an unsupported BLOCK, When evaluated without a recheck, Then it asks for one', () => {
  const text = '### Confirmed findings\n- **R1**: a conflict\n\nREVIEW_RESULT=BLOCK';
  const result = evaluateReview({ reviewer: reviewerPass(text), stages: everyStage, ...FULL });
  assert.equal(result.recheckNeeded, true);
  assert.equal(result.pass, false);
});

test('Given a supported BLOCK, When evaluated, Then no recheck is requested', () => {
  const stages = [everyStage[0], everyStage[1], done('review-finding-verifier', { lane: 'correctness', confirmed_findings: [{ finding_id: 'R1' }], confirmed_coverage_gaps: [] })];
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=BLOCK'), stages, ...FULL });
  assert.equal(result.recheckNeeded, false);
});

test('Given a rejected re-verification but no completed mandatory verifier, When evaluated, Then the review still blocks', () => {
  // The state the host produces: the original verifier never completed, so the only completed
  // verifier-shaped stage is the recheck, and it is marked as one.
  const recheckStage = { ...done('review-finding-verifier', { lane: 'correctness', confirmed_findings: [], confirmed_coverage_gaps: [] }), recheck: true };
  const stages = [everyStage[0], everyStage[1], recheckStage];
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**\n\nREVIEW_RESULT=BLOCK'),
    stages,
    ...FULL,
    recheck: { verdict: 'rejected', findings: 1 },
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed stage evidence for review-finding-verifier/);
});

test('Given a report whose findings section records their absence, When evaluated, Then no finding is counted and the PASS stands', () => {
  const text = '### Confirmed findings\n- No P1/P2 findings; the change is additive.\n\nREVIEW_RESULT=PASS';
  assert.deepEqual(reportFindings(text), { bullets: 0, structured: 0, items: [] });
  const result = evaluateReview({ reviewer: reviewerPass(text), stages: everyStage, ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given PASS and BLOCK markers together, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer verdict markers: 2/);
});

test('Given a PASS marker and a verifier that omits its confirmed lists, When evaluated, Then the review passes without reading a missing list', () => {
  const stages = [everyStage[0], everyStage[1], done('review-finding-verifier', {})];
  const result = evaluateReview({ reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given two PASS markers, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS\nREVIEW_RESULT=PASS'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
});

test('Given a PASS marker inside a sentence, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('I would say REVIEW_RESULT=PASS here'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
});

test('Given a PASS marker that is not the last line, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS\n\nTrailing prose'), stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /not the last line/);
});

test('Given a marker with trailing punctuation, When read, Then it is not a verdict', () => {
  assert.deepEqual(readVerdictMarker('REVIEW_RESULT=PASS.'), { verdict: null, reason: 'reviewer verdict marker is not PASS or BLOCK' });
});

test('Given the scout never completed, When evaluated, Then it blocks and names the scout', () => {
  const stages = everyStage.filter(stage => stage.agent !== 'review-context-scout');
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /review-context-scout/);
});

test('Given the scout exits 1 with otherwise valid output, When evaluated, Then the scout is not evidence and the review blocks naming it', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-context-scout' ? { ...stage, exitCode: 1 } : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed stage evidence for review-context-scout/);
});

test('Given the only correctness hunter exits 1, When evaluated, Then its lane is missing and the review blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-risk-hunter' ? { ...stage, exitCode: 1 } : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed review-risk-hunter task for planned lane\(s\): correctness/);
});

test('Given the only correctness hunter has no exit code, When evaluated, Then its lane is missing and the review blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-risk-hunter' ? { ...stage, exitCode: null } : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /planned lane\(s\): correctness/);
});

test('Given a planned lane with no completed hunter, When evaluated, Then it blocks and names the lane', () => {
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=PASS'),
    stages: everyStage,
    profile: 'full',
    lanes: ['correctness', 'security'],
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed review-risk-hunter task for planned lane\(s\): security/);
});

test('Given two correctness hunters and no security hunter under the correctness and security lanes, When evaluated, Then it blocks and names the security lane', () => {
  const stages = [
    ...everyStage.filter(stage => stage.agent !== 'review-risk-hunter'),
    done('review-risk-hunter', { lane: 'correctness' }),
    done('review-risk-hunter', { lane: 'correctness' }),
  ];
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, profile: 'full', lanes: ['correctness', 'security'] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /planned lane\(s\): security/);
});

test('Given a full profile with no completed verifier, When evaluated, Then it blocks', () => {
  const stages = everyStage.filter(stage => stage.agent !== 'review-finding-verifier');
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /review-finding-verifier/);
});

test('Given a spec-docs profile with no verifier, When evaluated, Then the verifier is not required', () => {
  const stages = [done('review-context-scout', { test_harness: 'absent' }), done('review-risk-hunter', { lane: 'content-risk' })];
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, profile: 'spec-docs', lanes: ['content-risk'] });
  assert.equal(result.pass, true);
});

test('Given a stage that aborted, When evaluated, Then it is not evidence', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-finding-verifier' ? { ...stage, aborted: true } : stage));
  assert.equal(evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL }).pass, false);
});

test('Given a stage with an invalid structured result, When evaluated, Then it is not evidence', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-risk-hunter' ? { ...stage, structuredStatus: 'invalid' } : stage));
  assert.equal(evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL }).pass, false);
});

test('Given the reviewer task exited non-zero with a PASS marker, When evaluated, Then it blocks with the exit reason', () => {
  const reviewer = { ...reviewerPass('REVIEW_RESULT=PASS'), exitCode: 1 };
  const result = evaluateReview({ reviewer, stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer task exit 1/);
});

test('Given the reviewer aborted, When evaluated, Then it blocks even with a PASS marker', () => {
  const reviewer = { ...reviewerPass('REVIEW_RESULT=PASS'), aborted: true };
  assert.equal(evaluateReview({ reviewer, stages: everyStage, ...FULL }).pass, false);
});

test('Given the reviewer never yielded, When evaluated, Then it blocks with the yield reason', () => {
  const reviewer = { ...reviewerPass('REVIEW_RESULT=PASS'), yieldStatus: null };
  const result = evaluateReview({ reviewer, stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer yield missing/);
});

test('Given no reviewer result, When evaluated, Then it blocks', () => {
  const result = evaluateReview({ reviewer: undefined, stages: everyStage, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /reviewer task result missing/);
});

test('Given a PASS that stands against a confirmed finding, When evaluated, Then it blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-finding-verifier'
    ? { ...stage, data: { confirmed_findings: [{ id: 'correctness-1' }], confirmed_coverage_gaps: [] } }
    : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /verifier confirmed 1 finding/);
});

test('Given a PASS that stands against a confirmed gap while a test harness exists, When evaluated, Then it blocks', () => {
  const stages = everyStage.map(stage => (stage.agent === 'review-finding-verifier'
    ? { ...stage, data: { confirmed_findings: [], confirmed_coverage_gaps: [{ id: 'coverage-1' }] } }
    : stage));
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /coverage gap/);
});

const withGap = gap => everyStage.map(stage => (stage.agent === 'review-finding-verifier'
  ? { ...stage, data: { confirmed_findings: [], confirmed_coverage_gaps: [gap] } }
  : stage));

test('Given a blocking gap with a concrete impact, When evaluated, Then the PASS is rejected', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'blocking', impact: 'a caller writes to the wrong account' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /blocking coverage gap/);
});

test('Given a blocking gap without a concrete impact, When evaluated, Then the impact floor keeps the PASS', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'blocking', impact: '   ' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given an advisory gap, When evaluated, Then it never blocks the PASS', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'advisory', impact: 'presentation text only' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given a blocking gap whose own per-entry harness is absent, When evaluated, Then it never blocks the PASS', () => {
  const gap = { coverage_id: 'coverage-1', severity: 'blocking', impact: 'a caller writes to the wrong account', test_harness: 'absent' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
});

test('Given a blocking gap in a test-class file from the manifest, When evaluated, Then the test-class exemption keeps the PASS', () => {
  const gap = { coverage_id: 'coverage-1', file_path: 'tests/feature.test.mjs', severity: 'blocking', impact: 'a helper returns the wrong fixture' };
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=PASS'),
    stages: withGap(gap),
    fileClasses: [{ path: 'tests/feature.test.mjs', fileClass: 'test' }],
    ...FULL,
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Given a blocking gap that declares its own test file class, When evaluated, Then the test-class exemption keeps the PASS', () => {
  const gap = { coverage_id: 'coverage-1', file_path: 'feature.test.mjs', file_class: 'test', severity: 'blocking', impact: 'a helper returns the wrong fixture' };
  const result = evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages: withGap(gap), ...FULL });
  assert.equal(result.pass, true);
});

test('Given a blocking gap in an executable file, When evaluated with the manifest, Then the PASS remains blocked', () => {
  const gap = { coverage_id: 'coverage-1', file_path: 'src/feature.mjs', severity: 'blocking', impact: 'a caller writes to the wrong account' };
  const result = evaluateReview({
    reviewer: reviewerPass('REVIEW_RESULT=PASS'),
    stages: withGap(gap),
    fileClasses: [{ path: 'src/feature.mjs', fileClass: 'executable' }],
    ...FULL,
  });
  assert.equal(result.pass, false);
});

test('Given a confirmed gap while the scout reports no test harness, When evaluated, Then the PASS stands', () => {
  const stages = everyStage.map(stage => {
    if (stage.agent === 'review-finding-verifier') return { ...stage, data: { confirmed_findings: [], confirmed_coverage_gaps: [{ id: 'coverage-1' }] } };
    if (stage.agent === 'review-context-scout') return { ...stage, data: { test_harness: 'absent' } };
    return stage;
  });
  assert.equal(evaluateReview({ reviewer: reviewerPass('REVIEW_RESULT=PASS'), stages, ...FULL }).pass, true);
});

test('Given a re-verification that rejected the reported finding and confirmed only an advisory gap, When evaluated, Then the evidence passes', () => {
  const recheckStage = done('review-finding-verifier', {
    lane: 'correctness',
    confirmed_findings: [],
    confirmed_coverage_gaps: [{ coverage_id: 'c1', file_path: 'src/a.mjs', severity: 'advisory', impact: 'a cost, not a defect' }],
  });
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**: a conflict\n\nREVIEW_RESULT=BLOCK'),
    stages: [...everyStage, recheckStage],
    ...FULL,
    recheck: { verdict: 'rejected', findings: 1 },
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.notes, ['re-verification rejected 1 finding(s) the report raised; the stages confirmed none']);
});

test('Given a re-verification that confirmed a blocking coverage gap, When evaluated, Then the gap supports the block and no finding is invented', () => {
  const recheckStage = done('review-finding-verifier', {
    lane: 'correctness',
    confirmed_findings: [],
    confirmed_coverage_gaps: [{ coverage_id: 'c1', file_path: 'src/a.mjs', severity: 'blocking', impact: 'the uncovered branch ships wrong output', file_class: 'executable', test_harness: 'present' }],
  });
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**: a conflict\n\nREVIEW_RESULT=BLOCK'),
    stages: [...everyStage, recheckStage],
    ...FULL,
    recheck: { verdict: 'rejected', findings: 1 },
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK']);
});

test('Given a re-verification that left the claim unproven, When evaluated, Then the commit stays blocked', () => {
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**: a conflict\n\nREVIEW_RESULT=BLOCK'),
    stages: everyStage,
    ...FULL,
    recheck: { verdict: 'unsettled', findings: 1 },
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, [
    'reviewer verdict BLOCK without stage confirmation',
    're-verification left the finding(s) the report raised unproven',
  ]);
});

test('Given an absence-shaped bullet that names a file and a defect, When the report is read, Then it is still a finding', () => {
  const text = '### Confirmed findings\n- No error handling in src/a.mjs — a defect\n\nREVIEW_RESULT=PASS';
  assert.equal(reportFindings(text).bullets, 1, 'a cited file means the bullet reports a defect, not an absence');
});

test('Given findings written as numbered entries, When the report is read, Then each entry is a claim', () => {
  const text = '### Confirmed findings\n1. **P1** src/a.mjs:1-2 behaves wrong\n2. **P2** src/b.mjs:3 another\n\nREVIEW_RESULT=BLOCK';
  const findings = reportFindings(text);
  assert.equal(findings.bullets, 2);
  assert.equal(findings.structured, 2);
});

test('Given one finding with indented field bullets, When the report is read, Then only the entry is a claim', () => {
  const text = '### Confirmed findings\n- **P1** src/a.mjs:1-2 behaves wrong\n  - **Observed behavior:** x\n  - **Expected behavior:** y\n  - **Impact:** z\n';
  assert.deepEqual(reportFindings(text).items, ['P1 src/a.mjs:1-2 behaves wrong']);
  const wholeIndented = '### Confirmed findings\n  - **P2** src/b.mjs:3 wrong\n    - **Observed:** x\n';
  assert.deepEqual(reportFindings(wholeIndented).items, ['P2 src/b.mjs:3 wrong']);
});

test('Given an unsupported BLOCK that already has another reason, When evaluated, Then no recheck is requested', () => {
  const stages = [everyStage[0], everyStage[1]];
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**\n\nREVIEW_RESULT=BLOCK'),
    stages,
    ...FULL,
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /no completed stage evidence for review-finding-verifier/);
  assert.equal(result.recheckNeeded, false, 'a second verifier pass cannot remove another blocker');
});

test('Given a verifier that records the defect as still present, When evaluated, Then it counts as confirmed evidence in both directions', () => {
  const verifier = done('review-finding-verifier', {
    lane: 'correctness',
    decisions: [{ candidate_id: 'correctness-1', disposition: 'still_present', triage: 'lie', reason: 'the snapshot shows it', evidence: 'src/a.mjs:1' }],
    confirmed_findings: [],
    confirmed_coverage_gaps: [],
  });
  const hunter = done('review-risk-hunter', { lane: 'correctness', candidates: [{ candidate_id: 'correctness-1' }] });
  const blocked = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **R1**: a conflict\n\nREVIEW_RESULT=BLOCK'),
    stages: [everyStage[0], hunter, verifier],
    ...FULL,
    recheck: { verdict: 'confirmed', findings: 1, confirmed: 1 },
  });
  assert.equal(blocked.pass, false);
  assert.deepEqual(blocked.reasons, ['reviewer verdict BLOCK', 're-verification confirmed 1 finding(s) the report raised']);

  const passed = evaluateReview({
    reviewer: reviewerPass('## Review\n\nREVIEW_RESULT=PASS'),
    stages: [everyStage[0], hunter, verifier],
    ...FULL,
  });
  assert.equal(passed.pass, false, 'a finished verifier that says still present cannot be passed over');
  assert.match(passed.reasons.join(' '), /verifier confirmed 1 finding\(s\) but the reviewer passed/);
});

test('Given a verifier that confirms a duplicate implementation, When evaluated, Then the pair blocks the commit', () => {
  const verifier = done('review-finding-verifier', {
    lane: 'correctness',
    confirmed_findings: [{ candidate_id: 'reuse-1', lane: 'reuse', priority: 'P2', title: 'second copy of collectVisible', file_path: 'src/new.mjs' }],
    confirmed_coverage_gaps: [],
  });
  const result = evaluateReview({
    reviewer: reviewerPass('### Confirmed findings\n- **P2** src/new.mjs:4 repeats src/old.mjs:9\n\nREVIEW_RESULT=BLOCK'),
    stages: [everyStage[0], everyStage[1], verifier],
    ...FULL,
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['reviewer verdict BLOCK']);
});
