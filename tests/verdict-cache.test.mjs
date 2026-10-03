import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FileSystemVerdictCacheAdapter } from '../src/infra/filesystem-verdict-cache-adapter.mjs';
import { SubprocessGitAdapter } from '../src/infra/subprocess-git-adapter.mjs';
import { runReview as modularRunReview } from '../src/index.mjs';
import { runReview as bundledRunReview, FileSystemVerdictCacheAdapter as BundledCache } from '../scripts/run-review.mjs';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const DIFF = 'cache diff content';
const HASH = createHash('sha256').update(DIFF).digest('hex');
const OTHER_HASH = createHash('sha256').update('other').digest('hex');
const NOW = new Date('2026-10-03T10:00:00.000Z');
const DAY = 24 * 3600 * 1000;

const tempRepo = () => mkdtemp(path.join(tmpdir(), 'omp-cache-'));
const writeReport = async (repo, name, { hash = HASH, result = 'PASS' } = {}) => {
  const dir = path.join(repo, 'audit-reports', 'commit-reviews');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `# OMP Review Kit commit review\n\n- staged diff hash: ${hash}\n- result: ${result}\n\nbody\n`);
  return file;
};

for (const [label, Cache] of [['modular', FileSystemVerdictCacheAdapter], ['bundled', BundledCache]]) {
  describe(`Feature: PASS verdict cache adapter (${label})`, () => {
    it('Given a recorded PASS, When the same tree+diff is looked up, Then it hits and returns the absolute report path', async () => {
      const repo = await tempRepo();
      const cache = new Cache({ clock: () => NOW });
      const report = await writeReport(repo, 'r1.md');
      await cache.record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });
      const hit = await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH });
      assert.equal(hit.reportPath, report);
      assert.equal(hit.at, NOW.toISOString());
    });

    it('Given a different tree, diff hash, malformed ids, or no cache file, Then it misses', async () => {
      const repo = await tempRepo();
      const cache = new Cache({ clock: () => NOW });
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH }), null);
      const report = await writeReport(repo, 'r1.md');
      await cache.record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: OTHER_TREE, diffHash: HASH }), null);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: OTHER_HASH }), null);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: 'nothex', diffHash: HASH }), null);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: 'short' }), null);
    });

    it('Given an entry older than the TTL or dated in the future, Then it misses', async () => {
      const repo = await tempRepo();
      const report = await writeReport(repo, 'r1.md');
      await new Cache({ clock: () => NOW }).record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });
      const key = { repoRoot: repo, treeSha: TREE, diffHash: HASH };
      assert.equal(await new Cache({ clock: () => new Date(NOW.getTime() + 15 * DAY) }).lookup(key), null);
      assert.ok(await new Cache({ clock: () => new Date(NOW.getTime() + 13 * DAY) }).lookup(key));
      assert.equal(await new Cache({ clock: () => new Date(NOW.getTime() - 1000) }).lookup(key), null);
    });

    it('Given a stale index line, Then a missing report, a different hash, a BLOCK report, or an escaping path all miss', async () => {
      const repo = await tempRepo();
      const dir = path.join(repo, 'audit-reports', 'commit-reviews');
      await mkdir(dir, { recursive: true });
      const line = (reportPath, extra = {}) => JSON.stringify({ schema: 'review-verdict-cache@1', treeSha: TREE, diffHash: HASH, verdict: 'PASS', reportPath, at: NOW.toISOString(), ...extra });
      const cache = new Cache({ clock: () => NOW });
      const attempt = async (lines) => {
        await writeFile(path.join(dir, 'verdict-cache.jsonl'), `${lines.join('\n')}\n`);
        return cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH });
      };
      assert.equal(await attempt([line('audit-reports/commit-reviews/gone.md')]), null);
      await writeReport(repo, 'wrong-hash.md', { hash: OTHER_HASH });
      assert.equal(await attempt([line('audit-reports/commit-reviews/wrong-hash.md')]), null);
      await writeReport(repo, 'blocked.md', { result: 'BLOCK' });
      assert.equal(await attempt([line('audit-reports/commit-reviews/blocked.md')]), null);
      const outsideName = `outside-${path.basename(repo)}.md`;
      const outside = path.join(repo, '..', outsideName);
      await writeFile(outside, `- staged diff hash: ${HASH}\n- result: PASS\n`);
      assert.equal(await attempt([line(`../${outsideName}`)]), null);
      assert.equal(await attempt([line(outside)]), null);
      await writeReport(repo, 'ok.md');
      await writeReport(repo, 'other.md', { hash: OTHER_HASH });
      await writeFile(path.join(dir, 'verdict-cache.jsonl'), `${line('audit-reports/commit-reviews/other.md')}\n`);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: OTHER_HASH }), null, 'entry for another diff must not serve this diff');
      assert.equal(await attempt([line('audit-reports/commit-reviews/ok.md', { verdict: 'BLOCK' })]), null);
      assert.equal(await attempt([line('audit-reports/commit-reviews/ok.md', { schema: 'other@1' })]), null);
      assert.ok(await attempt(['not json', line('audit-reports/commit-reviews/ok.md')]), 'corrupt lines are skipped');
    });

    it('record ignores a malformed tree id and never writes', async () => {
      const repo = await tempRepo();
      await new Cache({ clock: () => NOW }).record({ repoRoot: repo, treeSha: 'xyz', diffHash: HASH, reportPath: path.join(repo, 'r.md') });
      await assert.rejects(readFile(path.join(repo, 'audit-reports', 'commit-reviews', 'verdict-cache.jsonl')), /ENOENT/);
    });
  });
}

describe('Feature: SubprocessGitAdapter.getIndexTree', () => {
  it('returns a valid object id, and null for garbage or git failure', async () => {
    assert.equal(await new SubprocessGitAdapter(() => Buffer.from(`${TREE}\n`)).getIndexTree('/r'), TREE);
    assert.equal(await new SubprocessGitAdapter(() => Buffer.from('fatal')).getIndexTree('/r'), null);
    assert.equal(await new SubprocessGitAdapter(() => { throw new Error('unmerged'); }).getIndexTree('/r'), null);
  });
});

const fakeGit = (repoRoot, tree) => (args) => {
  if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
  if (args[0] === 'diff') return Buffer.from(DIFF);
  if (args[0] === 'write-tree') return Buffer.from(`${tree}\n`);
  return Buffer.alloc(0);
};

const reviewer = (output) => {
  const state = { calls: 0 };
  return { state, fn: async () => { state.calls += 1; return { status: 0, stdout: output, stderr: '' }; } };
};

const PASS = '### Confirmed findings\nNone.\n\nREVIEW_RESULT=PASS\n';
const BLOCK_NO_ENVELOPE = '### Confirmed findings\n- x\n\nREVIEW_RESULT=BLOCK\n';

for (const [label, runReview] of [['modular', modularRunReview], ['bundled', bundledRunReview]]) {
  const run = (repo, tree, omp, extra = {}) => runReview({
    cwd: repo,
    git: fakeGit(repo, tree),
    logger: { log: () => {}, error: () => {} },
    now: NOW,
    omp,
    ...extra,
  });

  describe(`Feature: workflow reuses PASS for identical tree+diff (${label})`, () => {
    it('Given a PASS, When the identical tree+diff is committed again, Then the reviewer is not invoked and the original report is reported', async () => {
      const repo = await tempRepo();
      const first = reviewer(PASS);
      const r1 = await run(repo, TREE, first.fn);
      assert.equal(r1.exitCode, 0);
      assert.equal(first.state.calls, 1);

      const second = reviewer('REVIEW_RESULT=BLOCK\n');
      const events = [];
      const telemetry = { forRun: () => ({ record: async (type, payload) => { events.push({ type, ...payload }); }, updateLastRun: async () => {} }) };
      const r2 = await run(repo, TREE, second.fn, { telemetry });
      assert.equal(r2.exitCode, 0);
      assert.equal(r2.verdict, 'PASS');
      assert.equal(r2.reportPath, r1.reportPath);
      assert.equal(second.state.calls, 0);
      assert.ok(events.some((event) => event.type === 'verdict_cache_hit'));
      assert.ok(events.some((event) => event.type === 'run_finished' && event.cached === true));
    });

    it('Given a PASS for another tree, a BLOCK, or OMP_REVIEW_KIT_CACHE=0, Then the reviewer runs again', async () => {
      const repo = await tempRepo();
      await run(repo, TREE, reviewer(PASS).fn);

      const otherTree = reviewer(PASS);
      await run(repo, OTHER_TREE, otherTree.fn);
      assert.equal(otherTree.state.calls, 1);

      const previous = process.env.OMP_REVIEW_KIT_CACHE;
      process.env.OMP_REVIEW_KIT_CACHE = '0';
      try {
        const disabled = reviewer(PASS);
        await run(repo, TREE, disabled.fn);
        assert.equal(disabled.state.calls, 1);
      } finally {
        if (previous === undefined) delete process.env.OMP_REVIEW_KIT_CACHE;
        else process.env.OMP_REVIEW_KIT_CACHE = previous;
      }

      const blockRepo = await tempRepo();
      const r1 = await run(blockRepo, TREE, reviewer(BLOCK_NO_ENVELOPE).fn);
      assert.equal(r1.exitCode, 1);
      const again = reviewer(BLOCK_NO_ENVELOPE);
      const r2 = await run(blockRepo, TREE, again.fn);
      assert.equal(r2.exitCode, 1);
      assert.ok(again.state.calls >= 1, 'a BLOCK is re-reviewed, never cached');
    });

    it('Given a git without a usable tree id, Then caching is skipped and the review runs', async () => {
      const repo = await tempRepo();
      await run(repo, 'garbage', reviewer(PASS).fn);
      const second = reviewer(PASS);
      await run(repo, 'garbage', second.fn);
      assert.equal(second.state.calls, 1);
    });
  });
}
