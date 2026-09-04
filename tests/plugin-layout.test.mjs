import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const agent = await readFile('agents/reviewer-kit.md', 'utf8');
const skill = await readFile('skills/reality-first-review/SKILL.md', 'utf8');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

test('uses the fixed OMP Review Kit identities', () => {
  assert.equal(manifest.name, 'omp-reviewer-kit');
  assert.match(agent, /name: reviewer-kit/);
  assert.match(agent, /model: "@slow"/);
  assert.match(agent, /autoloadSkills:/);
  assert.match(agent, /reality-first-review/);
  assert.match(skill, /name: reality-first-review/);
});

test('agent requires project skill composition without a second registry', () => {
  assert.match(agent, /skills made available by OMP/);
  assert.match(agent, /only project or user skills relevant/);
  assert.match(skill, /Do not scan `\.omp\/skills` manually/);
  assert.match(skill, /do not create a second registry/);
});
