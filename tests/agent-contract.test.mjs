import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all review agents select the native task role without pinning a concrete model', async () => {
  for (const file of ['agents/reviewer-kit.md', ...SUBAGENTS]) {
    const text = await readFile(file, 'utf8');
    const frontmatter = text.split('---')[1];
    assert.match(frontmatter, /^model: "@task"$/m, file);
  }
});

const SUBAGENTS = [
  'agents/review-context-scout.md',
  'agents/review-risk-hunter.md',
  'agents/review-finding-verifier.md',
];

for (const file of SUBAGENTS) {
  test(`${file}: forbids running project test, build, lint or mutation suites`, async () => {
    const text = await readFile(file, 'utf8');
    assert.match(text, /Never run the project's test, build, lint, or mutation suites/);
    assert.match(text, /`npm test`/);
    assert.doesNotMatch(text, /execution evidence|context pack|HUNTER SHARDS|suspicion map|PREVIOUS ROUND/);
    assert.match(text, /read-only inspection/);
  });
}
