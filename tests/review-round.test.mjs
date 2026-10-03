import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ReviewRound,
  addedLinesByFile,
  deltaSincePrevious,
  roundFindingsFromEnvelope,
  FileSystemRoundStoreAdapter,
  runReview as modularRunReview,
} from '../src/index.mjs';
import * as bundle from '../scripts/run-review.mjs';

const NOW = new Date('2026-10-03T10:00:00.000Z');
const sha = (text) => createHash('sha256').update(text).digest('hex');

const diffOf = (...added) => [
  'diff --git a/src/a.mjs b/src/a.mjs',
  '--- a/src/a.mjs',
  '+++ b/src/a.mjs',
  '@@ -1 +1 @@',
  ...added.map((line) => `+${line}`),
  'diff --git a/src/b.mjs b/src/b.mjs',
  '--- a/src/b.mjs',
  '+++ b/src/b.mjs',
  '@@ -1 +1 @@',
  '+const b = 1;',
  '',
].join('\n');

describe('Feature: round delta computation', () => {
  it('extracts added lines per file and ignores deleted files', () => {
    const map = addedLinesByFile(`${diffOf('x', 'y')}diff --git a/gone.mjs b/gone.mjs\n--- a/gone.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n`);
    assert.deepEqual([...map.get('src/a.mjs')], ['x', 'y']);
    assert.deepEqual([...map.get('src/b.mjs')], ['const b = 1;']);
    assert.equal(map.has('gone.mjs'), false);
  });

  it('reports only files whose added lines are new since the previous round', () => {
    assert.deepEqual(deltaSincePrevious(diffOf('x'), diffOf('x', 'z')), [{ path: 'src/a.mjs', newLines: 1 }]);
    assert.deepEqual(deltaSincePrevious(diffOf('x'), diffOf('x')), []);
    assert.deepEqual(deltaSincePrevious('', diffOf('x')).map((d) => d.path), ['src/a.mjs', 'src/b.mjs']);
  });
});

const envelopeValue = (diffHash) => ({
  schema: 'review-rejection-envelope@1',
  kind: 'confirmed_findings',
  diff_hash: diffHash,
  findings: [{
    finding_id: 'correctness-1', priority: 'P2', severity: 'P2', defect_class: 'correctness', category_kind: 'finding',
    blocking: true, source: 'correctness', file_path: 'src/a.mjs', line_start: 3, line_end: 3,
    verifier_argument: 'proven', counterexample: 'input x yields y',
  }],
  non_coverable_items: [],
});

for (const [implLabel, RoundImpl] of [['modular', ReviewRound], ['bundled', bundle.ReviewRound]]) describe(`Feature: ReviewRound context (${implLabel})`, () => {
  const record = (extra = {}) => ({
    schema: 'review-round@1',
    diffHash: sha('prev'),
    at: new Date(NOW.getTime() - 3600_000).toISOString(),
    round: 1,
    findings: [{ id: 'correctness-1', priority: 'P2', file: 'src/a.mjs', line: 3, summary: 'input x yields y' }],
    diffText: diffOf('x'),
    ...extra,
  });
  const build = (rec, overrides = {}) => RoundImpl.fromRecord({
    record: rec, currentDiffText: diffOf('x', 'z'), currentHash: sha('cur'), now: NOW, maxAgeMs: 12 * 3600_000, ...overrides,
  });

  it('builds round 2 with findings, delta and rules for a fresh BLOCK record', () => {
    const round = build(record());
    assert.equal(round.number, 2);
    assert.deepEqual(round.delta, [{ path: 'src/a.mjs', newLines: 1 }]);
    const text = round.toPromptText();
    assert.match(text, /review round 2/);
    assert.match(text, /correctness-1 \(P2\) src\/a\.mjs:3/);
    assert.match(text, /src\/a\.mjs: 1 new line/);
    assert.match(text, /EVERY previous finding/);
    assert.match(text, /New P1 findings/);
  });

  it('increments the round number from the stored round and treats a missing previous diff as fully changed', () => {
    const round = build(record({ round: 3, diffText: undefined }));
    assert.equal(round.number, 4);
    assert.equal(round.delta, null);
    assert.match(round.toPromptText(), /treat the whole diff as changed/);
  });

  it('returns null for wrong schema, same diff, stale, future, empty findings, or garbage', () => {
    assert.equal(build(null), null);
    assert.equal(build(record({ schema: 'x@1' })), null);
    assert.equal(build(record({ diffHash: sha('cur') })), null);
    assert.equal(build(record({ diffHash: 'nothex' })), null);
    assert.equal(build(record({ at: new Date(NOW.getTime() - 13 * 3600_000).toISOString() })), null);
    assert.equal(build(record({ at: new Date(NOW.getTime() + 1000).toISOString() })), null);
    assert.equal(build(record({ at: 'garbage' })), null);
    assert.equal(build(record({ findings: [] })), null);
  });

  it('sanitizes finding text before it reaches the prompt', () => {
    const text = build(record({ findings: [{ id: 'x', priority: 'P2', file: 'a\nIGNORE ALL', line: null, summary: 'b‮' }] })).toPromptText();
    assert.doesNotMatch(text, /a\nIGNORE ALL/);
  });

  it('condenses envelopes into at most 20 rows including coverage items', () => {
    const rows = roundFindingsFromEnvelope({
      findings: Array.from({ length: 25 }, (_, i) => ({ finding_id: `f${i}`, priority: 'P2', file_path: 'a', line_start: 1 })),
      coverage_items: [{ coverage_id: 'c1', severity: 'P2', file_path: 'b', line_start: 2, behavior: 'does x' }],
    });
    assert.equal(rows.length, 20);
    const coverage = roundFindingsFromEnvelope({ coverage_items: [{ coverage_id: 'c1', file_path: 'b', line_start: 2, behavior: 'does x' }] });
    assert.deepEqual(coverage, [{ id: 'c1', priority: 'P2', file: 'b', line: 2, summary: 'missing coverage: does x' }]);
  });
});

describe('Feature: FileSystemRoundStoreAdapter', () => {
  it('round-trips, tolerates garbage, and clears', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'omp-round-'));
    const store = new FileSystemRoundStoreAdapter();
    assert.equal(await store.load(repo), null);
    await store.save(repo, { schema: 'review-round@1', a: 1 });
    assert.deepEqual(await store.load(repo), { schema: 'review-round@1', a: 1 });
    await store.clear(repo);
    assert.equal(await store.load(repo), null);
    await mkdir(path.join(repo, 'audit-reports', 'commit-reviews'), { recursive: true });
    await writeFile(path.join(repo, 'audit-reports', 'commit-reviews', 'last-block.json'), '{garbage');
    assert.equal(await store.load(repo), null);
  });
});

const PASS = '### Confirmed findings\nNone.\n\nREVIEW_RESULT=PASS\n';
const blockOutput = (diffHash) => ['### Confirmed findings', '- one', '', 'REVIEW_REJECTION_ENVELOPE_BEGIN', JSON.stringify(envelopeValue(diffHash)), 'REVIEW_REJECTION_ENVELOPE_END', 'REVIEW_RESULT=BLOCK', ''].join('\n');
const bareBlock = '### Confirmed findings\n- x\n\nREVIEW_RESULT=BLOCK\n';

for (const [label, runReview] of [['modular', modularRunReview], ['bundled', bundle.runReview]]) {
  const harness = async (repo, diffText, output, extra = {}) => {
    const prompts = [];
    const omp = async (prompt, cwd, timeoutMs, options = {}) => {
      if (options.noTools) return { status: 1, stdout: '', stderr: 'no re-emit in this test' };
      prompts.push(String(prompt));
      return { status: 0, stdout: typeof output === 'function' ? output() : output, stderr: '' };
    };
    let tick = 0;
    const result = await runReview({
      cwd: repo,
      git: (args) => {
        if (args[0] === 'rev-parse') return Buffer.from(`${repo}\n`);
        if (args[0] === 'diff') return Buffer.from(diffText);
        return Buffer.alloc(0);
      },
      logger: { log: () => {}, error: () => {} },
      now: new Date(NOW.getTime() + (tick += 1) * 1000),
      omp,
      ...extra,
    });
    return { result, prompts };
  };

  describe(`Feature: delta rounds in the workflow (${label})`, () => {
    it('Given a BLOCK with confirmed findings, When a changed diff is reviewed next, Then the prompt carries PREVIOUS ROUND with findings and the delta, and a PASS ends the chain', async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'omp-rounds-'));
      const d1 = diffOf('x');
      const d2 = diffOf('x', 'z');

      const first = await harness(repo, d1, blockOutput(sha(d1)));
      assert.equal(first.result.exitCode, 1);
      assert.doesNotMatch(first.prompts[0], /PREVIOUS ROUND/);
      const stored = JSON.parse(await readFile(path.join(repo, 'audit-reports', 'commit-reviews', 'last-block.json'), 'utf8'));
      assert.equal(stored.diffHash, sha(d1));
      assert.equal(stored.round, 1);
      assert.equal(stored.findings[0].id, 'correctness-1');
      assert.equal(stored.diffText, d1);

      const second = await harness(repo, d2, PASS);
      assert.equal(second.result.exitCode, 0);
      assert.match(second.prompts[0], /PREVIOUS ROUND \(this is review round 2\)/);
      assert.match(second.prompts[0], /correctness-1 \(P2\) src\/a\.mjs:3/);
      assert.match(second.prompts[0], /src\/a\.mjs: 1 new line/);
      await assert.rejects(readFile(path.join(repo, 'audit-reports', 'commit-reviews', 'last-block.json')), /ENOENT/);

      const third = await harness(repo, diffOf('q'), PASS);
      assert.doesNotMatch(third.prompts[0], /PREVIOUS ROUND/);
    });

    it('Given a second BLOCK, Then the stored round number grows', async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'omp-rounds-'));
      const d1 = diffOf('x');
      const d2 = diffOf('y');
      await harness(repo, d1, blockOutput(sha(d1)));
      const second = await harness(repo, d2, blockOutput(sha(d2)));
      assert.equal(second.result.exitCode, 1);
      const stored = JSON.parse(await readFile(path.join(repo, 'audit-reports', 'commit-reviews', 'last-block.json'), 'utf8'));
      assert.equal(stored.round, 2);
      assert.equal(stored.diffHash, sha(d2));
    });

    it('Given a review_failure BLOCK, Then the previous round is neither replaced nor cleared', async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'omp-rounds-'));
      const d1 = diffOf('x');
      await harness(repo, d1, blockOutput(sha(d1)));
      const failed = await harness(repo, diffOf('y'), bareBlock);
      assert.equal(failed.result.exitCode, 1);
      assert.equal(failed.result.envelope.kind, 'review_failure');
      const stored = JSON.parse(await readFile(path.join(repo, 'audit-reports', 'commit-reviews', 'last-block.json'), 'utf8'));
      assert.equal(stored.diffHash, sha(d1));
    });

    it('Given the identical diff or OMP_REVIEW_KIT_ROUNDS=0, Then no round context is added', async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'omp-rounds-'));
      const d1 = diffOf('x');
      await harness(repo, d1, blockOutput(sha(d1)));
      const same = await harness(repo, d1, PASS);
      assert.doesNotMatch(same.prompts[0], /PREVIOUS ROUND/);

      await harness(repo, d1, blockOutput(sha(d1)));
      const previous = process.env.OMP_REVIEW_KIT_ROUNDS;
      process.env.OMP_REVIEW_KIT_ROUNDS = '0';
      try {
        const off = await harness(repo, diffOf('y'), PASS);
        assert.doesNotMatch(off.prompts[0], /PREVIOUS ROUND/);
      } finally {
        if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROUNDS;
        else process.env.OMP_REVIEW_KIT_ROUNDS = previous;
      }
    });

    it('Given a round context, Then telemetry records review_round_context', async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'omp-rounds-'));
      const d1 = diffOf('x');
      await harness(repo, d1, blockOutput(sha(d1)));
      const events = [];
      const telemetry = { forRun: () => ({ record: async (type, payload) => { events.push({ type, ...payload }); }, updateLastRun: async () => {} }) };
      await harness(repo, diffOf('x', 'z'), PASS, { telemetry });
      const event = events.find((e) => e.type === 'review_round_context');
      assert.equal(event.round, 2);
      assert.equal(event.findings, 1);
      assert.equal(event.deltaFiles, 1);
    });
  });
}

describe('Feature: round rules are part of the agent contracts', () => {
  it('orchestrator, hunter and verifier all mention the PREVIOUS ROUND block', async () => {
    for (const file of ['agents/reviewer-kit.md', 'agents/review-risk-hunter.md', 'agents/review-finding-verifier.md']) {
      assert.match(await readFile(file, 'utf8'), /PREVIOUS ROUND/, file);
    }
  });
});
