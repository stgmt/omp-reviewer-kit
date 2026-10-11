import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runReview } from '../src/index.mjs';

const NOW = new Date('2026-10-10T20:00:00.000Z');
const HOUR_MS = 3600_000;
const sha = (text) => createHash('sha256').update(text).digest('hex');

const diffOf = (...added) => [
  'diff --git a/src/a.mjs b/src/a.mjs',
  '--- a/src/a.mjs',
  '+++ b/src/a.mjs',
  '@@ -1 +1 @@',
  ...added.map((line) => `+${line}`),
  '',
].join('\n');

const previousDiff = diffOf('x');
const changedDiff = diffOf('x', 'z');
const PASS = '### Confirmed findings\nNone.\n\nREVIEW_RESULT=PASS\n';

const blockRecordAt = (at) => ({
  schema: 'review-round@1',
  diffHash: sha(previousDiff),
  at: at.toISOString(),
  round: 1,
  findings: [{ id: 'correctness-1', priority: 'P2', file: 'src/a.mjs', line: 3, summary: 'input x yields y' }],
  diffText: previousDiff,
});

async function reviewChangedDiffAfterBlock(record) {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-round-age-'));
  try {
    const roundDir = path.join(repo, 'audit-reports', 'commit-reviews');
    await mkdir(roundDir, { recursive: true });
    await writeFile(path.join(roundDir, 'last-block.json'), JSON.stringify(record), 'utf8');

    const prompts = [];
    const omp = async (prompt, cwd, timeoutMs, options = {}) => {
      if (options.noTools) return { status: 1, stdout: '', stderr: 'no re-emit in this test' };
      prompts.push(String(prompt));
      return { status: 0, stdout: PASS, stderr: '' };
    };
    const result = await runReview({
      cwd: repo,
      git: (args) => {
        if (args[0] === 'rev-parse') return Buffer.from(`${repo}\n`);
        if (args[0] === 'diff') return Buffer.from(changedDiff);
        return Buffer.alloc(0);
      },
      logger: { log: () => {}, error: () => {} },
      now: NOW,
      omp,
    });
    return { result, prompts };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('Feature: a previous BLOCK round expires after its maximum age', () => {
  const saved = {};
  const names = ['OMP_REVIEW_KIT_ROUNDS', 'OMP_REVIEW_KIT_REPORTS_DIR', 'OMP_REVIEW_KIT_RUNS_DIR', 'OMP_REVIEW_KIT_TARGETS'];
  let base;

  before(async () => {
    for (const name of names) saved[name] = process.env[name];
    base = await mkdtemp(path.join(tmpdir(), 'omp-round-age-env-'));
    delete process.env.OMP_REVIEW_KIT_ROUNDS;
    process.env.OMP_REVIEW_KIT_REPORTS_DIR = path.join(base, 'reports');
    process.env.OMP_REVIEW_KIT_RUNS_DIR = path.join(base, 'runs');
    process.env.OMP_REVIEW_KIT_TARGETS = path.join(base, 'review-kit-targets.json');
  });

  after(async () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(base, { recursive: true, force: true });
  });

  it('Given a BLOCK saved 12 hours and 1 millisecond ago, When a changed staged diff is reviewed, Then the prompt carries no PREVIOUS ROUND block', async () => {
    const { result, prompts } = await reviewChangedDiffAfterBlock(
      blockRecordAt(new Date(NOW.getTime() - (12 * HOUR_MS + 1))),
    );
    assert.equal(result.exitCode, 0);
    assert.ok(prompts.length > 0);
    assert.doesNotMatch(prompts[0], /PREVIOUS ROUND/);
  });

  it('Given a BLOCK saved 12 hours minus 1 minute ago, When a changed staged diff is reviewed, Then the prompt carries the PREVIOUS ROUND block', async () => {
    const { result, prompts } = await reviewChangedDiffAfterBlock(
      blockRecordAt(new Date(NOW.getTime() - (12 * HOUR_MS - 60_000))),
    );
    assert.equal(result.exitCode, 0);
    assert.ok(prompts.length > 0);
    assert.match(prompts[0], /PREVIOUS ROUND \(this is review round 2\)/);
    assert.match(prompts[0], /correctness-1 \(P2\) src\/a\.mjs:3/);
  });
});
