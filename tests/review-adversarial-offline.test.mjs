import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpCliReviewerAdapter } from '../src/infra/omp-cli-reviewer-adapter.mjs';
import { ReviewPrompt } from '../src/domain/review-prompt.mjs';
import { OmpCliReviewerAdapter as BundledAdapter } from '../scripts/run-review.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
for (const [label, Adapter] of [['source', OmpCliReviewerAdapter], ['bundle', BundledAdapter]]) {
  for (const [scenario, batch, blocked] of [['confirmed', true, true], ['coverage', true, true], ['missing-disposition', true, true], ['empty-scout', true, true], ['invalid-scout', true, true], ['clean', false, false], ['rejected', true, false], ['previous-fixed', true, false], ['previous-still', true, true], ['previous-missing', true, true]]) {
    test(`${label}: native offline ${scenario}, task.batch=${batch}, blocked=${blocked}`, { skip: process.env.OMP_REVIEW_KIT_OFFLINE_SDK !== '1', timeout: 90000 }, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'review-adversarial-offline-'));
      try {
        const agent = path.join(root, 'agent');
        const work = path.join(root, 'work');
        await mkdir(agent);
        await mkdir(work);
        const config = `modelRoles:\n  default: review-offline/fixture\n  task: review-offline/fixture\n  smol: review-offline/fixture\ntask:\n  batch: ${batch}\n  maxConcurrency: 2\n`;
        await writeFile(path.join(agent, 'config.yml'), config);
        const resultFile = path.join(root, 'result.json');
        let evidence;
        const adapter = new Adapter({ nativeBatch: true, runner: async (prompt, _cwd, _timeout, options) => {
          const env = { ...process.env, ...options.env, PI_CODING_AGENT_DIR: agent, REVIEW_SDK_RESULT: resultFile,
            REVIEW_SDK_SCENARIO: scenario, REVIEW_SDK_BATCH: batch ? '1' : '0', REVIEW_SDK_OMIT_HUNTER: '0',
            OMP_REVIEW_KIT_AUTO_SYNC: '0', OMP_REVIEW_KIT_STOP_SUPERSEDED: '0' };
          for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|OAUTH/.test(key)) delete env[key];
          const result = spawnSync(process.env.OMP_REVIEW_KIT_OMP ?? 'omp', ['--cwd', work, '--no-extensions',
            '--plugin-dir', repo, '-e', options.reviewGateExtension, '-e', path.join(repo, 'tests', 'fixtures', 'review-sdk-probe.mjs'),
            '--no-title', '--no-rules', '--tools', 'task,read', '--session-dir', options.sessionDir,
            '--model', 'review-offline/fixture', '--smol', 'review-offline/fixture', '--thinking', 'off', '-p', prompt],
          { env, encoding: 'utf8', timeout: 80000, maxBuffer: 2 * 1024 * 1024 });
          assert.equal(result.status, 0, result.error?.message ?? result.stderr);
          try {
            evidence = (await readFile(`${options.env.OMP_REVIEW_KIT_BATCH_MANIFEST}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
          } catch (error) { throw new Error(`Missing gate evidence: ${error.message}\nOMP stdout: ${result.stdout}\nOMP stderr: ${result.stderr}`); }
          return { status: result.status, stdout: result.stdout, stderr: result.stderr };
        } });
        const plan = { scouts: [{ id: 'Scout1', paths: ['src/a.mjs'] }, { id: 'Scout2', paths: ['src/b.mjs'] }],
          hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: ['src/a.mjs'] }, { id: 'Hunter-security', lane: 'security', paths: ['src/b.mjs'] }] };
        const result = await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), work, ['src/a.mjs', 'src/b.mjs'], { batchPlan: { ...plan, previousFindings: scenario.startsWith('previous-') ? [{ id: 'old1' }] : [] }, roundContextText: scenario.startsWith('previous-') ? 'PREVIOUS ROUND: old1 requires fixed/still_present disposition.' : '' }), cwd: work });
        assert.equal(result.status, blocked ? 1 : 0, result.stderr);
        const state = JSON.parse(await readFile(resultFile, 'utf8'));
        assert.equal(state.externalRequests, 0);
        assert.equal(await readFile(path.join(agent, 'config.yml'), 'utf8'), config);
        if (scenario === 'invalid-scout') {
          const scout = state.outputs.find((output) => output.agent === 'review-context-scout');
          assert.equal(scout.data.aborted, true);
          assert.match(scout.data.error, /Repeated invalid structured submissions/);
          assert.ok(evidence.some((event) => event.stage === 'review-context-scout' && event.complete === false));
          assert.doesNotMatch(result.stderr, /fixture owned contract inspected/);
        } else if (scenario === 'confirmed' || scenario === 'coverage') {
          const verifier = state.outputs.find((output) => output.agent === 'review-finding-verifier');
          assert.equal(verifier.valid, 'valid');
          assert.equal(verifier.data[scenario === 'confirmed' ? 'confirmed_findings' : 'confirmed_coverage_gaps'].length, 1);
          assert.ok(evidence.some((event) => event.stage === 'review-finding-verifier' && event.blocksApproval));
        } else if (scenario === 'missing-disposition' || scenario === 'empty-scout' || scenario === 'previous-missing') {
          assert.ok(evidence.some((event) => event.complete === false));
        } else {
          if (scenario.startsWith('previous-')) assert.ok(evidence.some((event) => event.stage === 'review-finding-verifier' && event.complete && event.blocksApproval === blocked));
          assert.ok(evidence.some((event) => event.stage === 'review-context-scout' && event.complete && event.mergedScout.completion.scopes.length === 2));
          assert.ok(evidence.some((event) => event.stage === 'review-risk-hunter' && event.complete && event.tasks.length === 2));
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
