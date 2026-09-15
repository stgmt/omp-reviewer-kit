import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SuspicionMap,
  isTestPath,
  parseDiffBlocks,
  DEFAULT_ASSERT_PATTERNS,
  DEFAULT_TEST_PATH_PATTERNS,
  DEFAULT_TEST_DECLARATION_PATTERNS,
} from '../src/domain/suspicion-map.mjs';

describe('Feature: Deterministic Suspicion Map', () => {
  describe('isTestPath', () => {
    it('identifies standard test paths across ecosystems', () => {
      assert.equal(isTestPath('tests/unit.mjs'), true);
      assert.equal(isTestPath('test/unit.mjs'), true);
      assert.equal(isTestPath('src/__tests__/app.ts'), true);
      assert.equal(isTestPath('spec/service_spec.rb'), true);
      assert.equal(isTestPath('src/domain/calc.test.js'), true);
      assert.equal(isTestPath('src/domain/calc.spec.js'), true);
      assert.equal(isTestPath('pkg/server/handler_test.go'), true);
      assert.equal(isTestPath('tests/test_model.py'), true);
      assert.equal(isTestPath('sub/test_feature.py'), true);
    });

    it('rejects non-test production source paths', () => {
      assert.equal(isTestPath('src/domain/service.mjs'), false);
      assert.equal(isTestPath('lib/testing-utility.mjs'), false);
      assert.equal(isTestPath('contest/entry.mjs'), false);
      assert.equal(isTestPath('attest/identity.mjs'), false);
    });

    it('accepts custom path patterns', () => {
      assert.equal(isTestPath('fixtures/mock.json', ['^fixtures/']), true);
      assert.equal(isTestPath('tests/foo.js', ['^fixtures/']), false);
    });
  });

  describe('parseDiffBlocks', () => {
    it('parses git diff hunks and extracts added and removed lines', () => {
      const diff = [
        'diff --git a/tests/foo.test.mjs b/tests/foo.test.mjs',
        'index 1111111..2222222 100644',
        '--- a/tests/foo.test.mjs',
        '+++ b/tests/foo.test.mjs',
        '@@ -1,3 +1,3 @@',
        '-assert.equal(a, 1);',
        '+assert.equal(a, 2);',
        '+assert.equal(b, 3);',
        ' const kept = true;',
      ].join('\n');

      const blocks = parseDiffBlocks(diff);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].path, 'tests/foo.test.mjs');
      assert.equal(blocks[0].deleted, false);
      assert.deepEqual(blocks[0].addedLines, ['assert.equal(a, 2);', 'assert.equal(b, 3);']);
      assert.deepEqual(blocks[0].removedLines, ['assert.equal(a, 1);']);
    });

    it('detects deleted files', () => {
      const diff = [
        'diff --git a/tests/legacy.test.mjs b/tests/legacy.test.mjs',
        'deleted file mode 100644',
        'index 1111111..0000000',
        '--- a/tests/legacy.test.mjs',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-test("old", () => {});',
        '-assert.ok(true);',
      ].join('\n');

      const blocks = parseDiffBlocks(diff);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].path, 'tests/legacy.test.mjs');
      assert.equal(blocks[0].deleted, true);
      assert.equal(blocks[0].removedLines.length, 2);
    });

    it('handles quoted paths with octal/escapes', () => {
      const diff = [
        String.raw`diff --git "a/tests/\320\277\321\200\320\276\320\262\320\265\321\200\320\272\320\260.test.mjs" "b/tests/\320\277\321\200\320\276\320\262\320\265\321\200\320\272\320\260.test.mjs"`,
        String.raw`--- "a/tests/\320\277\321\200\320\276\320\262\320\265\321\200\320\272\320\260.test.mjs"`,
        String.raw`+++ "b/tests/\320\277\321\200\320\276\320\262\320\265\321\200\320\272\320\260.test.mjs"`,
        '@@ -1 +1 @@',
        '-assert.ok(false);',
        '+assert.ok(true);',
      ].join('\n');

      const blocks = parseDiffBlocks(diff);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].path, 'tests/проверка.test.mjs');
    });

    it('skips binary files', () => {
      const diff = [
        'diff --git a/fixtures/image.png b/fixtures/image.png',
        'Binary files a/fixtures/image.png and b/fixtures/image.png differ',
      ].join('\n');

      const blocks = parseDiffBlocks(diff);
      assert.equal(blocks.length, 0);
    });
  });

  describe('SuspicionMap.compute', () => {
    it('returns empty map for empty diff or empty buffer', () => {
      const map = SuspicionMap.compute({ diffBytes: Buffer.alloc(0) });
      assert.equal(map.isEmpty, true);
      assert.deepEqual(map.entries, []);
      assert.equal(
        map.toPromptText(),
        'Deterministic suspicion map: no test-file assert deltas, deletions, or removed test declarations detected.'
      );
    });

    it('ignores non-test files even if they contain assert strings', () => {
      const diff = [
        'diff --git a/src/service.mjs b/src/service.mjs',
        '--- a/src/service.mjs',
        '+++ b/src/service.mjs',
        '@@ -1,2 +1 @@',
        '-assert(param !== null);',
        '+// no assert',
      ].join('\n');

      const map = SuspicionMap.compute({ diffBytes: Buffer.from(diff) });
      assert.equal(map.isEmpty, true);
      assert.equal(map.entries.length, 0);
    });

    it('computes assert deltas for test files', () => {
      const diff = [
        'diff --git a/tests/foo.test.mjs b/tests/foo.test.mjs',
        '--- a/tests/foo.test.mjs',
        '+++ b/tests/foo.test.mjs',
        '@@ -1,5 +1,3 @@',
        '-assert.equal(a, 1);',
        '-assert.equal(b, 2);',
        '-expect(c).toBe(3);',
        '+assert.equal(a, 10);',
      ].join('\n');

      const map = SuspicionMap.compute({ diffBytes: Buffer.from(diff) });
      assert.equal(map.isEmpty, false);
      const entry = map.entries.find((e) => e.kind === 'assert_delta');
      assert.ok(entry);
      assert.equal(entry.path, 'tests/foo.test.mjs');
      assert.equal(entry.added, 1);
      assert.equal(entry.removed, 3);
      assert.equal(entry.net, -2);
      assert.ok(map.toPromptText().includes('- tests/foo.test.mjs: assert lines +1/-3 (net -2)'));
    });

    it('detects deleted test files and formats line count', () => {
      const removedLines = Array.from({ length: 340 }, (_, i) => `-line ${i}`).join('\n');
      const diff = [
        'diff --git a/tests/bar.test.mjs b/tests/bar.test.mjs',
        'deleted file mode 100644',
        '--- a/tests/bar.test.mjs',
        '+++ /dev/null',
        '@@ -1,340 +0,0 @@',
        removedLines,
      ].join('\n');

      const map = SuspicionMap.compute({ diffBytes: Buffer.from(diff) });
      assert.equal(map.isEmpty, false);
      const entry = map.entries.find((e) => e.kind === 'deleted_test_file');
      assert.ok(entry);
      assert.equal(entry.path, 'tests/bar.test.mjs');
      assert.equal(entry.removed, 340);
      assert.ok(map.toPromptText().includes('- tests/bar.test.mjs: deleted test file (340 removed lines)'));
    });

    it('detects removed test declarations in modified test files', () => {
      const diff = [
        'diff --git a/tests/baz.test.mjs b/tests/baz.test.mjs',
        '--- a/tests/baz.test.mjs',
        '+++ b/tests/baz.test.mjs',
        '@@ -10,4 +10,2 @@',
        '-  it("should validate input", () => {',
        '-    assert.ok(true);',
        '-  });',
        '-  test("extra check", () => {});',
        '+  it("refactored check", () => {',
        '+    assert.ok(true);',
        '+  });',
      ].join('\n');

      const map = SuspicionMap.compute({ diffBytes: Buffer.from(diff) });
      assert.equal(map.isEmpty, false);
      const declEntry = map.entries.find((e) => e.kind === 'removed_test_declarations');
      assert.ok(declEntry);
      assert.equal(declEntry.path, 'tests/baz.test.mjs');
      assert.equal(declEntry.removed, 2);
      assert.ok(map.toPromptText().includes('- tests/baz.test.mjs: 2 test declarations removed'));
    });

    it('formats singular "1 test declaration removed" correctly', () => {
      const diff = [
        'diff --git a/tests/baz.test.mjs b/tests/baz.test.mjs',
        '--- a/tests/baz.test.mjs',
        '+++ b/tests/baz.test.mjs',
        '@@ -10,3 +10,1 @@',
        '-  it("one test removed", () => {});',
        '+  // kept',
      ].join('\n');

      const map = SuspicionMap.compute({ diffBytes: Buffer.from(diff) });
      assert.ok(map.toPromptText().includes('- tests/baz.test.mjs: 1 test declaration removed'));
    });

    it('respects custom assert and declaration patterns', () => {
      const diff = [
        'diff --git a/tests/custom.test.mjs b/tests/custom.test.mjs',
        '--- a/tests/custom.test.mjs',
        '+++ b/tests/custom.test.mjs',
        '@@ -1,2 +1 @@',
        '-CHECK(valid == true);',
        '+// no check',
      ].join('\n');

      const mapDefault = SuspicionMap.compute({ diffBytes: Buffer.from(diff) });
      assert.equal(mapDefault.isEmpty, true);

      const mapCustom = SuspicionMap.compute({
        diffBytes: Buffer.from(diff),
        assertPatterns: ['\\bCHECK\\b'],
      });
      assert.equal(mapCustom.isEmpty, false);
      assert.equal(mapCustom.entries[0].removed, 1);
    });
  });
});
