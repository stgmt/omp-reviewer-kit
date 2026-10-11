import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
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
const CACHE_DIR = path.join('audit-reports', 'commit-reviews');
const PASS = '### Confirmed findings\nNone.\n\nREVIEW_RESULT=PASS\n';
const BLOCK_NO_ENVELOPE = '### Confirmed findings\n- x\n\nREVIEW_RESULT=BLOCK\n';

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// A repository and a reports folder beside it. Reports live outside the repository.
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-cache-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const reports = path.join(root, 'reports');
  await mkdir(repo, { recursive: true });
  await mkdir(reports, { recursive: true });
  return { repo, reports };
}

async function writeReport(reports, name, { hash = HASH, result = 'PASS' } = {}) {
  const file = path.join(reports, name);
  await writeFile(file, `# OMP Review Kit commit review\n\n- staged diff hash: ${hash}\n- result: ${result}\n\nbody\n`);
  return file;
}

async function writeCacheLines(repo, lines) {
  const dir = path.join(repo, CACHE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'verdict-cache.jsonl'), `${lines.join('\n')}\n`);
}

const cacheLine = (reportPath, extra = {}) => JSON.stringify({
  schema: 'review-verdict-cache@1',
  treeSha: TREE,
  diffHash: HASH,
  verdict: 'PASS',
  reportPath,
  at: NOW.toISOString(),
  ...extra,
});

async function withReportsDir(dir, fn) {
  const previous = process.env.OMP_REVIEW_KIT_REPORTS_DIR;
  process.env.OMP_REVIEW_KIT_REPORTS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_REPORTS_DIR;
    else process.env.OMP_REVIEW_KIT_REPORTS_DIR = previous;
  }
}

function fakeGit(repoRoot, tree) {
  return (args) => {
    if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
    if (args[0] === 'diff') return Buffer.from(DIFF);
    if (args[0] === 'write-tree') return Buffer.from(`${tree}\n`);
    return Buffer.alloc(0);
  };
}

function reviewer(output) {
  const state = { calls: 0 };
  return {
    state,
    fn: async () => {
      state.calls += 1;
      return { status: 0, stdout: output, stderr: '' };
    },
  };
}

describe('Feature: SubprocessGitAdapter.getIndexTree', () => {
  it('returns a valid object id, and null for garbage or git failure', async () => {
    assert.equal(await new SubprocessGitAdapter(() => Buffer.from(`${TREE}\n`)).getIndexTree('/r'), TREE);
    assert.equal(await new SubprocessGitAdapter(() => Buffer.from('fatal')).getIndexTree('/r'), null);
    assert.equal(await new SubprocessGitAdapter(() => { throw new Error('unmerged'); }).getIndexTree('/r'), null);
  });
});

for (const [label, Cache, runReview] of [
  ['modular', FileSystemVerdictCacheAdapter, modularRunReview],
  ['bundled', BundledCache, bundledRunReview],
]) {
  describe(`Feature: PASS verdict cache adapter (${label})`, () => {
    it('Given a recorded PASS, When the same tree+diff is looked up, Then it hits and returns the absolute report path', async () => {
      const { repo, reports } = await fixture();
      const cache = new Cache({ clock: () => NOW });
      const report = await writeReport(reports, 'r1.md');
      await cache.record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });

      const stored = JSON.parse((await readFile(path.join(repo, CACHE_DIR, 'verdict-cache.jsonl'), 'utf8')).trim());
      assert.equal(stored.reportPath, report);

      const hit = await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH });
      assert.equal(hit.reportPath, report);
      assert.equal(path.isAbsolute(hit.reportPath), true);
      assert.equal(hit.at, NOW.toISOString());
    });

    it('Given a different tree, diff hash, malformed ids, or no cache file, Then it misses', async () => {
      const { repo, reports } = await fixture();
      const cache = new Cache({ clock: () => NOW });
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH }), null);

      const report = await writeReport(reports, 'r1.md');
      await cache.record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: OTHER_TREE, diffHash: HASH }), null);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: OTHER_HASH }), null);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: 'nothex', diffHash: HASH }), null);
      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: 'short' }), null);
    });

    it('Given an entry older than the TTL or dated in the future, Then it misses', async () => {
      const { repo, reports } = await fixture();
      const report = await writeReport(reports, 'r1.md');
      await new Cache({ clock: () => NOW }).record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });
      const key = { repoRoot: repo, treeSha: TREE, diffHash: HASH };

      assert.equal(await new Cache({ clock: () => new Date(NOW.getTime() + 15 * DAY) }).lookup(key), null);
      assert.ok(await new Cache({ clock: () => new Date(NOW.getTime() + 13 * DAY) }).lookup(key));
      assert.equal(await new Cache({ clock: () => new Date(NOW.getTime() - 1000) }).lookup(key), null);
    });

    it('Given a stale index line, Then a missing report, a different hash, a BLOCK report, or a repo-relative path all miss', async () => {
      const { repo, reports } = await fixture();
      const key = { repoRoot: repo, treeSha: TREE, diffHash: HASH };
      const lookupWith = async (lines) => {
        await writeCacheLines(repo, lines);
        return new Cache({ clock: () => NOW }).lookup(key);
      };

      assert.equal(await lookupWith([cacheLine(path.join(reports, 'gone.md'))]), null);

      const wrongHash = await writeReport(reports, 'wrong-hash.md', { hash: OTHER_HASH });
      assert.equal(await lookupWith([cacheLine(wrongHash)]), null);

      const blocked = await writeReport(reports, 'blocked.md', { result: 'BLOCK' });
      assert.equal(await lookupWith([cacheLine(blocked)]), null);

      const relative = path.join(CACHE_DIR, 'ok.md');
      await mkdir(path.join(repo, CACHE_DIR), { recursive: true });
      await writeFile(path.join(repo, relative), `- staged diff hash: ${HASH}\n- result: PASS\n`);
      assert.equal(await lookupWith([cacheLine(relative)]), null);
    });

    it('Given an index line for diff D1 whose PASS report states diff D2, When looked up for D2, Then it misses', async () => {
      const { repo, reports } = await fixture();
      const report = await writeReport(reports, 'd2-report.md', { hash: OTHER_HASH });
      await writeCacheLines(repo, [cacheLine(report)]);

      assert.equal(await new Cache({ clock: () => NOW }).lookup({ repoRoot: repo, treeSha: TREE, diffHash: OTHER_HASH }), null);
    });

    it('Given corrupt JSON lines, other schemas, or a BLOCK verdict, Then those lines are skipped', async () => {
      const { repo, reports } = await fixture();
      const report = await writeReport(reports, 'ok.md');
      const key = { repoRoot: repo, treeSha: TREE, diffHash: HASH };
      const lookup = () => new Cache({ clock: () => NOW }).lookup(key);

      await writeCacheLines(repo, [cacheLine(report, { verdict: 'BLOCK' })]);
      assert.equal(await lookup(), null);

      await writeCacheLines(repo, [cacheLine(report, { schema: 'other@1' })]);
      assert.equal(await lookup(), null);

      await writeCacheLines(repo, ['not json', cacheLine(report)]);
      assert.ok(await lookup());
    });

    it('Given a PASS for one diff, When another diff is looked up, Then the entry never serves it', async () => {
      const { repo, reports } = await fixture();
      const cache = new Cache({ clock: () => NOW });
      const report = await writeReport(reports, 'r1.md');
      await cache.record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: report });

      assert.equal(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: OTHER_HASH }), null);
      assert.ok(await cache.lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH }));
    });

    it('record ignores a malformed tree id and never writes', async () => {
      const { repo, reports } = await fixture();
      await new Cache({ clock: () => NOW }).record({
        repoRoot: repo,
        treeSha: 'xyz',
        diffHash: HASH,
        reportPath: path.join(reports, 'r.md'),
      });
      await assert.rejects(readFile(path.join(repo, CACHE_DIR, 'verdict-cache.jsonl')), /ENOENT/);
    });

    it('Given an entry whose report path is relative, When looked up, Then it misses even though that file is a PASS in the working folder', async () => {
      const { repo, reports } = await fixture();
      const report = await writeReport(reports, 'r1.md');
      const cache = new Cache({ clock: () => NOW });
      const key = { repoRoot: repo, treeSha: TREE, diffHash: HASH };
      const previous = process.cwd();
      process.chdir(reports);
      try {
        await writeCacheLines(repo, [cacheLine(report)]);
        assert.ok(await cache.lookup(key), 'control: the same PASS report by absolute path hits');
        await writeCacheLines(repo, [cacheLine('r1.md')]);
        assert.equal(await cache.lookup(key), null);
      } finally {
        process.chdir(previous);
      }
    });

    it('Given a cache line whose report path is not a string, When looked up, Then it resolves null without throwing', async () => {
      const { repo, reports } = await fixture();
      const report = await writeReport(reports, 'r1.md');
      const cache = new Cache({ clock: () => NOW });
      const key = { repoRoot: repo, treeSha: TREE, diffHash: HASH };
      await writeCacheLines(repo, [cacheLine(42)]);
      assert.equal(await cache.lookup(key), null);
      await writeCacheLines(repo, [cacheLine(report), cacheLine(42)]);
      assert.equal((await cache.lookup(key)).reportPath, report);
    });

    it('Given a PASS recorded by a relative report path, When looked up afresh, Then the hit carries the absolute path', async () => {
      const { repo, reports } = await fixture();
      await writeReport(reports, 'r1.md');
      const previous = process.cwd();
      process.chdir(reports);
      try {
        const folder = process.cwd();
        await new Cache({ clock: () => NOW }).record({ repoRoot: repo, treeSha: TREE, diffHash: HASH, reportPath: 'r1.md' });
        const hit = await new Cache({ clock: () => NOW }).lookup({ repoRoot: repo, treeSha: TREE, diffHash: HASH });
        assert.equal(hit.reportPath, path.join(folder, 'r1.md'));
        assert.equal(path.isAbsolute(hit.reportPath), true);
      } finally {
        process.chdir(previous);
      }
    });
  });

  describe(`Feature: workflow reuses PASS for identical tree+diff (${label})`, () => {
    const run = (fx, tree, omp, extra = {}) => withReportsDir(fx.reports, () => runReview({
      cwd: fx.repo,
      git: fakeGit(fx.repo, tree),
      logger: { log: () => {}, error: () => {} },
      now: NOW,
      omp,
      ...extra,
    }));

    it('Given a PASS, When the identical tree+diff is committed again, Then the reviewer is not invoked and the original report is reported', async () => {
      const fx = await fixture();
      const first = reviewer(PASS);
      const r1 = await run(fx, TREE, first.fn);
      assert.equal(r1.exitCode, 0);
      assert.equal(first.state.calls, 1);
      assert.equal(path.isAbsolute(r1.reportPath), true);
      assert.equal(r1.reportPath.startsWith(fx.repo + path.sep), false, 'the report lives outside the repository');

      const second = reviewer('REVIEW_RESULT=BLOCK\n');
      const events = [];
      const telemetry = { forRun: () => ({ record: async (type, payload) => { events.push({ type, ...payload }); }, updateLastRun: async () => {} }) };
      const r2 = await run(fx, TREE, second.fn, { telemetry });
      assert.equal(r2.exitCode, 0);
      assert.equal(r2.verdict, 'PASS');
      assert.equal(r2.reportPath, r1.reportPath);
      assert.equal(second.state.calls, 0);
      assert.ok(events.some((event) => event.type === 'verdict_cache_hit'));
      assert.ok(events.some((event) => event.type === 'run_finished' && event.cached === true));
    });

    it('Given a PASS for another tree, a BLOCK, or OMP_REVIEW_KIT_CACHE=0, Then the reviewer runs again', async () => {
      const fx = await fixture();
      await run(fx, TREE, reviewer(PASS).fn);

      const otherTree = reviewer(PASS);
      await run(fx, OTHER_TREE, otherTree.fn);
      assert.equal(otherTree.state.calls, 1);

      const previous = process.env.OMP_REVIEW_KIT_CACHE;
      process.env.OMP_REVIEW_KIT_CACHE = '0';
      try {
        const disabled = reviewer(PASS);
        await run(fx, TREE, disabled.fn);
        assert.equal(disabled.state.calls, 1);
      } finally {
        if (previous === undefined) delete process.env.OMP_REVIEW_KIT_CACHE;
        else process.env.OMP_REVIEW_KIT_CACHE = previous;
      }

      const blockFx = await fixture();
      const r1 = await run(blockFx, TREE, reviewer(BLOCK_NO_ENVELOPE).fn);
      assert.equal(r1.exitCode, 1);
      const again = reviewer(BLOCK_NO_ENVELOPE);
      const r2 = await run(blockFx, TREE, again.fn);
      assert.equal(r2.exitCode, 1);
      assert.ok(again.state.calls >= 1, 'a BLOCK is re-reviewed, never cached');
    });

    it('Given a git without a usable tree id, Then caching is skipped and the review runs', async () => {
      const fx = await fixture();
      await run(fx, 'garbage', reviewer(PASS).fn);
      const second = reviewer(PASS);
      await run(fx, 'garbage', second.fn);
      assert.equal(second.state.calls, 1);
    });
  });
}
