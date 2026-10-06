import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
    assert.match(text, /execution evidence/);
    assert.match(text, /read-only inspection/);
  });
}
