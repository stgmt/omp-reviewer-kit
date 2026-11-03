// Given/When/Then across the seam the review actually uses: the deterministic stage produces a
// rejection, the assignment carries it, and the verdict blocks on it. Real snapshot files, real probe
// child process; only the model call is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildAssignment } from '../src/native/assignment.mjs';
import { evaluateReview } from '../src/native/verdict.mjs';
import { runContractAnalysis } from '../src/native/contract/analyze.mjs';
import { completed } from './support/stage-fixtures.mjs';

const snapshot = async (source) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-wire-'));
  await mkdir(path.join(dir, '.review'), { recursive: true });
  await writeFile(path.join(dir, 'ledger.mjs'), source);
  await writeFile(path.join(dir, '.review', 'changed-files.txt'), 'ledger.mjs\n');
  await writeFile(path.join(dir, '.review', 'file-classes.json'), '[]\n');
  return dir;
};

const CONTRADICTION = `
export function writeRecord({ id, service = null }) {
  return { schema: 'ledger@1', id, service };
}

export function readRecord(value) {
  if (value.service === null) throw new Error('ledger: service must be a name');
  return value;
}
`;

const summarize = summary => ({
  policy: summary.policy,
  status: summary.status,
  rejected: summary.pairs
    .filter(pair => pair.outcome === 'reader-rejects-written-record')
    .map(pair => ({ file: pair.file, writer: pair.writer, reader: pair.reader, error: pair.error, record: pair.record })),
  probed: summary.pairs.length,
  note: summary.note,
});

const verdictFor = contract => evaluateReview({
  reviewer: { exitCode: 0, aborted: false, yieldStatus: 'success', text: '## Review\n\nREVIEW_RESULT=PASS' },
  stages: [
    completed('review-context-scout', { test_harness: 'present' }),
    completed('review-risk-hunter', { lane: 'correctness' }),
    completed('review-maintainability', { candidates: [] }),
    completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
  ],
  profile: 'full',
  lanes: ['correctness'],
  maintainability: { policy: 'block', status: 'analyzed', coverage: 'full', planned: true },
  planned: ['review-maintainability'],
  contract,
});

test('Given a staged writer whose reader rejects its record, When the review runs end to end, Then the assignment carries it and the verdict blocks under the block policy', async () => {
  const dir = await snapshot(CONTRADICTION);
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    const assignment = buildAssignment({
      context: { snapshot: { dir, changedPaths: ['ledger.mjs'], diffHash: 'D' }, repo: 'R', profile: 'full', lanes: ['correctness'] },
      maintainability: null,
      reuse: null,
      contract: summarize(summary),
    });
    assert.match(assignment, /ledger\.mjs writeRecord -> readRecord/);
    assert.match(assignment, /service must be a name/);
    assert.match(assignment, /"service":null/);
    const verdict = verdictFor(summarize(summary));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join('\n'), /contract violated/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the probe could not run, When the review runs end to end, Then the failed stage reaches the verdict instead of being dropped', async () => {
  const dir = await snapshot('process.exit(0);\nexport function writeA({ id }) { return { id }; }\nexport function readA(value) { return value; }\n');
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'failed');
    const verdict = verdictFor(summarize(summary));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join('\n'), /contract analysis failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
