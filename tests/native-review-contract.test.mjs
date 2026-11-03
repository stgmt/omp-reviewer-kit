// Given/When/Then over the orchestration seam: a real staged repository, the real contract stage, and
// an injected task that answers PASS. The verdict must still block on what the stage observed — a
// passing reviewer rescues nothing. No model, no OMP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runNativeReview } from '../src/native/native-review.mjs';
import { completed } from './support/stage-fixtures.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const stagedRepo = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-native-'));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), source);
  }
  git(dir, ['add', '-A']);
  return dir;
};

const passingTask = async () => ({
  reviewer: {
    exitCode: 0,
    aborted: false,
    modelRole: 'task',
    resolvedModel: 'm',
    // The native task delivers its report through the extracted yield, exactly as the host reads it.
    extractedToolData: { yield: [{ status: 'success', data: 'Reviewed the diff.\n\nREVIEW_RESULT=PASS' }] },
    durationMs: 1,
    tokens: 1,
    requests: 1,
  },
  stages: [
    { agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { test_harness: 'present' }, durationMs: 1, tokens: 1, requests: 1 },
    { agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { lane: 'correctness' }, durationMs: 1, tokens: 1, requests: 1 },
    { agent: 'review-maintainability', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { candidates: [] }, durationMs: 1, tokens: 1, requests: 1 },
    { agent: 'review-finding-verifier', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { confirmed_findings: [], confirmed_coverage_gaps: [] }, durationMs: 1, tokens: 1, requests: 1 },
  ],
});

const CONTRADICTION = `
export function writeRecord({ id, service = null }) {
  return { schema: 'ledger@1', id, service };
}

export function readRecord(value) {
  if (value.service === null) throw new Error('ledger: service must be a name');
  return value;
}
`;

test('Given a passing reviewer and a reader that rejects its own writer record, When the review runs, Then the verdict blocks and the contract data is carried', async () => {
  const repo = await stagedRepo({ 'src/ledger.mjs': CONTRADICTION });
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: path.resolve('.'),
      parentDir: osTmpdir(),
      env: { ...process.env, OMP_REVIEW_KIT_CONTRACT: 'block' },
      runTask: passingTask,
    });
    assert.equal(result.staged, true);
    assert.equal(result.contract.status, 'contract-violated');
    assert.equal(result.contract.rejected.length, 1);
    assert.equal(result.verdict.pass, false, 'a passing reviewer does not rescue a broken contract');
    assert.match(result.verdict.reasons.join('\n'), /contract violated/);
    assert.equal(typeof result.runSummary.timings.contractMs, 'number');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('Given the same diff with the stage switched off, When the review runs, Then nothing is probed and the reviewer decides alone', async () => {
  const repo = await stagedRepo({ 'src/ledger.mjs': CONTRADICTION });
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: path.resolve('.'),
      parentDir: osTmpdir(),
      env: { ...process.env, OMP_REVIEW_KIT_CONTRACT: 'off' },
      runTask: passingTask,
    });
    assert.equal(result.contract.status, 'off');
    assert.equal(result.verdict.pass, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('Given the contract stage throws, When the review runs, Then the failure reaches the verdict instead of being swallowed', async () => {
  const repo = await stagedRepo({ 'src/ledger.mjs': CONTRADICTION });
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: path.resolve('.'),
      parentDir: osTmpdir(),
      env: { ...process.env, OMP_REVIEW_KIT_CONTRACT: 'block' },
      runTask: passingTask,
      runContract: async () => { throw new Error('analysis exploded'); },
    });
    assert.equal(result.contract.status, 'failed');
    assert.match(result.contract.note, /analysis exploded/);
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join('\n'), /contract analysis failed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
