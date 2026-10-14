import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MUTANTS } from '../scripts/run-mutation-tests.mjs';
import { formatProviderOutageError } from '../src/infra/filesystem-telemetry-adapter.mjs';

const copies = [
  ['source', '../src/infra/omp-cli-reviewer-adapter.mjs'],
  ['bundle', '../scripts/run-review.mjs'],
];

for (const [label, modulePath] of copies) {
  test(`${label}: Given a native task dispatch, When the child reads stdin, Then receive task shape and conditional solutionSpace without policy overrides`, async () => {
    // Given a child that captures the actual dispatch input without invoking a model.
    const { OmpCliReviewerAdapter } = await import(modulePath);
    const root = await mkdtemp(path.join(tmpdir(), 'review-task-dispatch-'));
    const isWindows = process.platform === 'win32';
    const commandPath = path.join(root, isWindows ? 'omp.cmd' : 'omp.sh');
    const stdinPath = path.join(root, 'stdin.txt');
    const names = ['OMP_REVIEW_KIT_OMP', 'OMP_REVIEW_TEST_STDIN'];
    const saved = names.map((name) => process.env[name]);
    try {
      await writeFile(commandPath, isWindows
        ? '@echo off\nmore > "%OMP_REVIEW_TEST_STDIN%"\necho REVIEW_RESULT=PASS\nexit /b 0\n'
        : '#!/bin/sh\ncat > "$OMP_REVIEW_TEST_STDIN"\nprintf "REVIEW_RESULT=PASS\\n"\n');
      if (!isWindows) await chmod(commandPath, 0o755);
      process.env.OMP_REVIEW_KIT_OMP = commandPath;
      process.env.OMP_REVIEW_TEST_STDIN = stdinPath;

      // When the production runner dispatches to OMP.
      const result = await OmpCliReviewerAdapter.defaultRunner('authoritative staged inputs', root, 0);
      const stdin = await readFile(stdinPath, 'utf8');

      // Then preserve the native shape and leave schema/model policy with the agent.
      assert.equal(result.status, 0, result.stderr);
      assert.match(stdin, /authoritative staged inputs/);
      assert.match(stdin, /advertised native task shape with explicit name, agent and task/);
      assert.match(stdin, /shared context\/tasks for batch mode/);
      assert.match(stdin, /Include solutionSpace when required by that schema/);
      assert.match(stdin, /without model, outputSchema, schemaMode, or isolated fields/);
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${label}: Given HTTP 429 during preflight, When review is blocked, Then remediation names the task role rather than the default role`, async () => {
    // Given an unavailable provider and a review that must not start.
    const { OmpCliReviewerAdapter } = await import(modulePath);
    let calls = 0;
    const adapter = new OmpCliReviewerAdapter({
      preflight: async () => ({ status: 1, stdout: '', stderr: 'HTTP 429 quota' }),
      runner: async () => { calls += 1; return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }; },
    });

    // When the same task-role health path fails.
    const result = await adapter.executeReview({ prompt: 'staged review', cwd: process.cwd() });

    // Then fail closed with the correct configuration target.
    assert.equal(result.status, 1);
    assert.equal(calls, 0);
    assert.match(result.stderr, /task model role/);
    assert.doesNotMatch(result.stderr, /default model role/);
    assert.match(result.stderr, /429 quota/);
    assert.doesNotMatch(result.stderr, /REVIEW_RESULT=PASS/);
  });
}

test('Given a provider-outage diagnostic, When formatted directly, Then task-role guidance is actionable and marker-free', () => {
  const message = formatProviderOutageError('HTTP 429 quota');
  assert.match(message, /task model role/);
  assert.doesNotMatch(message, /default model role|REVIEW_RESULT=/);
  assert.match(message, /429 quota/);
});

test('Given the native-task release catalog, When loading mutants and selectors, Then every new contract has unique presence and its intended deciding test', async () => {
  // Given the release's mandatory mutation contracts and calibrated selectors.
  const catalog = JSON.parse(await readFile(new URL('../scripts/mutation-selectors.json', import.meta.url), 'utf8'));
  const expected = [];
  for (const label of ['modular', 'runner']) {
    const copy = label === 'modular' ? 'src adapter' : 'runner copy';
    for (const suffix of ['task-role-selection-omitted', 'structured-overlay-omitted']) {
      expected.push([`${label}-${suffix}`, 'tests/report-artifact-recovery.test.mjs', `${copy}: gated reviews load their own agents and select the native task role`]);
    }
    for (const suffix of ['verified-block-payload-lost', 'nonzero-verifier-rescued']) {
      expected.push([`${label}-${suffix}`, 'tests/review-gate.test.mjs', 'native verified findings']);
    }
    for (const stage of ['orchestrator', 'specialist']) {
      expected.push([`${label}-${stage}-solution-space-lost`, 'tests/review-batch.test.mjs', 'Given native solution-space metadata']);
    }
  }
  expected.push(['verifier-behavior-validation-omitted', 'tests/review-gate.test.mjs', 'native verified findings malformed']);
  for (const agent of ['reviewer-kit', 'review-context-scout', 'review-risk-hunter', 'review-finding-verifier']) {
    expected.push([`${agent}-task-role-identity-omitted`, 'tests/agent-contract.test.mjs', 'all review agents select the native task role']);
  }

  // When locating each expected entry, Then neither removal nor wrong ownership is accepted.
  for (const [id, testFile, decidingName] of expected) {
    const entries = MUTANTS.filter((mutant) => mutant.id === id);
    assert.equal(entries.length, 1, `${id}: exactly one mandatory mutant`);
    assert.equal(entries[0].testFile, testFile, id);
    const mapping = catalog.mappings[id];
    assert.ok(mapping, `${id}: calibrated selector is required`);
    assert.equal(mapping.testFile, testFile, id);
    assert.ok(mapping.tests.some((name) => name.includes(decidingName)), `${id}: intended deciding test`);
    const source = await readFile(new URL(`../${testFile}`, import.meta.url), 'utf8');
    assert.ok(source.includes(decidingName.replace(/^(src adapter|runner copy): /, '').replace(/ malformed$/, '')), `${id}: deciding declaration exists`);
  }
});
