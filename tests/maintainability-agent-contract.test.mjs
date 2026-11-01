// Given/When/Then over the maintainability agent contract and its wiring into the plugin: the
// declared role, the read-only tool set, the machine fields the verdict reads, and the layout list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const AGENT = 'agents/review-maintainability.md';
const agentText = await readFile(AGENT, 'utf8');
const frontmatter = agentText.split('---')[1];
const schema = JSON.parse(frontmatter.match(/^output: (.+)$/m)[1]);

test('Given the maintainability agent, When its definition is read, Then it declares the native task role and no explicit model', () => {
  assert.match(frontmatter, /^model: "@task"$/m);
  assert.match(frontmatter, /^blocking: true$/m);
  assert.doesNotMatch(frontmatter, /^\s*(haiku|sonnet|opus|gpt|gemini|deepseek)/im);
});

test('Given the maintainability agent, When its tools are read, Then it can only read and cannot spawn further agents', () => {
  assert.match(frontmatter, /^tools: read, grep, glob, lsp, bash$/m);
  assert.doesNotMatch(frontmatter, /^spawns:/m);
  assert.doesNotMatch(agentText, /`task` tool|spawn subagents and delegate/i);
  assert.match(agentText, /You cannot spawn subagents/);
});

test('Given the maintainability agent, When its answer schema is read, Then it carries the fields the verdict reads', () => {
  const candidate = schema.properties.candidates.items;
  assert.deepEqual([...candidate.required].sort(), [
    'candidate_id', 'coordinated_change', 'counterargument', 'counterargument_evidence', 'decision',
    'evidence', 'forwarding_only', 'group_id', 'impact', 'meaning', 'params', 'priority',
    'reflection', 'stated_cost', 'triage_ground',
  ]);
  assert.deepEqual(candidate.properties.priority.enum, ['P1', 'P2']);
  assert.deepEqual(candidate.properties.decision.enum, ['confirmed', 'rejected', 'not_proven']);
  assert.equal(candidate.properties.stated_cost.type, 'string');
  assert.equal(candidate.properties.reflection.type, 'string');
  assert.equal(candidate.properties.forwarding_only.type, 'boolean');
  assert.deepEqual([...schema.required].sort(), ['budget', 'candidates', 'language_coverage', 'observed', 'planned_checks', 'unproven_items']);
});

test('Given the maintainability agent, When its instructions are read, Then it is read-only and never runs project suites', () => {
  assert.match(agentText, /Never run the project's test, build, lint, or mutation suites/);
  assert.match(agentText, /`npm test`/);
  assert.match(agentText, /You must never edit files, stage, reset, commit, delete, or run mutating commands/);
  // The stage must cover every delivered group: a candidate ceiling of its own would leave the
  // mandatory stage incomplete and block a commit with no finding.
  assert.match(agentText, /Analyze \*\*every\*\* group in the candidate file/);
  assert.match(agentText, /never leave a group unassessed/);
  assert.match(agentText, /never recount them/);
});

test('Given the orchestrator, When its definition is read, Then the maintainability stage is spawned, reported and part of the blocking rules', async () => {
  const orchestrator = await readFile('agents/reviewer-kit.md', 'utf8');
  assert.match(orchestrator, /^spawns: .*review-maintainability.*$/m);
  assert.match(orchestrator, /^### Maintainability$/m);
  assert.match(orchestrator, /Stage 2b: Maintainability Review/);
  assert.match(orchestrator, /a maintainability candidate carries a confirmed decision, a non-empty `stated_cost`, priority `P2` and `forwarding_only: false`/);
});

test('Given the shipped plugin, When the layout list is read, Then every maintainability file is required to exist', async () => {
  const layout = await readFile('src/infra/layout-required.mjs', 'utf8');
  for (const file of [
    'src/native/maintainability/config.mjs',
    'src/native/maintainability/extract.mjs',
    'src/native/maintainability/group.mjs',
    'src/native/maintainability/analyze.mjs',
    'scripts/measure-maintainability.mjs',
    'agents/review-maintainability.md',
  ]) {
    assert.ok(layout.includes(`'${file}'`), `${file} is missing from the layout list`);
    await readFile(file, 'utf8');
  }
});
