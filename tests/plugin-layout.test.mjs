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
const rangeAuditorAgent = await readFile('agents/review-range-auditor.md', 'utf8');
const rangeAuditSkill = await readFile('skills/range-audit/SKILL.md', 'utf8');
const slopSkill = await readFile('skills/slop/SKILL.md', 'utf8');
const slopAgent = await readFile('agents/slop.md', 'utf8');
const slopScoutAgent = await readFile('agents/slop-scout.md', 'utf8');
const slopVerifierAgent = await readFile('agents/slop-verifier.md', 'utf8');
const hookTemplate = await readFile('templates/githooks/pre-commit', 'utf8');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

describe('Feature: Multi-Stage Plugin Layout & Protocol Contracts', () => {
  it('manifest and skills declare fixed reviewer identities', () => {
    assert.equal(manifest.name, 'omp-reviewer-kit');
    assert.equal(manifest.version, '0.16.0');
    assert.match(realitySkill, /name: reality-first-review/);
    assert.match(multiStageSkill, /name: multi-stage-review/);
    assert.match(rangeAuditSkill, /name: range-audit/);
    assert.match(slopSkill, /name: slop/);
    assert.match(realitySkill, /staged snapshot.*working tree/i);
    assert.match(realitySkill, /Verified-OK/);
    assert.match(realitySkill, /Anti-neuroslop contract/);
    assert.match(realitySkill, /six neuroslop forms/i);
    assert.match(realitySkill, /red question/i);
    assert.match(realitySkill, /Self-tool rule/);
    assert.match(realitySkill, /Vacuum checklist/);
    assert.match(realitySkill, /Triage/);
    // Coverage-blocking rule must be bound to harness-exercisable code, same as the agent contracts.
    assert.match(realitySkill, /can exercise for its file class\/runtime/i);
    assert.match(realitySkill, /suppressed_coverage_items/);
    assert.match(realitySkill, /rejected_coverage_gaps/);
    assert.match(realitySkill, /Blocking and non-blocking/);
  });

  it('pre-commit hook derives the repository from its own trusted path without invoking Git', () => {
    assert.match(hookTemplate, /hook_dir=\$\(CDPATH= cd/);
    assert.match(hookTemplate, /root=\$\(CDPATH= cd/);
    assert.doesNotMatch(hookTemplate, /(^|\s)git(?:\s|$)/m);
  });

  it('reviewer-kit is configured as a blocking orchestrator with exact specialist spawns', () => {
    const fm = parseFrontmatter(reviewerKitAgent);
    assert.equal(fm.name, 'reviewer-kit');
    assert.equal(fm.model, undefined, 'agents inherit the OMP default model role');
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
    assert.match(reviewerKitAgent, /### Verified-OK/);
    assert.match(reviewerKitAgent, /### Required test coverage/);
    assert.match(reviewerKitAgent, /coverage_required/);
    assert.match(reviewerKitAgent, /coverage_items/);
    assert.match(reviewerKitAgent, /### Notes/);
    // Suppressed coverage items must leave a durable record in ### Notes —
    // sourced from the three producer records on every surface.
    assert.match(reviewerKitAgent, /MUST be mirrored/i);
    assert.match(multiStageSkill, /MUST be mirrored/i);
    // The same commit's three other suppression surfaces must be pinned too,
    // or deleting the clause regresses the coverage-gate fix with no test signal.
    assert.match(scoutAgent, /no runnable harness in this repository can exercise for its file class/i);
    assert.match(hunterAgent, /no runnable harness in this repository can execute for that file's runtime/i);
    assert.match(hunterAgent, /byte-identical copies of untested code already committed elsewhere/i);
    assert.match(verifierAgent, /byte-identical copy of untested code already committed elsewhere/i);
    assert.match(multiStageSkill, /that a runnable test harness in this repository can exercise for its file class\/runtime/i);
    assert.match(verifierAgent, /no runnable harness in this repository can exercise the code for its file class\/runtime/i);
    assert.match(multiStageSkill, /no runnable harness in this repository can execute for that file's runtime/i);
    assert.match(multiStageSkill, /no runnable harness in this repository covers the file's class\/runtime/i);
    // Producer records making suppressed items mirroring structurally possible.
    assert.match(scoutAgent, /non_coverable_items/);
    assert.match(hunterAgent, /suppressed_coverage_items/);
    assert.match(verifierAgent, /rejected_coverage_gaps/);
    assert.match(reviewerKitAgent, /non_coverable_items/);
    assert.match(reviewerKitAgent, /suppressed_coverage_items/);
    assert.match(reviewerKitAgent, /rejected_coverage_gaps/);
    assert.match(multiStageSkill, /non_coverable_items/);
    assert.match(multiStageSkill, /suppressed_coverage_items/);
    assert.match(multiStageSkill, /rejected_coverage_gaps/);
    // Byte-identical exemption bounded to equally non-coverable destinations.
    assert.match(hunterAgent, /equally non-coverable/i);
    assert.match(verifierAgent, /equally non-coverable/i);
    assert.match(multiStageSkill, /equally non-coverable/i);
    assert.match(reviewerKitAgent, /suspicion map/i);
    assert.match(reviewerKitAgent, /execution evidence/i);

    assert.match(reviewerKitAgent, /REVIEW_RESULT=PASS/);
    assert.match(reviewerKitAgent, /REVIEW_RESULT=BLOCK/);
    assert.match(reviewerKitAgent, /review-rejection-envelope@1/);
    assert.equal((reviewerKitAgent.match(/Stage [1-4]:/g) ?? []).length, 4);
    assert.equal((reviewerKitAgent.match(/agent `review-risk-hunter`/g) ?? []).length, 1);
    assert.match(reviewerKitAgent, /Risk lanes for this diff/);
    assert.match(reviewerKitAgent, /CLI invocation pins the active and slow model roles/);
    assert.match(reviewerKitAgent, /omit `model`, `outputSchema`, `schemaMode`, and `isolated`/);
    assert.match(reviewerKitAgent, /staged snapshot/i);
    assert.match(reviewerKitAgent, /test evidence/i);
    assert.match(reviewerKitAgent, /YAGNI|unnecessary/i);
    assert.doesNotMatch(reviewerKitAgent, /Pass that exact `model` selector/);
  });

  it('review-profile contract: spec-docs reduced path is pinned across skill, orchestrator, and specialists', () => {
    // SKILL is the single source of truth for the profile.
    assert.match(multiStageSkill, /Review profiles/);
    assert.match(multiStageSkill, /spec-docs/);
    assert.match(multiStageSkill, /content-risk/);
    assert.match(multiStageSkill, /file-classes\.json/);
    assert.match(multiStageSkill, /file-classes@1/);
    assert.match(multiStageSkill, /MUST NOT run the correctness lane/);
    // Orchestrator reads the profile line and branches Stage 2 to a single content-risk task.
    assert.match(reviewerKitAgent, /Review profile for this diff:/);
    assert.match(reviewerKitAgent, /spec-docs/);
    assert.match(reviewerKitAgent, /content-risk/);
    assert.match(reviewerKitAgent, /file-classes\.json/);
    assert.match(reviewerKitAgent, /never emit a `coverage_required` envelope/);
    // Hunter accepts the third lane; schema enum must cover all three.
    assert.match(hunterAgent, /lane: "content-risk"/);
    assert.match(hunterAgent, /"correctness \| security \| content-risk"/);
    // Verifier skips coverage work under spec-docs.
    assert.match(verifierAgent, /Profile-aware coverage/);
    assert.match(verifierAgent, /spec-docs/);
    // Scout scopes scouting under spec-docs.
    assert.match(scoutAgent, /spec-docs/);
    assert.match(scoutAgent, /file-classes\.json/);
  });

  it('review-profile contract: dispatcher prompt and runner emit profile + manifest', async () => {
    const promptSrc = await readFile('src/domain/review-prompt.mjs', 'utf8');
    assert.match(promptSrc, /Review profile for this diff:/);
    assert.match(promptSrc, /File-class manifest/);
    assert.match(promptSrc, /Risk lanes for this diff:/);
    const fileClassSrc = await readFile('src/domain/file-class.mjs', 'utf8');
    assert.match(fileClassSrc, /spec-docs.*content-risk|content-risk.*spec-docs/);
    assert.match(fileClassSrc, /OMP_REVIEW_KIT_LANES/);
    const adapterSrc = await readFile('src/infra/filesystem-snapshot-adapter.mjs', 'utf8');
    assert.match(adapterSrc, /file-classes\.json/);
    assert.match(adapterSrc, /file-classes@1/);
    assert.match(adapterSrc, /reuseDir/);
    const serviceSrc = await readFile('src/application/review-workflow-service.mjs', 'utf8');
    assert.match(serviceSrc, /reviewProfileFor/);
    assert.match(serviceSrc, /fileClassRows/);
    assert.match(serviceSrc, /snapshotDirDisposition/);
    assert.match(serviceSrc, /#writeBadge/);
    const runnerSrc = await readFile('scripts/run-review.mjs', 'utf8');
    assert.match(runnerSrc, /Review profile for this diff:/);
    assert.match(runnerSrc, /file-classes\.json/);
    assert.match(runnerSrc, /childLogReadStage/);
    assert.match(runnerSrc, /SNAPSHOT_RETENTION/);
    assert.match(runnerSrc, /review-badge\.json/);
    const agentAdapter = await readFile('src/infra/omp-cli-reviewer-adapter.mjs', 'utf8');
    assert.match(agentAdapter, /childLogReadStage/);
    assert.match(agentAdapter, /onStage/);
    assert.match(agentAdapter, /stageHistory/);
  });
  it('env parity: every spawn site in src and runner merges registry PI_PROXY_* (r30)', async () => {
    // The bundled runners were already flipped; the modular src adapter
    // must carry the same merge or execution children lose PI_PROXY_* on
    // stale parents — the parity drift r30 caught.
    const execSrc = await readFile('src/infra/subprocess-execution-adapter.mjs', 'utf8');
    assert.match(execSrc, /mergeRegistryProxyEnv\(\)/);
    assert.doesNotMatch(execSrc, /env: process\.env/);
    const runnerSrc = await readFile('scripts/run-review.mjs', 'utf8');
    assert.equal(runnerSrc.includes('env: process.env,'), false,
      'no spawn site in the runner may pass raw process.env');
  });
  it('dispatcher dispatches without reading files and passes skill names downstream', () => {
    assert.match(reviewerKitAgent, /without reading any files yourself/);
    assert.match(reviewerKitAgent, /pass those names to the scout in its task text/);
    assert.match(reviewerKitAgent, /Forward the same project skill names given to the scout/);
    assert.match(scoutAgent, /read those skill files first/);
    assert.match(hunterAgent, /read those skill files before hunting/);
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
    assert.equal(fm.model, undefined, 'agents inherit the OMP default model role');
    assert.match(scoutAgent, /"change_goal"/);
    assert.match(scoutAgent, /"changed_paths"/);
    assert.match(scoutAgent, /"relevant_consumers"/);
    assert.match(scoutAgent, /"invariants"/);
    assert.match(scoutAgent, /"test_evidence"/);
    assert.match(scoutAgent, /"unknowns"/);
    assert.match(scoutAgent, /"reviewed_paths"/);
    assert.match(scoutAgent, /"claims"/);
    assert.match(scoutAgent, /"declared_checks"/);
    assert.match(scoutAgent, /do not emit verdict markers/i);
    assert.match(scoutAgent, /existing `invariants` and `relevant_consumers`/);
    assert.match(scoutAgent, /`unknowns`/);
    assert.match(scoutAgent, /staged snapshot/i);
    assert.match(scoutAgent, /test evidence/i);
    assert.match(scoutAgent, /"coverage_map"/);
    assert.match(scoutAgent, /"test_harness"/);
    assert.match(scoutAgent, /"covering_test"/);
    assert.doesNotMatch(scoutAgent, /platform_primitives/);
  });

  it('review-risk-hunter uses one shared candidate schema for both correctness and security lanes', () => {
    const fm = parseFrontmatter(hunterAgent);
    assert.equal(fm.model, undefined, 'agents inherit the OMP default model role');
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
    assert.match(hunterAgent, /"red_proof"/);
    assert.match(hunterAgent, /Neuroslop Pass/);
    assert.match(hunterAgent, /Anti-Noise Prohibitions/);
    assert.match(hunterAgent, /Do not emit verdict markers/i);
    assert.match(hunterAgent, /Anti-Parasitic Correctness Gate/);
    assert.match(hunterAgent, /evidence proves both conditions/);
    assert.match(hunterAgent, /adds no product capability/);
    assert.match(hunterAgent, /correctness lane.*test|test.*correctness lane/i);
    assert.match(hunterAgent, /YAGNI|unnecessary/i);
    assert.match(hunterAgent, /"coverage_gaps"/);
    assert.match(hunterAgent, /"required_tests"/);
    assert.match(hunterAgent, /"mutant"/);
    assert.match(hunterAgent, /staged snapshot/i);
    assert.match(hunterAgent, /Do not flag a Port\/Adapter or Template Method that adds a real capability/);
    assert.doesNotMatch(hunterAgent, /lane: \"architecture\"/);
    assert.doesNotMatch(hunterAgent, /defect_class: \"parasitic_architecture\"/);
  });

  it('review-finding-verifier enforces mandatory disposition values and forbids verdict markers', () => {
    const fm = parseFrontmatter(verifierAgent);
    assert.equal(fm.model, undefined, 'agents inherit the OMP default model role');
    assert.match(verifierAgent, /"disposition": "confirmed \| rejected \| not_proven"/);
    assert.match(verifierAgent, /"confirmed_findings"/);
    assert.match(verifierAgent, /"triage":/);
    assert.match(verifierAgent, /Neuroslop confirmation/);
    assert.match(verifierAgent, /Self-tool audit/);
    assert.match(verifierAgent, /Adversarial Verification Checks/);
    assert.match(verifierAgent, /Upstream Defenses/);
    assert.match(verifierAgent, /must NOT suggest replacement patches or emit verdict markers/i);
    assert.match(verifierAgent, /staged snapshot/i);
    assert.match(verifierAgent, /"confirmed_coverage_gaps"/);
    assert.match(verifierAgent, /Coverage gaps/);
    assert.match(verifierAgent, /proves both an existing mechanism/);
    assert.match(verifierAgent, /zero new product capability/);
    assert.match(verifierAgent, /public user-facing CLIs/);
    assert.match(verifierAgent, /remote untrusted payloads/);
    assert.match(verifierAgent, /staged snapshot/i);
  });

  it('multi-stage-review skill codifies the ordered protocol and schemas', () => {
    assert.match(multiStageSkill, /Stage 1: Context Scout/);
    assert.match(multiStageSkill, /Stage 2: Parallel Risk Hunting/);
    assert.match(multiStageSkill, /Stage 3: Adversarial Verification/);
    assert.match(multiStageSkill, /Stage 4: Orchestrator Synthesis/);
    assert.match(multiStageSkill, /Anti-Noise Prohibitions/);
    assert.match(multiStageSkill, /REVIEW_RESULT=PASS/);
    assert.match(multiStageSkill, /REVIEW_RESULT=BLOCK/);
    assert.match(multiStageSkill, /Anti-Parasitic Correctness Gate/);
    assert.match(multiStageSkill, /both repository or declared-framework evidence/);
    assert.match(multiStageSkill, /review-rejection-envelope@1/);
    assert.match(multiStageSkill, /staged snapshot.*working tree/i);
    assert.match(multiStageSkill, /test evidence.*YAGNI|YAGNI.*test evidence/i);
    assert.match(multiStageSkill, /Verified-OK/);
    assert.match(multiStageSkill, /red_proof/);
    assert.match(multiStageSkill, /declared_checks/);
    assert.match(multiStageSkill, /### Notes/);
    assert.match(multiStageSkill, /### Required test coverage/);
    assert.match(multiStageSkill, /coverage_required/);
    assert.match(multiStageSkill, /coverage_map/);
    assert.match(multiStageSkill, /confirmed_coverage_gaps/);
    assert.match(multiStageSkill, /triage/);
    assert.match(multiStageSkill, /coverage_gaps/);
    assert.doesNotMatch(multiStageSkill, /lane: \"architecture\"/);
    assert.doesNotMatch(multiStageSkill, /platform_primitives/);
  });

  it('slop skill codifies the 2-in-1 adversarial audit doctrine with hook scoping guard', () => {
    assert.match(slopSkill, /^name:\s*slop$/m);
    assert.match(slopSkill, /Parasitic Architecture Audit/);
    assert.match(slopSkill, /Spec Slop & Integrity Audit/);
    assert.match(slopSkill, /Anti-Noise Gate/);
    assert.match(slopSkill, /Reviewer Kit Hook Scoping Guard/);
    assert.match(slopSkill, /REVIEW_RESULT=PASS/);
    assert.match(slopSkill, /REVIEW_RESULT=BLOCK/);
    assert.match(slopSkill, /VERDICT:\s*\[BLOCKED\s*\|\s*CLEAN\s*\|\s*ACCEPTABLE_WITH_NOTES\]/);
  });

  it('slop orchestrator is a blocking agent spawning exactly slop-scout and slop-verifier with the VERDICT contract', () => {
    const fm = parseFrontmatter(slopAgent);
    assert.equal(fm.name, 'slop');
    assert.equal(fm.model, undefined, 'agents inherit the OMP default model role');
    assert.equal(fm.blocking, 'true');

    const tools = fm.tools.split(',').map(t => t.trim());
    assert.ok(tools.includes('task'));
    assert.ok(!tools.includes('edit'));
    assert.ok(!tools.includes('write'));

    const spawns = fm.spawns.split(',').map(s => s.trim());
    assert.deepEqual(spawns.sort(), ['slop-scout', 'slop-verifier'].sort());

    assert.ok(Array.isArray(fm.autoloadSkills));
    assert.ok(fm.autoloadSkills.includes('slop'));
    assert.ok(fm.autoloadSkills.includes('reality-first-review'));

    assert.match(slopAgent, /Stage 1: Candidate Scout/);
    assert.match(slopAgent, /Stage 2: Adversarial Verification/);
    assert.match(slopAgent, /Stage 3: Orchestrator Synthesis/);
    assert.match(slopAgent, /agent `slop-scout`/);
    assert.match(slopAgent, /agent `slop-verifier`/);
    assert.match(slopAgent, /VERDICT: \[BLOCKED \| CLEAN \| ACCEPTABLE_WITH_NOTES\]/);
    assert.match(slopAgent, /VERDICT: ERROR/);
    assert.match(slopAgent, /NOT a clean result/);
    assert.match(slopAgent, /omit `model`, `outputSchema`, `schemaMode`, and `isolated`/);
    assert.match(slopAgent, /yield/);
    assert.doesNotMatch(slopAgent, /REVIEW_RESULT=/);
  });

  it('slop-scout and slop-verifier are read-only specialists without task spawning', () => {
    const subagents = [
      { name: 'slop-scout', content: slopScoutAgent },
      { name: 'slop-verifier', content: slopVerifierAgent },
    ];

    for (const { name, content } of subagents) {
      const fm = parseFrontmatter(content);
      assert.equal(fm.name, name);
      assert.equal(fm.model, undefined, `${name} inherits the OMP default model role`);
      assert.equal(fm.blocking, 'true', `${name} must declare blocking: true`);
      const tools = fm.tools.split(',').map(t => t.trim());
      assert.ok(!tools.includes('edit'), `${name} must not contain edit tool`);
      assert.ok(!tools.includes('write'), `${name} must not contain write tool`);
      assert.ok(!tools.includes('task'), `${name} must not contain task spawning tool`);
      assert.ok(!fm.spawns, `${name} must not declare spawns`);
      assert.ok(fm.autoloadSkills.includes('slop'), `${name} must autoload the slop skill`);
      assert.match(content, /yield/);
    }

    assert.match(slopScoutAgent, /"candidates"/);
    assert.match(slopScoutAgent, /"suspectedCategory": "P1_BLOCKER \| P2_PARASITIC_OR_SLOP \| P3_DRIFT"/);
    assert.match(slopScoutAgent, /"summary"/);
    assert.match(slopScoutAgent, /do not emit verdict markers/i);

    assert.match(slopVerifierAgent, /"verified"/);
    assert.match(slopVerifierAgent, /"rejectedCount"/);
    assert.match(slopVerifierAgent, /"verdict": "BLOCKED \| CLEAN \| ACCEPTABLE_WITH_NOTES"/);
    assert.match(slopVerifierAgent, /"verdictReason"/);
    assert.match(slopVerifierAgent, /Anti-Noise Gate/);
    assert.match(slopVerifierAgent, /Can it turn red/);
    assert.match(slopVerifierAgent, /Grounding/);
    assert.match(slopVerifierAgent, /must NOT suggest replacement patches or emit verdict markers/i);
  });
});

describe('Agent model inheritance', () => {
  it('review-range-auditor inherits the OMP default model role', () => {
    const fm = parseFrontmatter(rangeAuditorAgent);
    assert.equal(fm.name, 'review-range-auditor');
    assert.equal(fm.model, undefined, 'agents inherit the OMP default model role');
  });
});
