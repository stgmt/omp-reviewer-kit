import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReviewWorkflowService } from '../src/application/review-workflow-service.mjs';
import { DiffIdentity } from '../src/domain/diff-identity.mjs';
import { runReview as modularRunReview } from '../src/index.mjs';
import * as runner from '../scripts/run-review.mjs';

const DIFF = [
  'diff --git a/src/total.mjs b/src/total.mjs',
  'index 111..222 100644',
  '--- a/src/total.mjs',
  '+++ b/src/total.mjs',
  '@@ -1,3 +1,3 @@ export function computeTotal(items) {',
  '-  return items.length + 1;',
  '+  return items.length;',
  '',
].join('\n');

const SILENT = { log: () => {}, error: () => {} };
const STORE_KEYS = ['OMP_REVIEW_KIT_REPORTS_DIR', 'OMP_REVIEW_KIT_RUNS_DIR', 'OMP_REVIEW_KIT_CACHE'];

const exists = (filePath) => access(filePath).then(() => true, () => false);

const packPathIn = (prompt) => /context pack for the scout is at `([^`]+)`/.exec(String(prompt))?.[1] ?? null;

async function inIsolatedStores(fn) {
  const home = await mkdtemp(path.join(tmpdir(), 'omp-pack-life-'));
  const saved = Object.fromEntries(STORE_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    OMP_REVIEW_KIT_REPORTS_DIR: path.join(home, 'reports'),
    OMP_REVIEW_KIT_RUNS_DIR: path.join(home, 'runs'),
    OMP_REVIEW_KIT_CACHE: '0',
  });
  try {
    return await fn();
  } finally {
    for (const key of STORE_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

async function freshRepo() {
  return path.join(await mkdtemp(path.join(tmpdir(), 'omp-pack-life-repo-')), 'project');
}

function gitFor(root) {
  return (args) => {
    if (args[0] === 'rev-parse') return Buffer.from(`${root}\n`);
    if (args[0] === 'diff') return Buffer.from(DIFF);
    return Buffer.alloc(0);
  };
}

// A reviewer output that carries a valid rejection envelope bound to DIFF.
function envelopeBlockOutput() {
  const value = {
    schema: 'review-rejection-envelope@1',
    kind: 'confirmed_findings',
    diff_hash: createHash('sha256').update(DIFF).digest('hex'),
    findings: [{
      finding_id: 'correctness-1',
      priority: 'P2',
      severity: 'P2',
      defect_class: 'correctness',
      category_kind: 'finding',
      blocking: true,
      source: 'correctness',
      file_path: 'src/total.mjs',
      line_start: 1,
      line_end: 1,
      verifier_argument: 'The total must count the items as they are.',
      counterexample: 'computeTotal([1]) returns 2 instead of 1.',
    }],
    non_coverable_items: [],
  };
  return [
    '### Review coverage',
    '- one confirmed defect',
    '',
    'REVIEW_REJECTION_ENVELOPE_BEGIN',
    JSON.stringify(value),
    'REVIEW_REJECTION_ENVELOPE_END',
    'REVIEW_RESULT=BLOCK',
    '',
  ].join('\n');
}

test('Given a reviewer that returns BLOCK without an envelope, When the single re-emit also omits it, Then the scout pack exists during review, is removed after the run, and the exit code is 1', async () => {
  await inIsolatedStores(async () => {
    const root = await freshRepo();
    const calls = [];
    const seen = { packPath: null, existedInFlight: null };
    const result = await runner.runReview({
      cwd: root,
      git: gitFor(root),
      logger: SILENT,
      omp: async (prompt) => {
        calls.push(prompt);
        if (calls.length === 1) {
          seen.packPath = packPathIn(prompt);
          seen.existedInFlight = await exists(seen.packPath);
        }
        return { status: 0, stdout: 'REVIEW_RESULT=BLOCK\n', stderr: '' };
      },
    });
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(result.exitCode, 1);
    assert.equal(calls.length, 2, 'one review attempt and exactly one re-emit');
    assert.equal(seen.existedInFlight, true);
    assert.equal(await exists(seen.packPath), false);
  });
});

test('Given a reviewer that blocks with a valid rejection envelope, When the run finishes, Then the scout pack is removed, the exit code is 1, and no re-emit happens', async () => {
  await inIsolatedStores(async () => {
    const root = await freshRepo();
    const calls = [];
    const seen = { packPath: null, existedInFlight: null };
    const result = await modularRunReview({
      cwd: root,
      git: gitFor(root),
      logger: SILENT,
      omp: async (prompt) => {
        calls.push(prompt);
        if (calls.length === 1) {
          seen.packPath = packPathIn(prompt);
          seen.existedInFlight = await exists(seen.packPath);
        }
        return { status: 0, stdout: envelopeBlockOutput(), stderr: '' };
      },
    });
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(result.exitCode, 1);
    assert.equal(calls.length, 1, 'a valid envelope is never re-emitted');
    assert.equal(seen.existedInFlight, true);
    assert.equal(await exists(seen.packPath), false);
  });
});

test('Given a reviewer whose execution rejects, When execute settles, Then the error propagates and the scout pack is removed', async () => {
  const root = '/mock/root';
  const seen = { packPath: null, existedInFlight: null };
  const service = new ReviewWorkflowService({
    gitPort: {
      getRepoRoot: async () => root,
      getStagedDiff: async () => DiffIdentity.fromString(DIFF),
      getSnapshot: async () => ({ files: [{ path: 'src/total.mjs', content: Buffer.from('export const x = 1;\n') }] }),
      getHeadFile: async () => Buffer.from(''),
    },
    reviewerPort: {
      executeReview: async ({ prompt }) => {
        seen.packPath = packPathIn(prompt);
        seen.existedInFlight = await exists(seen.packPath);
        throw new Error('reviewer exploded');
      },
    },
    reportStorePort: { saveReport: async () => '/mock/report.md' },
    snapshotStorePort: {
      create: async () => '/mock/snap-transient',
      remove: async () => {},
      release: async () => {},
      refreshLease: async () => {},
    },
    telemetryPort: { forRun: () => ({ record: async () => {}, updateLastRun: async () => {} }) },
    logger: SILENT,
    execution: { enabled: false },
  });
  await assert.rejects(service.execute({ cwd: root }), /reviewer exploded/);
  assert.equal(seen.existedInFlight, true);
  assert.equal(await exists(seen.packPath), false);
});
