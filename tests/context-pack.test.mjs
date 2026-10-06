import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildContextPack, changedSymbols } from '../src/domain/context-pack.mjs';
import { ReviewPrompt } from '../src/domain/review-prompt.mjs';
import { runReview as modularRunReview } from '../src/index.mjs';
import * as runner from '../scripts/run-review.mjs';

const file = (filePath, text) => ({ path: filePath, content: Buffer.from(text) });

const SOURCE = [
  'export function computeTotal(items) {',
  '  return items.length;',
  '}',
  '',
].join('\n');

const DIFF = [
  'diff --git a/src/total.mjs b/src/total.mjs',
  'index 111..222 100644',
  '--- a/src/total.mjs',
  '+++ b/src/total.mjs',
  '@@ -1,3 +1,3 @@ export function computeTotal(items) {',
  '-  return items.length + 1;',
  '+  return items.length;',
  '+export function renamedHelper(value) {',
  'diff --git a/src/gone.mjs b/src/gone.mjs',
  'deleted file mode 100644',
  'index 333..000',
  '--- a/src/gone.mjs',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export class RemovedThing {',
  '-}',
  '',
].join('\n');

const FILES = [
  file('src/total.mjs', SOURCE),
  file('src/caller.mjs', "import { computeTotal } from './total.mjs';\nexport const run = () => computeTotal([1]);\n"),
  file('tests/total.test.mjs', "import { computeTotal } from '../src/total.mjs';\ntest('total', () => computeTotal([]));\n"),
  file('tests/unrelated.test.mjs', "test('other', () => 1);\n"),
  file('assets/logo.bin', '\u0000computeTotal binary'),
  file('.review/diff.patch', 'computeTotal in a planted review file\n'),
];

for (const [label, api] of [['src module', { buildContextPack, changedSymbols }], ['runner copy', runner]]) {
  test(`${label}: symbols come from added and removed declarations and from hunk scope headers`, () => {
    const symbols = api.changedSymbols(DIFF);
    const names = symbols.map((s) => s.name);
    assert.deepEqual(names, ['renamedHelper', 'RemovedThing', 'computeTotal']);
    assert.equal(symbols.find((s) => s.name === 'computeTotal').path, 'src/total.mjs');
    assert.equal(symbols.find((s) => s.name === 'RemovedThing').path, 'src/gone.mjs');
  });

  test(`${label}: short names and generic words are not symbols`, () => {
    const diff = [
      'diff --git a/x.mjs b/x.mjs',
      '--- a/x.mjs',
      '+++ b/x.mjs',
      '@@ -1 +1 @@',
      '+const abc = 1;',
      '+function main() {',
      '+const result = 2;',
      '+const realName = 3;',
      '',
    ].join('\n');
    assert.deepEqual(api.changedSymbols(diff).map((s) => s.name), ['realName']);
  });

  test(`${label}: symbol list is capped`, () => {
    const body = Array.from({ length: 80 }, (_, i) => `+function generated${String(i).padStart(3, '0')}() {`).join('\n');
    const diff = `diff --git a/g.mjs b/g.mjs\n--- a/g.mjs\n+++ b/g.mjs\n@@ -0,0 +1,80 @@\n${body}\n`;
    assert.equal(api.changedSymbols(diff).length, 40);
  });

  test(`${label}: Given a staged change, Then the pack lists changed files, references from other files, and the test mapping`, () => {
    const { text, stats } = api.buildContextPack({
      files: FILES,
      diffText: DIFF,
      changedPaths: ['src/total.mjs', 'src/gone.mjs'],
      fileClasses: [{ path: 'src/total.mjs', fileClass: 'executable' }],
    });

    assert.match(text, /^# Review context pack/);
    assert.match(text, /\| `src\/total\.mjs` \| executable \| present \| \+2 \/ -1 \| 4 \|/);
    assert.match(text, /\| `src\/gone\.mjs` \| - \| deleted \| \+0 \/ -2 \| - \|/);
    // callers outside the declaring file, with line numbers
    assert.match(text, /`computeTotal` \(declared in `src\/total\.mjs`\): \d+ reference\(s\) in 3 file\(s\)/);
    assert.match(text, /`src\/caller\.mjs:1` import \{ computeTotal \}/);
    assert.match(text, /test `tests\/total\.test\.mjs:1`/);
    // the declaring file itself is not listed as its own caller
    assert.equal(/`src\/total\.mjs:\d+`/.test(text), false);
    // test mapping by stem or symbol, unrelated tests excluded
    assert.match(text, /`src\/total\.mjs` is referenced by: `tests\/total\.test\.mjs` \(via `total`\)/);
    assert.equal(text.includes('unrelated.test.mjs'), false);
    assert.match(text, /`src\/gone\.mjs`: no test file in the snapshot mentions it/);
    assert.equal(stats.symbols, 3);
    assert.equal(stats.truncated, false);
  });

  test(`${label}: Given binary files and planted .review files, Then they are never scanned`, () => {
    const { text } = api.buildContextPack({ files: FILES, diffText: DIFF, changedPaths: ['src/total.mjs'] });
    assert.equal(text.includes('planted review file'), false);
    assert.equal(text.includes('logo.bin'), false);
  });

  test(`${label}: Given identical input, Then the pack is byte-identical`, () => {
    const input = { files: FILES, diffText: DIFF, changedPaths: ['src/total.mjs', 'src/gone.mjs'] };
    assert.equal(api.buildContextPack(input).text, api.buildContextPack(input).text);
  });

  test(`${label}: Given a symbol referenced from many files, Then only five hits are shown per kind and the total stays exact`, () => {
    const callers = Array.from({ length: 9 }, (_, i) => file(`src/c${i}.mjs`, `computeTotal(${i});\n`));
    const { text } = api.buildContextPack({ files: [...FILES, ...callers], diffText: DIFF, changedPaths: ['src/total.mjs'] });
    assert.match(text, /\(declared in `src\/total\.mjs`\): 14 reference\(s\) in 12 file\(s\)/);
    assert.equal((text.match(/^ {2}- `src\//gm) ?? []).length, 5);
    // one hit per file even when a file mentions the symbol twice
    assert.equal((text.match(/`src\/caller\.mjs:/g) ?? []).length, 1);
  });

  test(`${label}: Given an oversized pack, Then it is cut with a visible marker`, () => {
    const manyPaths = Array.from({ length: 3000 }, (_, i) => `src/generated/file-${i}.mjs`);
    const { text, stats } = api.buildContextPack({ files: [], diffText: '', changedPaths: manyPaths });
    assert.equal(stats.truncated, true);
    assert.match(text, /\[context pack truncated at 60000 characters\]/);
  });

  test(`${label}: Given a file over 400 KB, Then it is skipped as unscannable`, () => {
    const big = file('src/huge.mjs', `computeTotal();\n${'x'.repeat(400 * 1024)}`);
    const { text } = api.buildContextPack({ files: [...FILES, big], diffText: DIFF, changedPaths: ['src/total.mjs', 'src/huge.mjs'] });
    assert.match(text, /\| `src\/huge\.mjs` \| - \| binary-or-large \|/);
    assert.equal(text.includes('src/huge.mjs:1'), false);
  });
}

for (const [label, Prompt] of [['src module', ReviewPrompt], ['runner copy', runner.ReviewPrompt]]) test(`${label}: ReviewPrompt names the context pack only when one exists`, () => {
  const withPack = String(Prompt.forDiff('a'.repeat(64), '/snap', ['src/a.mjs'], { contextPackPath: '/tmp/pack.md' }));
  assert.match(withPack, /deterministic context pack for the scout is at `\/tmp\/pack\.md`/);
  assert.match(withPack, /Pass that path to the context scout in its task text/);
  const without = String(Prompt.forDiff('a'.repeat(64), '/snap', ['src/a.mjs'], { contextPackPath: '' }));
  assert.equal(without.includes('context pack'), false);
  assert.equal(Prompt.forDiff('a'.repeat(64), '/snap', [], { contextPackPath: '/tmp/pack.md' }).contextPackPath, '/tmp/pack.md');
});

for (const [label, runReview] of [['modular', modularRunReview], ['bundled', runner.runReview]]) test(`(${label}) the workflow writes the pack for the review and removes it afterwards`, async () => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'omp-pack-')), 'project');
  const git = (args) => {
    if (args[0] === 'rev-parse') return Buffer.from(`${root}\n`);
    if (args[0] === 'diff') return Buffer.from(DIFF);
    return Buffer.alloc(0);
  };
  const events = [];
  let packPath = null;
  let packDuringReview = '';
  const result = await runReview({
    cwd: root,
    git,
    omp: async (prompt) => {
      packPath = /context pack for the scout is at `([^`]+)`/.exec(String(prompt))?.[1] ?? null;
      packDuringReview = packPath ? await readFile(packPath, 'utf8') : '';
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
    telemetry: {
      forRun: () => ({
        record: async (type, payload) => events.push({ type, payload }),
        updateLastRun: async () => {},
      }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.ok(packPath, 'prompt carries the pack path');
  assert.match(path.basename(packPath), /^reviewer-kit-report-ctx-.*-\d+\.md$/);
  assert.match(packDuringReview, /^# Review context pack/);
  assert.match(packDuringReview, /src\/total\.mjs/);
  await assert.rejects(access(packPath));
  assert.ok(events.some((event) => event.type === 'context_pack_built' && event.payload.symbols === 3));
});
