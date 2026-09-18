import { diffBlockPaths } from './diff-identity.mjs';

export const DEFAULT_ASSERT_PATTERNS = [
  '\\bassert\\b',
  '\\bexpect\\s*\\(',
  '\\bshould\\b',
  '\\brequire\\s*\\(',
  '\\bt\\.(?:Fatal|Error|Fatalf|Errorf)\\b',
];

export const DEFAULT_TEST_PATH_PATTERNS = [
  '(^|/)tests?/',
  '(^|/)__tests__/',
  '(^|/)spec/',
  '\\.test\\.',
  '\\.spec\\.',
  '_test\\.',
  '(^|/)test_',
];

export const DEFAULT_TEST_DECLARATION_PATTERNS = [
  '\\bdef\\s+test_',
  '\\bit\\s*\\(',
  '\\btest\\s*\\(',
  '\\bdescribe\\s*\\(',
  '\\bfunc\\s+Test',
  '@Test\\b',
];

export function isTestPath(path, patterns = DEFAULT_TEST_PATH_PATTERNS) {
  if (typeof path !== 'string' || path.length === 0) return false;
  return patterns.some((p) => new RegExp(p).test(path));
}

/**
 * Parses a git diff into blocks per file.
 * Returns Array<{ path: string, deleted: boolean, addedLines: string[], removedLines: string[] }>
 */
export function parseDiffBlocks(diffText) {
  if (typeof diffText !== 'string' || diffText.trim().length === 0) {
    return [];
  }

  const blocks = [];
  const rawBlocks = diffText.split(/^diff --git /m);
  for (let i = 1; i < rawBlocks.length; i += 1) {
    const blockText = rawBlocks[i];
    if (blockText.includes('Binary files ') && blockText.includes(' differ')) {
      continue;
    }

    const { oldPath, newPath } = diffBlockPaths(blockText);
    const path = newPath ?? oldPath;
    if (!path) continue;

    const deleted = /^deleted file mode \d+/m.test(blockText);

    const addedLines = [];
    const removedLines = [];

    const lines = blockText.split('\n');
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) {
        addedLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        removedLines.push(line.slice(1));
      }
    }

    blocks.push({
      path,
      deleted,
      addedLines,
      removedLines,
    });
  }

  return blocks;
}

/**
 * Value Object representing the deterministic suspicion map computed from a staged diff.
 */
export class SuspicionMap {
  #entries;

  constructor(entries = []) {
    this.#entries = Object.freeze([...entries]);
  }

  get entries() {
    return this.#entries;
  }

  get isEmpty() {
    return this.#entries.length === 0;
  }

  static compute({
    diffBytes,
    assertPatterns = DEFAULT_ASSERT_PATTERNS,
    testPathPatterns = DEFAULT_TEST_PATH_PATTERNS,
    testDeclarationPatterns = DEFAULT_TEST_DECLARATION_PATTERNS,
  } = {}) {
    if (!diffBytes || diffBytes.length === 0) {
      return new SuspicionMap([]);
    }

    const diffText = Buffer.isBuffer(diffBytes)
      ? diffBytes.toString('utf8')
      : String(diffBytes);

    const blocks = parseDiffBlocks(diffText);
    const entries = [];

    const assertRegexes = assertPatterns.map((p) => new RegExp(p));
    const declRegexes = testDeclarationPatterns.map((p) => new RegExp(p));

    for (const block of blocks) {
      if (!isTestPath(block.path, testPathPatterns)) {
        continue;
      }

      if (block.deleted) {
        entries.push({
          path: block.path,
          kind: 'deleted_test_file',
          added: 0,
          removed: block.removedLines.length,
          net: -block.removedLines.length,
          detail: `${block.removedLines.length} removed lines`,
        });
        continue;
      }

      let addedAsserts = 0;
      for (const line of block.addedLines) {
        if (assertRegexes.some((re) => re.test(line))) {
          addedAsserts += 1;
        }
      }

      let removedAsserts = 0;
      for (const line of block.removedLines) {
        if (assertRegexes.some((re) => re.test(line))) {
          removedAsserts += 1;
        }
      }

      if (addedAsserts !== 0 || removedAsserts !== 0) {
        const net = addedAsserts - removedAsserts;
        entries.push({
          path: block.path,
          kind: 'assert_delta',
          added: addedAsserts,
          removed: removedAsserts,
          net,
          detail: `assert lines +${addedAsserts}/-${removedAsserts} (net ${net > 0 ? `+${net}` : net})`,
        });
      }

      let removedDecls = 0;
      for (const line of block.removedLines) {
        if (declRegexes.some((re) => re.test(line))) {
          removedDecls += 1;
        }
      }

      if (removedDecls > 0) {
        entries.push({
          path: block.path,
          kind: 'removed_test_declarations',
          added: 0,
          removed: removedDecls,
          net: -removedDecls,
          detail: `${removedDecls} test declaration${removedDecls === 1 ? '' : 's'} removed`,
        });
      }
    }

    return new SuspicionMap(entries);
  }

  toPromptText() {
    if (this.isEmpty) {
      return 'Deterministic suspicion map: no test-file assert deltas, deletions, or removed test declarations detected.';
    }

    const lines = [
      'Deterministic suspicion map (computed from the staged diff; every entry must be addressed):',
    ];

    for (const entry of this.#entries) {
      if (entry.kind === 'assert_delta') {
        const netStr = entry.net > 0 ? `+${entry.net}` : `${entry.net}`;
        lines.push(`- ${entry.path}: assert lines +${entry.added}/-${entry.removed} (net ${netStr})`);
      } else if (entry.kind === 'deleted_test_file') {
        lines.push(`- ${entry.path}: deleted test file (${entry.removed} removed lines)`);
      } else if (entry.kind === 'removed_test_declarations') {
        lines.push(`- ${entry.path}: ${entry.removed} test declaration${entry.removed === 1 ? '' : 's'} removed`);
      }
    }

    return lines.join('\n');
  }
}
