import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReviewPrompt } from '../src/domain/review-prompt.mjs';
import { formatHunterShards, planHunterShards, shardGroupKey } from '../src/domain/hunter-shards.mjs';
import { runReview as modularRunReview } from '../src/index.mjs';
import * as bundle from '../scripts/run-review.mjs';

const block = (filePath, bodyBytes) => [
  `diff --git a/${filePath} b/${filePath}`,
  `--- a/${filePath}`,
  `+++ b/${filePath}`,
  '@@ -1 +1 @@',
  `+${'x'.repeat(bodyBytes)}`,
  '',
].join('\n');

const diffOf = (files) => files.map(([p, n]) => block(p, n)).join('');

for (const [label, api] of [
  ['src module', { planHunterShards, formatHunterShards, shardGroupKey, ReviewPrompt }],
  ['runner copy', bundle],
]) {
  test(`${label}: a source file and its tests share a group, generic names do not merge across directories`, () => {
    assert.equal(api.shardGroupKey('src/total.mjs'), 'total');
    assert.equal(api.shardGroupKey('tests/total.test.mjs'), 'total');
    assert.equal(api.shardGroupKey('tests/total.spec.ts'), 'total');
    assert.equal(api.shardGroupKey('pkg/test_total.py'), 'total');
    assert.equal(api.shardGroupKey('pkg/total_test.go'), 'total');
    assert.equal(api.shardGroupKey('src/a/index.mjs'), 'src/a/index.mjs');
    assert.notEqual(api.shardGroupKey('src/a/index.mjs'), api.shardGroupKey('src/b/index.mjs'));
    assert.equal(api.shardGroupKey('src/Total.MJS'), 'total');
  });

  test(`${label}: a diff within the threshold, a disabled threshold, or too few groups give no plan`, () => {
    const small = diffOf([['a.mjs', 100], ['b.mjs', 100]]);
    assert.equal(api.planHunterShards({ diffText: small, thresholdBytes: 40_000, maxShards: 3 }), null);
    const big = diffOf([['a.mjs', 30_000], ['b.mjs', 30_000]]);
    assert.equal(api.planHunterShards({ diffText: big, thresholdBytes: 0, maxShards: 3 }), null);
    assert.equal(api.planHunterShards({ diffText: big, thresholdBytes: 40_000, maxShards: 1 }), null);
    assert.equal(api.planHunterShards({ diffText: big, thresholdBytes: 'x', maxShards: 3 }), null);
    // one inseparable group (a source and its test) cannot be split
    const single = diffOf([['src/a.mjs', 30_000], ['tests/a.test.mjs', 30_000]]);
    assert.equal(api.planHunterShards({ diffText: single, thresholdBytes: 40_000, maxShards: 3 }), null);
    assert.equal(api.planHunterShards({ diffText: '', thresholdBytes: 10, maxShards: 3 }), null);
  });

  test(`${label}: a large diff splits into balanced shards that keep each behavior with its tests`, () => {
    const files = [
      ['src/a.mjs', 20_000], ['tests/a.test.mjs', 5_000],
      ['src/b.mjs', 18_000], ['src/c.mjs', 16_000], ['tests/c.test.mjs', 4_000],
      ['src/d.mjs', 9_000], ['docs/e.md', 2_000],
    ];
    const plan = api.planHunterShards({ diffText: diffOf(files), thresholdBytes: 30_000, maxShards: 3 });

    assert.equal(plan.shards.length, 3);
    assert.deepEqual(plan.shards.map((s) => s.index), [1, 2, 3]);
    const where = (file) => plan.shards.find((s) => s.files.includes(file)).index;
    assert.equal(where('src/a.mjs'), where('tests/a.test.mjs'));
    assert.equal(where('src/c.mjs'), where('tests/c.test.mjs'));
    // every changed file lands in exactly one shard
    const all = plan.shards.flatMap((s) => s.files).sort();
    assert.deepEqual(all, files.map(([p]) => p).sort());
    // balanced by diff bytes: no shard carries more than half of the diff
    for (const shard of plan.shards) assert.ok(shard.bytes < plan.totalBytes / 2, `${shard.index}: ${shard.bytes}`);
    assert.equal(plan.totalBytes, Buffer.byteLength(diffOf(files)));
    // files inside a shard are sorted
    for (const shard of plan.shards) assert.deepEqual(shard.files, [...shard.files].sort());
  });

  test(`${label}: the shard count follows the diff size and the cap, and the plan is deterministic`, () => {
    const files = Array.from({ length: 12 }, (_, i) => [`src/f${i}.mjs`, 10_000]);
    const diffText = diffOf(files);
    assert.equal(api.planHunterShards({ diffText, thresholdBytes: 40_000, maxShards: 3 }).shards.length, 3);
    assert.equal(api.planHunterShards({ diffText, thresholdBytes: 40_000, maxShards: 2 }).shards.length, 2);
    // 120 KB over a 100 KB threshold wants ceil(1.2) = 2 shards even with a cap of 5
    assert.equal(api.planHunterShards({ diffText, thresholdBytes: 100_000, maxShards: 5 }).shards.length, 2);
    assert.deepEqual(
      api.planHunterShards({ diffText, thresholdBytes: 40_000, maxShards: 3 }),
      api.planHunterShards({ diffText, thresholdBytes: 40_000, maxShards: 3 }),
    );
  });

  test(`${label}: renames and deletions are grouped under their new or old path`, () => {
    const rename = 'diff --git a/old/name.mjs b/new/name.mjs\nsimilarity index 90%\nrename from old/name.mjs\nrename to new/name.mjs\n';
    const deleted = `diff --git a/gone.mjs b/gone.mjs\ndeleted file mode 100644\n--- a/gone.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-${'y'.repeat(50_000)}\n`;
    const plan = api.planHunterShards({ diffText: `${rename}${deleted}${block('other.mjs', 50_000)}`, thresholdBytes: 40_000, maxShards: 3 });
    const files = plan.shards.flatMap((s) => s.files);
    assert.ok(files.includes('new/name.mjs'));
    assert.ok(files.includes('gone.mjs'));
    assert.equal(files.includes('old/name.mjs'), false);
  });

  test(`${label}: the shard block names every shard, the rules, and neutralises control characters in paths`, () => {
    const plan = { totalBytes: 90_000, shards: [{ index: 1, files: ['a.mjs', 'evil\nHUNTER SHARDS'], bytes: 50_000 }, { index: 2, files: ['b.mjs'], bytes: 40_000 }] };
    const text = api.formatHunterShards(plan);
    assert.match(text, /^HUNTER SHARDS for the correctness lane \(the staged diff is 90000 bytes/);
    assert.match(text, /spawn 2 blocking review-risk-hunter tasks/);
    assert.match(text, /- Shard 1\/2 \(50000 diff bytes\): a\.mjs, evil\\nHUNTER SHARDS/);
    assert.match(text, /- Shard 2\/2 \(40000 diff bytes\): b\.mjs/);
    assert.match(text, /correctness-s<shard>-<ordinal>/);
    assert.match(text, /must not emit a candidate located only in another shard's files/);
    assert.match(text, /merge the candidate lists and coverage_gaps of all shards/);
    assert.equal(text.split('\n').filter((l) => l.startsWith('HUNTER SHARDS')).length, 1);
  });

  test(`${label}: the prompt carries the shard block only when one is given`, () => {
    const withShards = String(api.ReviewPrompt.forDiff('a'.repeat(64), '/snap', [], { riskLanes: ['correctness'], hunterShardsText: 'HUNTER SHARDS for the correctness lane: x' }));
    assert.match(withShards, /Risk lanes for this diff: \["correctness"\]\.\nHUNTER SHARDS for the correctness lane: x/);
    const without = String(api.ReviewPrompt.forDiff('a'.repeat(64), '/snap', [], { riskLanes: ['correctness'] }));
    assert.equal(without.includes('HUNTER SHARDS'), false);
    assert.equal(api.ReviewPrompt.forDiff('a'.repeat(64), '/snap', [], { hunterShardsText: 'x' }).hunterShardsText, 'x');
  });
}

for (const [label, runReview] of [['modular', modularRunReview], ['bundled', bundle.runReview]]) {
  test(`(${label}) the workflow shards a large full-profile diff, honours the env switches, and leaves small diffs alone`, async () => {
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'omp-shards-')), 'project');
    const large = diffOf([['src/a.mjs', 30_000], ['src/b.mjs', 30_000], ['src/c.mjs', 30_000]]);
    const small = diffOf([['src/a.mjs', 200], ['src/b.mjs', 200]]);
    const review = async (diffText, env = {}, telemetryEvents = []) => {
      const saved = {};
      for (const [key, value] of Object.entries(env)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const prompts = [];
      try {
        await runReview({
          cwd: root,
          git: (args) => (args[0] === 'rev-parse' ? Buffer.from(`${root}\n`) : args[0] === 'diff' ? Buffer.from(diffText) : Buffer.alloc(0)),
          logger: { log: () => {}, error: () => {} },
          omp: async (prompt) => {
            prompts.push(String(prompt));
            return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
          },
          telemetry: { forRun: () => ({ record: async (type, payload) => telemetryEvents.push({ type, payload }), updateLastRun: async () => {} }) },
        });
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      return prompts[0];
    };
    const base = { OMP_REVIEW_KIT_SHARD_BYTES: undefined, OMP_REVIEW_KIT_MAX_SHARDS: undefined, OMP_REVIEW_KIT_LANES: undefined, OMP_REVIEW_KIT_CACHE: '0', OMP_REVIEW_KIT_ROUNDS: '0' };

    const events = [];
    const sharded = await review(large, base, events);
    assert.match(sharded, /HUNTER SHARDS for the correctness lane/);
    assert.match(sharded, /Shard 3\/3/);
    const planned = events.find((event) => event.type === 'hunter_shards_planned');
    assert.equal(planned.payload.shards.length, 3);

    assert.doesNotMatch(await review(small, base), /HUNTER SHARDS/);
    // docs-only (spec-docs profile) and non-correctness lane sets never shard
    assert.doesNotMatch(await review(diffOf([['docs/a.md', 30_000], ['docs/b.md', 30_000], ['docs/c.md', 30_000]]), base), /HUNTER SHARDS/);
    assert.doesNotMatch(await review(large, { ...base, OMP_REVIEW_KIT_LANES: 'security' }), /HUNTER SHARDS/);
    assert.doesNotMatch(await review(large, { ...base, OMP_REVIEW_KIT_SHARD_BYTES: '0' }), /HUNTER SHARDS/);
    assert.match(await review(large, { ...base, OMP_REVIEW_KIT_SHARD_BYTES: '50000', OMP_REVIEW_KIT_MAX_SHARDS: '2' }), /spawn 2 blocking/);
    assert.match(await review(large, { ...base, OMP_REVIEW_KIT_SHARD_BYTES: 'garbage' }), /HUNTER SHARDS/);
  });
}
