import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRevertedFiles } from '../src/domain/reverted-snapshot.mjs';

describe('Feature: Reverted Snapshot Builder', () => {
  it('keeps staged content for test paths, but reverts non-test paths to HEAD', () => {
    const stagedFiles = [
      { path: 'tests/calc.test.mjs', content: Buffer.from('staged test content') },
      { path: 'src/calc.mjs', content: Buffer.from('staged production content') },
      { path: 'src/unchanged.mjs', content: Buffer.from('unchanged content') },
    ];

    const changedPaths = ['tests/calc.test.mjs', 'src/calc.mjs'];
    const headFiles = new Map([
      ['src/calc.mjs', Buffer.from('HEAD production content')],
    ]);

    const reverted = buildRevertedFiles({
      files: stagedFiles,
      changedPaths,
      headFiles,
    });

    // tests/calc.test.mjs retains staged content
    const testFile = reverted.find((f) => f.path === 'tests/calc.test.mjs');
    assert.ok(testFile);
    assert.equal(testFile.content.toString('utf8'), 'staged test content');

    // src/calc.mjs is reverted to HEAD
    const prodFile = reverted.find((f) => f.path === 'src/calc.mjs');
    assert.ok(prodFile);
    assert.equal(prodFile.content.toString('utf8'), 'HEAD production content');

    // src/unchanged.mjs remains unchanged
    const unchangedFile = reverted.find((f) => f.path === 'src/unchanged.mjs');
    assert.ok(unchangedFile);
    assert.equal(unchangedFile.content.toString('utf8'), 'unchanged content');
  });

  it('excludes newly added non-test files from reverted snapshot', () => {
    const stagedFiles = [
      { path: 'tests/feature.test.mjs', content: Buffer.from('new test') },
      { path: 'src/new-feature.mjs', content: Buffer.from('new prod file') },
    ];

    const changedPaths = ['tests/feature.test.mjs', 'src/new-feature.mjs'];
    const headFiles = new Map([
      ['src/new-feature.mjs', null], // New file, not in HEAD
    ]);

    const reverted = buildRevertedFiles({
      files: stagedFiles,
      changedPaths,
      headFiles,
    });

    assert.ok(reverted.some((f) => f.path === 'tests/feature.test.mjs'));
    assert.ok(!reverted.some((f) => f.path === 'src/new-feature.mjs'));
  });

  it('restores non-test files deleted in staged diff from HEAD', () => {
    const stagedFiles = [
      { path: 'tests/feature.test.mjs', content: Buffer.from('test') },
    ];

    const changedPaths = ['tests/feature.test.mjs', 'src/deleted.mjs'];
    const headFiles = new Map([
      ['src/deleted.mjs', Buffer.from('original HEAD content of deleted file')],
    ]);

    const reverted = buildRevertedFiles({
      files: stagedFiles,
      changedPaths,
      headFiles,
    });

    const restored = reverted.find((f) => f.path === 'src/deleted.mjs');
    assert.ok(restored, 'Deleted non-test file must be restored in reverted snapshot');
    assert.equal(restored.content.toString('utf8'), 'original HEAD content of deleted file');
  });
});
