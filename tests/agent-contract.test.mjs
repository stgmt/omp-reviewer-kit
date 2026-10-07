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

test('the scout starts from the context pack and the scout baseline when its task text carries them', async () => {
  const scout = await readFile('agents/review-context-scout.md', 'utf8');
  assert.match(scout, /names a context pack path, start from it/);
  assert.match(scout, /ONE parallel batch/);
  assert.match(scout, /`SCOUT BASELINE` block/);
  assert.match(scout, /keep the unchanged entries verbatim/);
  const orchestrator = await readFile('agents/reviewer-kit.md', 'utf8');
  assert.match(orchestrator, /names a context pack path, pass that path to the scout in its task text too/);
});

test('the orchestrator, the hunter and the skill describe the hunter shards consistently', async () => {
  const orchestrator = await readFile('agents/reviewer-kit.md', 'utf8');
  assert.match(orchestrator, /carries a `HUNTER SHARDS` block, the correctness lane runs as one blocking hunter task per listed shard/);
  assert.match(orchestrator, /`correctness-s<shard>-<ordinal>` candidate ids/);
  assert.match(orchestrator, /merge the shards' candidates and `coverage_gaps` into one list before the verifier/);
  const hunter = await readFile('agents/review-risk-hunter.md', 'utf8');
  assert.match(hunter, /names a shard \(`Shard i\/N` with a file list\), hunt only defects located in that shard's files/);
  assert.match(hunter, /`<lane>-s<shard>-<ordinal>`/);
  const skill = await readFile('skills/multi-stage-review/SKILL.md', 'utf8');
  assert.match(skill, /\*\*Sharding\*\*: when the dispatcher prompt carries a `HUNTER SHARDS` block/);
});
