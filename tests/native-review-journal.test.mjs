// A review answered by the journal: the same index tree returns the stored verdict without running
// the model, and any change to the staged tree misses. Real git in a temporary repository; the task
// runner is a fake that records whether it was called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runNativeReview } from '../src/native/native-review.mjs';
import { readJournal, writeJournal } from '../src/infra/review-journal-store.mjs';
import { completed } from './support/stage-fixtures.mjs';

const KIT_ROOT = path.resolve(import.meta.dirname, '..');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-journal-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@example.com']);
  git(dir, ['config', 'user.name', 'Probe']);
  await writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function fakeTask() {
  const calls = [];
  const runTask = async () => {
    calls.push(1);
    return {
      reviewer: {
        exitCode: 0,
        extractedToolData: {
          yield: [{ status: 'success', data: 'REVIEW_RESULT=PASS' }],
          task: [],
        },
      },
      stages: [],
      sessionFile: null,
    };
  };
  return { runTask, calls };
}

const contractStub = async () => ({ status: 'no-pairs', pairs: [], unparsedFiles: [], unproven: [], policy: 'advisory' });

const reviewerYield = data => ({
  exitCode: 0,
  aborted: false,
  modelRole: 'task',
  resolvedModel: 'fake/model',
  extractedToolData: { yield: [{ status: 'success', data }] },
});

test('Given a stored verdict for the same index tree, When the review runs, Then the model is not called', async () => {
  const repo = await tempRepo();
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'review-journal-hit-'));
  try {
    await writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
    git(repo, ['add', 'b.txt']);

    const first = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: fakeTask().runTask,
      runContract: contractStub,
    });
    assert.equal(first.journal.hit, false);
    assert.ok(first.journal.key, 'the staged state must have a key');

    // The stored verdict is what the next identical tree gets, whatever it says.
    const stored = await readJournal(journalRoot, first.journal.key);
    assert.ok(stored, 'a finished review must be journaled');
    await writeJournal(journalRoot, first.journal.key, {
      ...stored,
      verdict: { pass: true, verdict: 'PASS', reasons: [] },
      text: 'REVIEW_RESULT=PASS',
      provenance: { role: 'task', model: 'fake/model' },
    });

    const task = fakeTask();
    const reused = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: task.runTask,
      runContract: contractStub,
    });

    assert.equal(task.calls.length, 0, 'a journal hit must not run the model');
    assert.equal(reused.journal.hit, true);
    assert.equal(reused.journal.key, first.journal.key);
    assert.equal(reused.verdict.pass, true);
    assert.equal(reused.verdict.verdict, 'PASS');
    assert.equal(reused.text, 'REVIEW_RESULT=PASS');
    assert.equal(reused.provenance.model, 'fake/model');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('Given a changed index tree, When the review runs, Then the stored verdict does not apply and the model runs', async () => {
  const repo = await tempRepo();
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'review-journal-miss-'));
  try {
    await writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
    git(repo, ['add', 'b.txt']);
    const task = fakeTask();
    const first = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: task.runTask,
      runContract: contractStub,
    });
    assert.equal(first.journal.hit, false);
    assert.equal(task.calls.length, 1);

    await writeFile(path.join(repo, 'c.txt'), 'three\n', 'utf8');
    git(repo, ['add', 'c.txt']);
    const second = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: tmpdir(),
      env: { OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot },
      runTask: task.runTask,
      runContract: contractStub,
    });
    assert.equal(second.journal.hit, false);
    assert.equal(task.calls.length, 2, 'a new index tree is a new review');
    assert.notEqual(first.journal.key, second.journal.key);

    const stored = await readJournal(journalRoot, second.journal.key);
    assert.ok(stored, 'the finished review is journaled for the next identical tree');
    assert.equal(stored.state, 'done');
    assert.equal(stored.ignoredStagedPaths.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('Given a journaled verifier that names a reuse lead, When a resumed review recomputes an empty list, Then the stored decision still blocks', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-journal-reuse-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'review-journal-parent-'));
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'review-journal-stages-'));
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'review-journal-reuse-cache-'));
  const body = names => `export function ${names.fn}(items) {
  const ${names.out} = [];
  for (const ${names.item} of items) {
    if (!${names.item}) continue;
    if (${names.item}.hidden) continue;
    if (!${names.item}.name) continue;
    if (${names.item}.name.length === 0) continue;
    ${names.out}.push({ name: ${names.item}.name, size: ${names.item}.size, kind: ${names.item}.kind });
  }
  ${names.out}.sort((left, right) => left.name.localeCompare(right.name));
  const ${names.seen} = new Set();
  const ${names.unique} = [];
  for (const ${names.entry} of ${names.out}) {
    if (${names.seen}.has(${names.entry}.name)) continue;
    ${names.seen}.add(${names.entry}.name);
    ${names.unique}.push(${names.entry});
  }
  return ${names.unique};
}
`;
  const pass = '## Review\n\nREVIEW_RESULT=PASS';
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'probe@example.com']);
    git(repo, ['config', 'user.name', 'Probe']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
    await writeFile(path.join(repo, 'base.mjs'), body({ fn: 'collectVisible', out: 'out', item: 'item', seen: 'seen', unique: 'unique', entry: 'entry' }));
    git(repo, ['add', 'base.mjs']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(path.join(repo, 'feature.mjs'), body({ fn: 'gatherShown', out: 'result', item: 'row', seen: 'met', unique: 'kept', entry: 'candidate' }));
    git(repo, ['add', 'feature.mjs']);

    const env = {
      OMP_REVIEW_KIT_JOURNAL_DIR: journalRoot,
      OMP_REVIEW_KIT_REUSE_CACHE_DIR: cacheRoot,
    };
    const firstRunner = {
      async run(agent, name) {
        if (name === 'ContextScout') return { evidence: completed('review-context-scout', { test_harness: 'present', changed_paths: ['feature.mjs'], relevant_consumers: [] }) };
        if (name.startsWith('RiskHunter')) return { evidence: completed('review-risk-hunter', { lane: 'correctness', candidates: [], coverage_gaps: [] }) };
        if (name === 'FindingVerifier') {
          return {
            evidence: completed('review-finding-verifier', {
              lane: 'correctness',
              decisions: [{ candidate_id: 'reuse-1', disposition: 'confirmed', triage: 'lie', reason: 'the same responsibility twice', evidence: 'feature.mjs:1' }],
              confirmed_findings: [],
              confirmed_coverage_gaps: [],
            }),
          };
        }
        if (name === 'Synthesis') {
          return { result: reviewerYield(pass), evidence: completed('reviewer-kit', {}) };
        }
        return { evidence: completed(agent, {}) };
      },
    };
    const first = await runNativeReview({ repo, kitRoot: KIT_ROOT, parentDir: parent, env, stageRunner: firstRunner });
    assert.equal(first.verdict.pass, false, 'a confirmed reuse lead refuses the PASS');
    assert.match(first.verdict.reasons.join(' '), /verifier confirmed 1 finding\(s\) but the reviewer passed/);
    // Keep the stage entries but drop the finished verdict: the resumed review must re-evaluate the
    // replayed verifier stage, not return the stored BLOCK.
    await rm(path.join(journalRoot, first.journal.key, 'journal.json'), { force: true });

    let replayedStages = 0;
    const secondRunner = {
      async run(agent, name) {
        if (name === 'Synthesis') {
          return { result: reviewerYield(pass), evidence: completed('reviewer-kit', {}) };
        }
        replayedStages += 1;
        throw new Error(`stage ${name} must come from the journal`);
      },
    };
    // The second scan is truncated on purpose: the recomputed reuse list is empty, and only the id
    // space stored with the verifier stage can keep its decision meaningful.
    const second = await runNativeReview({
      repo,
      kitRoot: KIT_ROOT,
      parentDir: parent,
      env,
      reuseConfig: { minSimilarity: 1.01 },
      stageRunner: secondRunner,
    });
    assert.equal(replayedStages, 0, 'the pipeline stages are replayed, not re-run');
    assert.equal(second.verdict.pass, false, 'the stored decision still counts against the PASS');
    assert.match(second.verdict.reasons.join(' '), /verifier confirmed 1 finding\(s\) but the reviewer passed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
