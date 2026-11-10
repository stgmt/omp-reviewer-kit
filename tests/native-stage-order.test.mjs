// The real stage plan of a review: the host, not the model, decides what runs and in which order.
// A recording stage runner replaces the native session; the rest of the review is real (snapshot,
// deterministic stages, verdict).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runNativeReview } from '../src/native/native-review.mjs';
import { completed } from './support/stage-fixtures.mjs';

const KIT_ROOT = path.resolve(import.meta.dirname, '..');

function git(repo, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', repo, ...args], { encoding: 'utf8' });
}

async function repoWithStaged(paths) {
  const repo = await mkdtemp(path.join(tmpdir(), 'stage-order-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'probe@example.com']);
  git(repo, ['config', 'user.name', 'Probe']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'base.txt'), 'base\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  for (const [file, body] of Object.entries(paths)) {
    const target = path.join(repo, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
  }
  git(repo, ['add', '-A']);
  return repo;
}

/** A data clump: the same four values always travel together, so the analysis delivers a group. */
const clump = name => `export function ${name}({ userId, tenantId, requestId, traceId }, value) {\n  return append('${name}', { userId, tenantId, requestId, traceId }, value);\n}\n`;
const clumpRepoFiles = {
  'src/a.mjs': `${clump('alpha')}\n${clump('beta')}\n`,
  'src/b.mjs': `${clump('gamma')}\n${clump('delta')}\n`,
};

const reviewerWithYield = text => ({
  exitCode: 0,
  aborted: false,
  modelRole: 'task',
  resolvedModel: 'm',
  extractedToolData: { yield: [{ status: 'success', data: text }] },
});

function stageData(agent, overrides = {}) {
  if (agent === 'review-context-scout') return { test_harness: 'present', relevant_consumers: [], coverage_map: [], ...overrides };
  if (agent === 'review-risk-hunter') return { lane: 'correctness', candidates: [], coverage_gaps: [], ...overrides };
  if (agent === 'review-maintainability') return { candidates: [], ...overrides };
  if (agent === 'review-finding-verifier') return { confirmed_findings: [], confirmed_coverage_gaps: [], ...overrides };
  return overrides;
}

function recordingRunner({ hunterOverrides = {} } = {}) {
  const calls = [];
  return {
    calls,
    async run(agent, name, task) {
      calls.push(agent);
      if (agent === 'reviewer-kit') {
        return { result: reviewerWithYield('REVIEW_RESULT=BLOCK'), evidence: completed('reviewer-kit', {}) };
      }
      const overrides = agent === 'review-risk-hunter' ? hunterOverrides : {};
      return { evidence: completed(agent, stageData(agent, overrides)) };
    },
  };
}

test('Given a full review with a maintainability candidate file, When the host runs the plan, Then the order is scout, hunter, maintainability, verifier, synthesis', async () => {
  const repo = await repoWithStaged(clumpRepoFiles);
  const parent = await mkdtemp(path.join(tmpdir(), 'stage-order-parent-'));
  try {
    const runner = recordingRunner();
    await runNativeReview({ repo, kitRoot: KIT_ROOT, parentDir: parent, env: {}, stageRunner: runner });
    assert.deepEqual(runner.calls, [
      'review-context-scout',
      'review-risk-hunter',
      'review-maintainability',
      'review-finding-verifier',
      'reviewer-kit',
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a spec-docs review whose hunter finds nothing, When the host runs the plan, Then the verifier is not called', async () => {
  const repo = await repoWithStaged({ 'docs/SPEC.md': '# Spec\n\nThe rule.\n' });
  const parent = await mkdtemp(path.join(tmpdir(), 'stage-order-parent-'));
  try {
    const runner = recordingRunner({ hunterOverrides: { lane: 'content-risk', candidates: [] } });
    await runNativeReview({ repo, kitRoot: KIT_ROOT, parentDir: parent, env: {}, stageRunner: runner });
    assert.deepEqual(runner.calls, ['review-context-scout', 'review-risk-hunter', 'reviewer-kit']);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('Given a spec-docs review whose hunter emits a candidate, When the host runs the plan, Then the verifier is called before synthesis', async () => {
  const repo = await repoWithStaged({ 'docs/SPEC.md': '# Spec\n\nThe rule.\n' });
  const parent = await mkdtemp(path.join(tmpdir(), 'stage-order-parent-'));
  try {
    const runner = recordingRunner({
      hunterOverrides: { lane: 'content-risk', candidates: [{ candidate_id: 'content-risk-1', title: 'Stale rule' }] },
    });
    await runNativeReview({ repo, kitRoot: KIT_ROOT, parentDir: parent, env: {}, stageRunner: runner });
    assert.deepEqual(runner.calls, [
      'review-context-scout',
      'review-risk-hunter',
      'review-finding-verifier',
      'reviewer-kit',
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
