import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
for (const [concurrency, omitHunter] of [[2, false], [1, false], [2, true]]) {
test(`Given standalone OMP concurrency ${concurrency} and missing hunter ${omitHunter}, Then native policy and fail-closed gate hold`, { skip: process.env.OMP_REVIEW_KIT_OFFLINE_SDK !== '1', timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-gate-offline-'));
  try {
    const agent = path.join(root, 'agent');
    const work = path.join(root, 'work');
    await mkdir(agent);
    await mkdir(path.join(work, '.omp', 'agents'), { recursive: true });
    for (const name of ['reviewer-kit', 'review-context-scout', 'review-risk-hunter', 'review-finding-verifier']) await copyFile(path.join(repo, 'agents', `${name}.md`), path.join(work, '.omp', 'agents', `${name}.md`));
    await writeFile(path.join(agent, 'config.yml'), `modelRoles:\n  default: review-offline/fixture\n  task: review-offline/fixture\n  smol: review-offline/fixture\ntask:\n  batch: true\n  maxConcurrency: ${concurrency}\n  speculativeLaunch: true\n`);
    const manifest = path.join(root, 'manifest.json');
    const invocationToken = 'REVIEW_INVOCATION=offline';
    await writeFile(manifest, JSON.stringify({ schema: 'review-batch@1', invocationToken, prompt: 'Offline staged review fixture; no previous findings.',
      scouts: [{ id: 'Scout1', paths: ['src/a.mjs'] }, { id: 'Scout2', paths: ['src/b.mjs'] }], hunters: [{ id: 'Hunter-correctness', lane: 'correctness', paths: [] }, { id: 'Hunter-security', lane: 'security', paths: [] }] }));
    await writeFile(`${manifest}.config.yml`, 'task:\n  structured: true\n');
    const resultPath = path.join(root, 'result.json');
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, OMP_REVIEW_KIT_BATCH_MANIFEST: manifest, REVIEW_SDK_RESULT: resultPath,
      OMP_REVIEW_KIT_AUTO_SYNC: '0', OMP_REVIEW_KIT_STOP_SUPERSEDED: '0', REVIEW_SDK_OMIT_HUNTER: omitHunter ? '1' : '0' };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|OAUTH/.test(key)) delete env[key];
    const result = spawnSync(process.env.OMP_REVIEW_KIT_OMP ?? 'omp', ['--cwd', work, '--no-extensions', '--config', `${manifest}.config.yml`,
      '-e', path.join(repo, 'src', 'infra', 'review-gate-entry.mjs'), '-e', path.join(repo, 'tests', 'fixtures', 'review-sdk-probe.mjs'),
      '--no-title', '--no-rules', '--tools', 'task,read', '--session-dir', path.join(root, 'sessions'),
      '--model', 'review-offline/fixture', '--smol', 'review-offline/fixture', '--thinking', 'off', '-p', 'Run reviewer-kit'],
    { env, encoding: 'utf8', timeout: 80000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const state = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(state.externalRequests, 0);
    assert.ok(state.calls.some((c) => c.role === 'review-context-scout'));
    if (omitHunter) {
      assert.equal(state.calls.some((c) => c.role === 'review-risk-hunter'), false, 'missing batch rejected before any hunter model call');
      const evidence = (await readFile(`${manifest}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(evidence.some((e) => e.stage === 'review-risk-hunter'), false);
      assert.ok(evidence.some((e) => e.stage === 'reviewer-kit' && e.complete));
      return;
    }
    assert.ok(state.calls.some((c) => c.role === 'review-risk-hunter'));
    const events = (await readFile(`${manifest}.events`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((e) => [e.stage, e.complete]), [['review-context-scout', true], ['review-risk-hunter', true], ['reviewer-kit', true]]);
    assert.deepEqual(events[0].mergedScout.completion.scopes, ['Scout1', 'Scout2']);
    for (const [a, b] of [['Scout1', 'Scout2'], ['Hunter-correctness', 'Hunter-security']]) {
      const first = state.calls.find((c) => c.taskId === a && c.role !== 'dispatcher');
      const second = state.calls.find((c) => c.taskId === b && c.role !== 'dispatcher');
      assert.ok(first && second);
      const overlaps = second.at < first.finishedAt && first.at < second.finishedAt;
      assert.equal(overlaps, concurrency > 1, 'native semaphore, not the kit, controls overlap');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
}
