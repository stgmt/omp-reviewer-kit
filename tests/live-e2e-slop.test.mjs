/**
 * Live E2E test for the native /slop audit inside omp-reviewer-kit.
 *
 * Creates a fresh OMP profile, installs the plugin, seeds a temp git repo with
 * planted slop defects (a vacuous test that cannot turn red + a parasitic
 * file-queue wrapper beside a declared native mechanism), then runs `omp -p`
 * with the SlopPrompt dispatcher so a native task agent="slop" audits the repo.
 *
 * Gated on OMP_REVIEW_KIT_LIVE_E2E=1 (otherwise skipped).
 * Model: OMP_REVIEW_KIT_MODEL selects the dispatcher session model (e.g. @slow);
 * the slop agents resolve their own @slow/@smol roles from the profile config.
 *
 * Logging convention: direct live output to %TEMP%, never into the repo tree:
 *   OMP_REVIEW_KIT_LIVE_E2E=1 node --test tests/live-e2e-slop.test.mjs 2>&1 | tee %TEMP%\live-e2e-slop.log
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { SlopPrompt } from '../src/index.mjs';
import {
  copyDefaultProfileConfig,
  gitAt,
  resolveAgentDir,
  runLiveOmp,
  spawnOmpSync,
  writeSessionedOmpWrapper,
  writeTree,
} from './live-e2e-omp.test.mjs';

const isLiveE2E = process.env.OMP_REVIEW_KIT_LIVE_E2E === '1';

const hasOmp = (() => {
  try {
    const res = spawnOmpSync(['--version'], { encoding: 'utf8', windowsHide: true });
    return res.status === 0;
  } catch {
    return false;
  }
})();

describe('Feature: Native /slop audit on live OMP (No Mocks)', () => {
  it('Live Slop: fresh-profile plugin install + omp -p task agent=slop emits VERDICT: with a P1/P2 finding on planted defects', { skip: !isLiveE2E || !hasOmp }, async () => {
    const profile = `omp-slop-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-slop-e2e-'));
    const repoDir = path.join(baseDir, 'repo');
    const agentDir = resolveAgentDir(profile);
    const profileDir = path.dirname(agentDir);
    const packageRoot = path.resolve(process.env.OMP_REVIEW_KIT_LIVE_PACKAGE_ROOT ?? '.');
    const model = process.env.OMP_REVIEW_KIT_MODEL ?? process.env.MODEL;
    assert.ok(model, 'OMP_REVIEW_KIT_MODEL (or MODEL) must select one available model for the live slop audit');
    await mkdir(repoDir, { recursive: true });

    try {
      const sessionedOmp = await writeSessionedOmpWrapper(baseDir);

      await copyDefaultProfileConfig(agentDir);
      const install = spawnOmpSync(['--profile', profile, 'plugin', 'install', packageRoot], {
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(install.status, 0, `Plugin install failed: ${install.stderr}`);

      const git = gitAt(repoDir);
      assert.equal(git(['init']).status, 0);
      git(['config', 'user.name', 'Slop E2E Test']);
      git(['config', 'user.email', 'slop-e2e@test.local']);

      // Seed a repo with two planted slop defects:
      // 1. tests/calc.test.mjs — a vacuous check that cannot turn red (P1 dead check).
      // 2. src/human-inbox.mjs — a parasitic file-queue beside the declared native
      //    LangGraph interrupt mechanism (P2 parasitic architecture).
      await writeTree(repoDir, {
        'ARCHITECTURE.md': 'Workflow pauses use LangGraph interrupt with the SQLite checkpointer; it already persists and resumes human input. Observable product behavior is verified with node:test BDD scenarios.\n',
        'src/calc.mjs': 'export function add(a, b) { return a + b; }\n',
        'src/workflow.mjs': 'export function pauseForHuman(interrupt, state) { return interrupt({ question: state.question }); }\n',
        'src/human-inbox.mjs': "import { mkdir, writeFile } from 'node:fs/promises';\nexport async function pauseWithHumanInbox(runId, payload) { await mkdir('human-inbox', { recursive: true }); await writeFile('human-inbox/' + runId + '.json', JSON.stringify(payload)); process.exitCode = 20; }\n",
        'tests/calc.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('all 594 calculations pass', () => {\n  assert.ok(true);\n});\n",
        'REPORT.md': '# Calculation Report\n\nAll 594 checks verified and passed.\n',
      });
      git(['add', '.']);
      const commit = git(['commit', '--no-verify', '-m', 'Seed repo with planted slop defects']);
      assert.equal(commit.status, 0, commit.stderr);

      // Dispatch the native slop audit on the seeded repo (target '.' = the
      // working tree at cwd; the scout reads the tree directly).
      const prompt = new SlopPrompt({ target: '.', focus: '' }).toString();
      const result = await runLiveOmp(prompt, repoDir, 900_000, { OMP_PROFILE: profile, OMP_REVIEW_KIT_MODEL: model }, sessionedOmp);

      assert.equal(result.status, 0,
        `OMP exit=${result.status}\nstdout:\n${result.stdout.slice(0, 4000)}\nstderr:\n${result.stderr.slice(0, 1000)}`);
      assert.match(result.stdout, /VERDICT:\s*(BLOCKED|ACCEPTABLE_WITH_NOTES)/,
        `Expected a completed VERDICT (not CLEAN/ERROR)\nstdout:\n${result.stdout.slice(0, 4000)}`);
      // At least one P1/P2 finding must name a planted defect file.
      const p1p2 = result.stdout.match(/###\s*(?:🔴|🟡)[\s\S]*?(?=###\s*🟢|\*\(Отсеяно|$)/);
      assert.ok(p1p2, `Missing P1/P2 section\nstdout:\n${result.stdout.slice(0, 4000)}`);
      assert.match(p1p2[0], /calc\.test\.mjs|human-inbox\.mjs/,
        `No P1/P2 finding named a planted file\nsection:\n${p1p2[0]}`);
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
