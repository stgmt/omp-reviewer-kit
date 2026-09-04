import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe, it } from 'node:test';

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split('\n');
  const result = {};
  let currentKey = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('- ') && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(line.slice(2).trim());
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      currentKey = key;
      if (val === '') {
        result[key] = [];
      } else {
        result[key] = val.replace(/^["']|["']$/g, '');
      }
    }
  }
  return result;
}

const reviewerKitAgent = await readFile('agents/reviewer-kit.md', 'utf8');
const scoutAgent = await readFile('agents/review-context-scout.md', 'utf8');
const hunterAgent = await readFile('agents/review-risk-hunter.md', 'utf8');
const verifierAgent = await readFile('agents/review-finding-verifier.md', 'utf8');
const realitySkill = await readFile('skills/reality-first-review/SKILL.md', 'utf8');
const multiStageSkill = await readFile('skills/multi-stage-review/SKILL.md', 'utf8');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

describe('Feature: Multi-Stage Plugin Layout & Protocol Contracts', () => {
  it('manifest and skills declare fixed reviewer identities', () => {
    assert.equal(manifest.name, 'omp-reviewer-kit');
    assert.equal(manifest.version, '0.2.0');
    assert.match(realitySkill, /name: reality-first-review/);
    assert.match(multiStageSkill, /name: multi-stage-review/);
  });

  it('reviewer-kit is configured as a blocking orchestrator with exact specialist spawns', () => {
    const fm = parseFrontmatter(reviewerKitAgent);
    assert.equal(fm.name, 'reviewer-kit');
    assert.equal(fm.model, '@slow');
    assert.equal(fm.blocking, 'true');

    // Tool list contains task for orchestration, but no mutation tools
    const tools = fm.tools.split(',').map(t => t.trim());
    assert.ok(tools.includes('task'));
    assert.ok(!tools.includes('edit'));
    assert.ok(!tools.includes('write'));

    // Spawns allowlist strictly limits children to the three specialist agents
    const spawns = fm.spawns.split(',').map(s => s.trim());
    assert.deepEqual(spawns.sort(), ['review-context-scout', 'review-finding-verifier', 'review-risk-hunter'].sort());

    // Autoloads both review methodology and protocol skills
    assert.ok(Array.isArray(fm.autoloadSkills));
    assert.ok(fm.autoloadSkills.includes('reality-first-review'));
    assert.ok(fm.autoloadSkills.includes('multi-stage-review'));
  });

  it('reviewer-kit body enforces 4-stage ordering, report sections, and solitary marker', () => {
    assert.match(reviewerKitAgent, /Stage 1: Context Scout/);
    assert.match(reviewerKitAgent, /Stage 2: Parallel Risk Hunting/);
    assert.match(reviewerKitAgent, /Stage 3: Adversarial Verification/);
    assert.match(reviewerKitAgent, /Stage 4: Orchestrator Synthesis/);

    assert.match(reviewerKitAgent, /### Review coverage/);
    assert.match(reviewerKitAgent, /### Confirmed findings/);
    assert.match(reviewerKitAgent, /### Unproven\/rejected summary/);

    assert.match(reviewerKitAgent, /REVIEW_RESULT=PASS/);
    assert.match(reviewerKitAgent, /REVIEW_RESULT=BLOCK/);
  });

  it('all review subagents strictly exclude mutation tools and task spawning', () => {
    const subagents = [
      { name: 'review-context-scout', content: scoutAgent },
      { name: 'review-risk-hunter', content: hunterAgent },
      { name: 'review-finding-verifier', content: verifierAgent },
    ];

    for (const { name, content } of subagents) {
      const fm = parseFrontmatter(content);
      assert.equal(fm.blocking, 'true', `${name} must declare blocking: true`);
      const tools = fm.tools.split(',').map(t => t.trim());
      assert.ok(!tools.includes('edit'), `${name} must not contain edit tool`);
      assert.ok(!tools.includes('write'), `${name} must not contain write tool`);
      assert.ok(!tools.includes('task'), `${name} must not contain task spawning tool`);
      assert.ok(!fm.spawns, `${name} must not declare spawns`);
    }
  });

  it('review-context-scout specifies read-only context output schema and forbids verdict markers', () => {
    const fm = parseFrontmatter(scoutAgent);
    assert.equal(fm.model, '@task');
    assert.match(scoutAgent, /"change_goal"/);
    assert.match(scoutAgent, /"changed_paths"/);
    assert.match(scoutAgent, /"relevant_consumers"/);
    assert.match(scoutAgent, /"invariants"/);
    assert.match(scoutAgent, /"test_evidence"/);
    assert.match(scoutAgent, /"unknowns"/);
    assert.match(scoutAgent, /"reviewed_paths"/);
    assert.match(scoutAgent, /do not emit verdict markers/i);
  });

  it('review-risk-hunter uses one shared candidate schema for both correctness and security lanes', () => {
    const fm = parseFrontmatter(hunterAgent);
    assert.equal(fm.model, '@slow');
    assert.match(hunterAgent, /lane: "correctness"/);
    assert.match(hunterAgent, /lane: "security"/);
    assert.match(hunterAgent, /"candidate_id"/);
    assert.match(hunterAgent, /"priority": "P1 \| P2"/);
    assert.match(hunterAgent, /"line_start"/);
    assert.match(hunterAgent, /"line_end"/);
    assert.match(hunterAgent, /"observed_behavior"/);
    assert.match(hunterAgent, /"expected_behavior"/);
    assert.match(hunterAgent, /"trigger_scenario"/);
    assert.match(hunterAgent, /"impact"/);
    assert.match(hunterAgent, /"evidence"/);
    assert.match(hunterAgent, /Anti-Noise Prohibitions/);
    assert.match(hunterAgent, /Do not emit verdict markers/i);
  });

  it('review-finding-verifier enforces mandatory disposition values and forbids verdict markers', () => {
    const fm = parseFrontmatter(verifierAgent);
    assert.equal(fm.model, '@slow');
    assert.match(verifierAgent, /"disposition": "confirmed \| rejected \| not_proven"/);
    assert.match(verifierAgent, /"confirmed_findings"/);
    assert.match(verifierAgent, /Adversarial Verification Checks/);
    assert.match(verifierAgent, /Upstream Defenses/);
    assert.match(verifierAgent, /must NOT suggest replacement patches or emit verdict markers/i);
  });

  it('multi-stage-review skill codifies the ordered protocol and schemas', () => {
    assert.match(multiStageSkill, /Stage 1: Context Scout/);
    assert.match(multiStageSkill, /Stage 2: Parallel Risk Hunting/);
    assert.match(multiStageSkill, /Stage 3: Adversarial Verification/);
    assert.match(multiStageSkill, /Stage 4: Orchestrator Synthesis/);
    assert.match(multiStageSkill, /Anti-Noise Prohibitions/);
    assert.match(multiStageSkill, /REVIEW_RESULT=PASS/);
    assert.match(multiStageSkill, /REVIEW_RESULT=BLOCK/);
  });
});
