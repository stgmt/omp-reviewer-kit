// The exemption as the host applies it: a real Git repository, a real staged snapshot, a maintainability
// artifact whose group is one shared contract, a confirmed decision from the specialist, and a PASS.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNativeReview } from '../src/native/native-review.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8' });
}

const PASS_REPORT = '## Review\n\nREVIEW_RESULT=PASS';

const SPAN = 'export function sourceSpan(lineStart, lineEnd) {\n  const start = Number.isFinite(lineStart) ? lineStart : 1;\n  return { lineStart: start, lineEnd: Number.isFinite(lineEnd) ? lineEnd : start };\n}\n';
const CONSUMER = "import { sourceSpan } from '../domain/source-span.mjs';\n\nexport function a(lineStart, lineEnd) {\n  return sourceSpan(lineStart, lineEnd);\n}\n\nexport function b(lineStart, lineEnd) {\n  return sourceSpan(lineStart, lineEnd);\n}\n";
const OTHER = "import { sourceSpan } from '../domain/source-span.mjs';\n\nexport function c(lineStart, lineEnd) {\n  return sourceSpan(lineStart, lineEnd);\n}\n\nexport function d(lineStart, lineEnd) {\n  return sourceSpan(lineStart, lineEnd);\n}\n";

const completed = (agent, data) => ({ agent, exitCode: 0, aborted: false, structuredStatus: 'valid', data });
const reviewerWithYield = text => ({ exitCode: 0, aborted: false, modelRole: 'task', resolvedModel: 'm', extractedToolData: { yield: [{ status: 'success', data: text }] } });

async function stagedRepo({ other = OTHER } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'exempt-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'exemption test']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, 'no-hooks')]);
  await writeFile(path.join(repo, 'base.mjs'), 'export const base = 1;\n');
  git(repo, ['add', 'base.mjs']);
  git(repo, ['commit', '-q', '-m', 'base']);
  await mkdir(path.join(repo, 'src', 'domain'), { recursive: true });
  await mkdir(path.join(repo, 'src', 'native'), { recursive: true });
  await mkdir(path.join(repo, 'src', 'infra'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'domain', 'source-span.mjs'), SPAN);
  await writeFile(path.join(repo, 'src', 'native', 'consumer.mjs'), CONSUMER);
  await mkdir(path.join(repo, 'tests'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'infra', 'other.mjs'), other);
  await writeFile(path.join(repo, 'tests', 'source-span.test.mjs'), "import { sourceSpan } from '../src/domain/source-span.mjs';\n\nexport const check = (lineStart, lineEnd) => sourceSpan(lineStart, lineEnd);\n");
  git(repo, ['add', '.']);
  return repo;
}

async function review(repo, parent, buildStageData, runsDir) {
  let assignment = null;
  const result = await runNativeReview({
    repo,
    kitRoot: repo,
    parentDir: parent,
    env: { OMP_REVIEW_KIT_RUNS_DIR: runsDir },
    runTask: async input => {
      assignment = input.assignment;
      const snapshotDir = /The staged snapshot directory is (.+)/.exec(input.assignment)?.[1]?.trim() ?? '';
      const artifact = JSON.parse(await readFile(path.join(snapshotDir, '.review', 'maintainability.json'), 'utf8'));
      const stageData = buildStageData(artifact);
      return { reviewer: reviewerWithYield(PASS_REPORT), stages: [
        completed('review-context-scout', { test_harness: 'present' }),
        completed('review-risk-hunter', { lane: 'correctness' }),
        completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
        completed('review-maintainability', stageData),
      ] };
    },
  });
  return { result, assignment };
}

test('Given a confirmed group that is one shared contract, When the review runs, Then the commit is not blocked by it', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'exempt-parent-'));
  const runsDir = await mkdtemp(path.join(tmpdir(), 'exempt-runs-'));
  try {
    const { result } = await review(repo, parent, artifact => ({
      candidates: [{ candidate_id: groupIdFor(artifact), decision: 'confirmed', stated_cost: 'coordinated edits to the helper, its consumers and its test', priority: 'P2', forwarding_only: false }],
    }), runsDir);
    assert.equal(result.verdict.pass, true, result.verdict.reasons.join('; '));
  } finally {
    await rm(repo, REMOVE);
    await rm(parent, REMOVE);
    await rm(runsDir, REMOVE);
  }
});

test('Given a confirmed group that a second module repeats without importing the owner, When the review runs, Then it blocks', async () => {
  const repo = await stagedRepo({ other: OTHER_COPY });
  const parent = await mkdtemp(path.join(tmpdir(), 'exempt-parent-'));
  const runsDir = await mkdtemp(path.join(tmpdir(), 'exempt-runs-'));
  try {
    const { result } = await review(repo, parent, artifact => ({
      candidates: [{ candidate_id: groupIdFor(artifact), decision: 'confirmed', stated_cost: 'two independent copies', priority: 'P2', forwarding_only: false }],
    }), runsDir);
    assert.equal(result.verdict.pass, false);
    assert.match(result.verdict.reasons.join(' '), /maintainability item/);
  } finally {
    await rm(repo, REMOVE);
    await rm(parent, REMOVE);
    await rm(runsDir, REMOVE);
  }
});

/** The id of the artifact group that carries both span parameters. */
function groupIdFor(artifact) {
  const groups = Array.isArray(artifact?.groups) ? artifact.groups : [];
  const group = groups.find(entry => Array.isArray(entry.params) && entry.params.includes('lineStart') && entry.params.includes('lineEnd'));
  assert.ok(group, `the fixture produces the shared span group; artifact groups: ${JSON.stringify(groups.map(entry => entry.params))}`);
  return group.groupId;
}

/** The same parameter pair implemented again in a module that never imports the owner. */
const OTHER_COPY = "export function c(lineStart, lineEnd) {\n  const start = Number.isFinite(lineStart) ? lineStart : 1;\n  return { lineStart: start, lineEnd: lineEnd ?? start };\n}\n\nexport function d(lineStart, lineEnd) {\n  return { lineStart: lineStart, lineEnd: lineEnd };\n}\n";

test('Given a consumer that disappears from the snapshot after the analysis, When the review runs, Then the group blocks instead of being exempted on trust', async () => {
  const repo = await stagedRepo();
  const parent = await mkdtemp(path.join(tmpdir(), 'exempt-parent-'));
  const runsDir = await mkdtemp(path.join(tmpdir(), 'exempt-runs-'));
  try {
    const result = await runNativeReview({
      repo,
      kitRoot: repo,
      parentDir: parent,
      env: { OMP_REVIEW_KIT_RUNS_DIR: runsDir },
      runTask: async input => {
        const snapshotDir = /The staged snapshot directory is (.+)/.exec(input.assignment)?.[1]?.trim() ?? '';
        const artifact = JSON.parse(await readFile(path.join(snapshotDir, '.review', 'maintainability.json'), 'utf8'));
        const group = artifact.groups.find(entry => Array.isArray(entry.params) && entry.params.includes('lineStart'));
        // The consumer is gone by the time the exemption is computed: the kit must not assume it.
        await rm(path.join(snapshotDir, 'src', 'native', 'consumer.mjs'), { force: true });
        return { reviewer: reviewerWithYield(PASS_REPORT), stages: [
          completed('review-context-scout', { test_harness: 'present' }),
          completed('review-risk-hunter', { lane: 'correctness' }),
          completed('review-finding-verifier', { confirmed_findings: [], confirmed_coverage_gaps: [] }),
          completed('review-maintainability', { candidates: [{ candidate_id: group.groupId, decision: 'confirmed', stated_cost: 'coordinated edits', priority: 'P2', forwarding_only: false }] }),
        ] };
      },
    });
    assert.equal(result.verdict.pass, false, 'a consumer the kit cannot read cannot earn the exemption');
    assert.match(result.verdict.reasons.join(' '), /maintainability item/);
  } finally {
    await rm(repo, REMOVE);
    await rm(parent, REMOVE);
    await rm(runsDir, REMOVE);
  }
});
