import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OmpCliReviewerAdapter,
  childLogHasQuotaSignal,
  containsProviderRefusal,
  containsQuotaStallSignal,
  formatReviewProgress,
  isMaxTimeExpiry,
  isModelProviderFailure,
  isQuotaStallStderr,
  parseReviewMaxTime,
  parseReviewProgress,
  sanitizeReviewerOutput,
} from '../src/infra/omp-cli-reviewer-adapter.mjs';

const prompt = 'review this staged change';
const cwd = process.cwd();
const isWindows = process.platform === 'win32';

const TEST_ROLES = {
  slow: 'acme/slow-max:high',
  smol: 'acme/smol-flash:high',
  task: 'acme/task-fast:high',
};
const testRoleResolver = () => TEST_ROLES;

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

const previousEffort = process.env.OMP_REVIEW_KIT_EFFORT;
test.before(() => { process.env.OMP_REVIEW_KIT_EFFORT = 'high'; });
test.after(() => {
  if (previousEffort === undefined) delete process.env.OMP_REVIEW_KIT_EFFORT;
  else process.env.OMP_REVIEW_KIT_EFFORT = previousEffort;
});


test('uses the default model selector when no model is configured', async () => {
  const previous = process.env.OMP_REVIEW_KIT_MODEL;
  delete process.env.OMP_REVIEW_KIT_MODEL;
  try {
    let selectedModel;
    const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      runner: async (text, root, timeoutMs, model) => {
        selectedModel = model;
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    const review = await adapter.executeReview({ prompt, cwd });

    assert.equal(review.status, 0);
    assert.equal(selectedModel, 'acme/smol-flash:high');
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_MODEL;
    else process.env.OMP_REVIEW_KIT_MODEL = previous;
  }
});


test('normalizes a non-positive probe timeout', async () => {
  let observedTimeout;
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 1,
    probeTimeoutMs: 0,
    modelsProvider: async () => ['fallback/model:high'],
    modelProbe: async (root, timeoutMs) => {
      observedTimeout = timeoutMs;
      return result(1, '', 'provider unavailable');
    },
    runner: async () => result(1, '', '429 quota exceeded'),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.equal(observedTimeout, 60_000);
});
test('never passes a timeout to full review attempts', async () => {
  const calls = [];
  const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      primaryModel: '@slow',
      modelProbe: async (root, timeoutMs) => {
        calls.push({ kind: 'probe', timeoutMs });
        return result(0, 'READY');
      },
      runner: async (text, root, timeoutMs) => {
        calls.push({ kind: 'review', timeoutMs });
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(calls, [{ kind: 'review', timeoutMs: undefined }]);
});

test('reports live review progress without affecting the verdict', async () => {
  const progress = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    progress: (event) => progress.push(event),
    runner: async (text, root, timeoutMs, model, options) => {
      options.onOutput('Working...\n', 'stderr');
      options.onOutput('partial model response', 'stdout');
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(progress.map((event) => event.state), ['reviewing', 'working', 'response']);
  assert.match(formatReviewProgress(progress[0]), /commit hook review started/);
  assert.deepEqual(
    parseReviewProgress(formatReviewProgress(progress[2])),
    { state: 'response', text: 'model response received; checking verdict | model @slow | elapsed 0s' },
  );
});

test('falls back after a provider quota failure and records every model tried', async () => {
  const calls = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['@slow', 'free/provider-model:high'],
    modelProbe: async () => result(0),
    runner: async (text, root, timeoutMs, model) => {
      calls.push({ text, root, timeoutMs, model });
      return calls.length === 1
        ? result(1, '', 'Cloud Code Assist API error (429): quota reached')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.equal(review.stdout, 'REVIEW_RESULT=PASS\n');
  assert.deepEqual(review.modelsTried, ['@slow', 'free/provider-model:high']);
  assert.deepEqual(calls.map(({ model }) => model), ['acme/slow-max:high', 'free/provider-model:high']);
  assert.deepEqual(calls.map(({ timeoutMs }) => timeoutMs), [undefined, undefined]);
});

test('ignores timeout options for all full review attempts', async () => {
  const timeouts = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    modelsProvider: async () => ['fallback/working:high'],
    modelProbe: async () => result(0, 'READY'),
    runner: async (text, root, timeoutMs, model) => {
      timeouts.push(timeoutMs);
      return model === 'acme/slow-max:high'
        ? result(1, '', '429 quota exceeded')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(timeouts, [undefined, undefined]);
});

test('does not retry a real BLOCK verdict', async () => {
  let calls = 0;
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    modelsProvider: async () => ['free/provider-model:high'],
    runner: async () => {
      calls += 1;
      return result(1, 'REVIEW_RESULT=BLOCK\n', 'provider quota exceeded');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(calls, 1);
  assert.equal(review.status, 1);
  assert.deepEqual(review.modelsTried, ['@slow']);
});

test('does not retry a review timeout', async () => {
  let providerCalls = 0;
  let runnerCalls = 0;
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    modelsProvider: async () => {
      providerCalls += 1;
      return ['free/provider-model:high'];
    },
    runner: async () => {
      runnerCalls += 1;
      return result(1, '', 'Review timed out after 600000ms');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(runnerCalls, 1);
  assert.equal(providerCalls, 0);
  assert.deepEqual(review.modelsTried, ['@slow']);
});

test('deduplicates fallback candidates and honors the retry cap', async () => {
  const calls = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['@slow', 'fallback/one:high', 'fallback/one:high', 'fallback/two:high', 'fallback/three:high'],
    modelProbe: async () => result(0),
    runner: async (text, root, timeoutMs, model) => {
      calls.push({ model, timeoutMs });
      return result(1, '', 'provider error: capacity unavailable');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.deepEqual(review.modelsTried, ['@slow', 'fallback/one:high', 'fallback/two:high']);
  assert.deepEqual(calls.map(({ timeoutMs }) => timeoutMs), [undefined, undefined, undefined]);
});

test('skips unavailable fallback candidates before spending a review attempt', async () => {
  const probes = [];
  const reviews = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['fallback/unavailable:high', 'fallback/working:high'],
    modelProbe: async (root, timeoutMs, model) => {
      probes.push(model);
      return model === 'fallback/unavailable:high'
        ? result(1, '', '401 invalid API-key')
        : result(0, 'READY');
    },
    runner: async (text, root, timeoutMs, model) => {
      reviews.push(model);
      return model === 'acme/slow-max:high'
        ? result(1, '', '429 quota exceeded')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(probes, ['fallback/unavailable:high', 'fallback/working:high']);
  assert.deepEqual(reviews, ['acme/slow-max:high', 'fallback/working:high']);
  assert.deepEqual(review.modelsTried, ['@slow', 'fallback/unavailable:high', 'fallback/working:high']);
});

test('continues probing after unavailable candidates until the fallback review cap', async () => {
  const probes = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['fallback/unavailable-1:high', 'fallback/unavailable-2:high', 'fallback/working:high'],
    modelProbe: async (root, timeoutMs, model) => {
      probes.push(model);
      return model === 'fallback/working:high' ? result(0, 'READY') : result(1, '', '401 invalid API-key');
    },
    runner: async (text, root, timeoutMs, model) => model === 'fallback/working:high'
      ? result(0, 'REVIEW_RESULT=PASS\n')
      : result(1, '', '429 quota exceeded'),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(probes, ['fallback/unavailable-1:high', 'fallback/unavailable-2:high', 'fallback/working:high']);
});

test('keeps the review blocked when every fallback probe fails', async () => {
  const reviews = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['fallback/one:high', 'fallback/two:high'],
    modelProbe: async () => result(1, '', 'provider unavailable'),
    runner: async (text, root, timeoutMs, model) => {
      reviews.push(model);
      return result(1, '', '429 quota exceeded');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.deepEqual(reviews, ['acme/slow-max:high']);
  assert.deepEqual(review.modelsTried, ['@slow', 'fallback/one:high', 'fallback/two:high']);
});

test('provider failure detection excludes verdicts and timeouts', () => {
  assert.equal(isModelProviderFailure(result(1, '', '429 quota exceeded')), true);
  assert.equal(isModelProviderFailure(result(1, 'REVIEW_RESULT=BLOCK\n', 'review found a defect')), false);
  assert.equal(isModelProviderFailure(result(1, 'REVIEW_RESULT=BLOCK\n', 'provider quota exceeded')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'REVIEW_RESULT=BLOCK\nprovider quota exceeded')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'Review timed out after 10ms')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'Model \"@slow\" not found')), true);
  assert.equal(isModelProviderFailure(result(1, '', 'insufficient permissions to read repository')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'insufficient quota for this request')), true);
  assert.equal(isModelProviderFailure(result(1, '', 'Set an API key environment variable')), true);
  assert.equal(isModelProviderFailure(result(1, '', 'unexpected process failure')), false);
});


test('does not classify incidental HTTP status text as provider failure', () => {
  assert.equal(isModelProviderFailure(result(1, 'Finding: HTTP 401 is expected here', '')), false);
  assert.equal(isModelProviderFailure(result(1, 'The fixture documents status 429 as an example', '')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'HTTP 429 Too Many Requests')), true);
  assert.equal(isModelProviderFailure(result(1, '', 'status code: 403 Forbidden')), true);
  assert.equal(isModelProviderFailure(result(1, 'HTTP 429 from https://provider.local/api', '')), true);
  assert.equal(isModelProviderFailure(result(1, 'Error: HTTP 401', '')), true);
  assert.equal(isModelProviderFailure(result(1, 'status 403', '')), true);
});

test('does not retry a BLOCK verdict emitted on stderr', async () => {
  let calls = 0;
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 1,
    modelsProvider: async () => ['fallback/model:high'],
    modelProbe: async () => result(0, 'READY'),
    runner: async () => {
      calls += 1;
      return calls === 1
        ? result(1, '', 'REVIEW_RESULT=BLOCK\nprovider quota exceeded')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.equal(calls, 1);
});
test('explicit fallback model configuration is parsed deterministically', async () => {
  const previous = process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
  process.env.OMP_REVIEW_KIT_FALLBACK_MODELS = ' provider/one, ,provider/two ';
  try {
    assert.deepEqual(
      await OmpCliReviewerAdapter.defaultModelsProvider(),
      ['provider/one', 'provider/two'],
    );
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
    else process.env.OMP_REVIEW_KIT_FALLBACK_MODELS = previous;
  }
});

test('default fallback chain is the @task role and never probes the model catalog', async () => {
  const previous = process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
  delete process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
  try {
    assert.deepEqual(await OmpCliReviewerAdapter.defaultModelsProvider(), ['@task']);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
    else process.env.OMP_REVIEW_KIT_FALLBACK_MODELS = previous;
  }
});

test('falls back from @smol to @task on provider failure', async () => {
  const reviews = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    maxFallbacks: 1,
    modelsProvider: OmpCliReviewerAdapter.defaultModelsProvider,
    modelProbe: async () => result(0, 'READY'),
    runner: async (text, root, timeoutMs, model) => {
      reviews.push(model);
      return model === 'acme/smol-flash:high'
        ? result(1, '', 'Cloud Code Assist API error (429): quota reached')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(reviews, ['acme/smol-flash:high', 'acme/task-fast:high']);
  assert.deepEqual(review.modelsTried, ['@smol', '@task']);
});

test('blocks with actionable UX when every model in the chain is unavailable', async () => {
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    maxFallbacks: 1,
    modelsProvider: OmpCliReviewerAdapter.defaultModelsProvider,
    modelProbe: async () => result(1, '', 'provider unavailable'),
    runner: async () => result(1, '', '429 quota exceeded'),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.doesNotMatch(review.stderr, /REVIEW_RESULT=/);
  assert.match(review.stderr, /infrastructure failure/);
  assert.match(review.stderr, /not a code verdict/);
  assert.match(review.stderr, /@smol -> @task/);
  assert.match(review.stderr, /modelRoles\.smol/);
  assert.match(review.stderr, /OMP_REVIEW_KIT_FALLBACK_MODELS/);
  assert.match(review.stderr, /audit-reports\/commit-reviews/);
});

test('resolves @role selectors to concrete models before spawning', async () => {
  const resolved = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    runner: async (text, root, timeoutMs, model) => {
      resolved.push(model);
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(resolved, ['acme/smol-flash:high']);
  assert.equal(review.attempts[0].model, '@smol');
  assert.equal(review.attempts[0].resolvedModel, 'acme/smol-flash:high');
});

test('does not call the role resolver for concrete model selectors', async () => {
  let resolverCalls = 0;
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: () => {
      resolverCalls += 1;
      return TEST_ROLES;
    },
    primaryModel: 'acme/explicit-1',
    runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.equal(resolverCalls, 0);
});

test('an unresolvable role is a provider failure that triggers the fallback chain', async () => {
  const reviews = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: () => ({ task: 'acme/task-fast:high' }),
    primaryModel: '@smol',
    maxFallbacks: 1,
    modelsProvider: async () => ['@task'],
    modelProbe: async () => result(0, 'READY'),
    runner: async (text, root, timeoutMs, model) => {
      reviews.push(model);
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(reviews, ['acme/task-fast:high']);
  assert.equal(review.attempts[0].model, '@smol');
  assert.equal(review.attempts[0].providerFailure, true);
  assert.equal(review.attempts[0].resolvedModel, undefined);
});

test('emits roles_resolved once even across multiple attempts', async () => {
  const events = [];
  const telemetry = {
    record: async (type, payload) => events.push({ type, payload }),
    updateLastRun: async () => {},
  };
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    maxFallbacks: 1,
    modelsProvider: async () => ['@task'],
    modelProbe: async () => result(0, 'READY'),
    runner: async (text, root, timeoutMs, model, options) => {
      options?.onSpawn?.(101);
      return model === 'acme/smol-flash:high'
        ? result(1, '', '429 quota exceeded')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(review.status, 0);
  const rolesEvents = events.filter((event) => event.type === 'roles_resolved');
  assert.equal(rolesEvents.length, 1);
  assert.equal(rolesEvents[0].payload.roles.smol, 'acme/smol-flash:high');
  const started = events.find((event) => event.type === 'review_attempt_started');
  assert.equal(started.payload.resolvedModel, 'acme/smol-flash:high');
});

test('captures child pid and per-attempt telemetry records', async () => {
  const events = [];
  const telemetry = {
    record: async (type, payload) => events.push({ type, payload }),
    updateLastRun: async () => {},
  };
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    runner: async (text, root, timeoutMs, model, options) => {
      options.onSpawn?.(424242);
      options.onOutput('Working...\n', 'stderr');
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(review.status, 0);
  assert.equal(review.attempts.length, 1);
  assert.equal(review.attempts[0].pid, 424242);
  assert.equal(review.attempts[0].model, '@smol');
  assert.equal(review.attempts[0].status, 0);
  assert.equal(review.attempts[0].providerFailure, false);
  assert.ok(Number.isFinite(review.attempts[0].durationMs));
  const types = events.map((event) => event.type);
  assert.ok(types.includes('review_attempt_started'));
  assert.ok(types.includes('review_attempt_working'));
  assert.ok(types.includes('review_attempt_finished'));
  assert.equal(events.find((e) => e.type === 'review_attempt_started').payload.pid, 424242);
});

test('records probe telemetry when falling back', async () => {
  const events = [];
  const telemetry = {
    record: async (type, payload) => events.push({ type, payload }),
    updateLastRun: async () => {},
  };
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    maxFallbacks: 1,
    modelsProvider: async () => ['@task'],
    modelProbe: async () => result(0, 'READY'),
    runner: async (text, root, timeoutMs, model) => (model === 'acme/smol-flash:high'
      ? result(1, '', '429 quota exceeded')
      : result(0, 'REVIEW_RESULT=PASS\n')),
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(review.status, 0);
  assert.equal(review.probes.length, 1);
  assert.equal(review.probes[0].model, '@task');
  assert.equal(review.probes[0].resolvedModel, 'acme/task-fast:high');
  assert.equal(review.probes[0].status, 0);
  const types = events.map((event) => event.type);
  assert.ok(types.includes('probe_started'));
  assert.ok(types.includes('probe_finished'));
});

test('a throwing telemetry sink never changes the verdict', async () => {
  const telemetry = {
    record: async () => { throw new Error('telemetry exploded'); },
    updateLastRun: async () => { throw new Error('telemetry exploded'); },
  };
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    runner: async (text, root, timeoutMs, model, options) => {
      options.onSpawn?.(1);
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(review.status, 0);
  assert.match(review.stdout, /REVIEW_RESULT=PASS/);
});

test('a missing telemetry sink still returns attempt records', async () => {
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@smol',
    runner: async (text, root, timeoutMs, model, options) => {
      options.onSpawn?.(7);
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.equal(review.attempts.length, 1);
  assert.equal(review.attempts[0].pid, 7);
  assert.deepEqual(review.probes, []);
});

test('POSIX review timeout escalates termination for a SIGTERM-resistant process group', { skip: isWindows }, async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-posix-kill-e2e-'));
  const commandPath = path.join(baseDir, 'fake-omp.sh');
  const pidPath = path.join(baseDir, 'pid.txt');
  const command = '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" > "$OMP_REVIEW_TEST_PID"\nwhile :; do sleep 1; done\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  const previousPidPath = process.env.OMP_REVIEW_TEST_PID;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_PID = pidPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 50, '@smol');
    const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);

    assert.match(review.stderr, /Review timed out/);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    if (previousPidPath === undefined) delete process.env.OMP_REVIEW_TEST_PID;
    else process.env.OMP_REVIEW_TEST_PID = previousPidPath;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner reports the spawned child pid', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-pid-e2e-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    let spawnedPid;
    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, '@smol', {
      onSpawn: (pid) => { spawnedPid = pid; },
    });

    assert.equal(review.status, 0, review.stderr);
    assert.ok(Number.isInteger(spawnedPid));
    assert.equal(review.pid, spawnedPid);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('rejects unsafe model selectors before spawning a review process', async () => {
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = isWindows ? 'omp.cmd' : 'omp';
  try {
    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'x&whoami');
    assert.equal(review.status, 1);
    assert.match(review.stderr, /unsafe model selector/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
  }
});
test('default subprocess runner exposes task and read while omitting task-schema overrides', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-dispatch-contract-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const argsPath = path.join(baseDir, 'args.txt');
  const stdinPath = path.join(baseDir, 'stdin.txt');
  const command = isWindows
    ? '@echo off\n> "%OMP_REVIEW_TEST_ARGS%" echo %*\nmore > "%OMP_REVIEW_TEST_STDIN%"\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_REVIEW_TEST_ARGS"\ncat > "$OMP_REVIEW_TEST_STDIN"\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  const previousArgsPath = process.env.OMP_REVIEW_TEST_ARGS;
  const previousStdinPath = process.env.OMP_REVIEW_TEST_STDIN;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ARGS = argsPath;
  process.env.OMP_REVIEW_TEST_STDIN = stdinPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('dispatch contract', cwd, 0, 'provider/model');
    const [args, stdin] = await Promise.all([
      readFile(argsPath, 'utf8'),
      readFile(stdinPath, 'utf8'),
    ]);

    assert.equal(review.status, 0, review.stderr);
    assert.match(args, /--tools(?:\s+|=)task,read/);
    assert.match(stdin, /CLI already pins the active and slow model roles/);
    assert.match(stdin, /Use task calls without model, outputSchema, schemaMode, or isolated fields/);
    assert.doesNotMatch(stdin, /Pass model:/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    if (previousArgsPath === undefined) delete process.env.OMP_REVIEW_TEST_ARGS;
    else process.env.OMP_REVIEW_TEST_ARGS = previousArgsPath;
    if (previousStdinPath === undefined) delete process.env.OMP_REVIEW_TEST_STDIN;
    else process.env.OMP_REVIEW_TEST_STDIN = previousStdinPath;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner does not cancel when timeout is zero', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-no-timeout-e2e-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\nping -n 2 127.0.0.1 >nul\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nsleep 0.2\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, '@slow');

    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /REVIEW_RESULT=PASS/);
    assert.doesNotMatch(review.stderr, /Review timed out/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner completes the fallback route without an OMP spend', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-fallback-e2e-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\nif not "%4"=="--slow" goto badargs\nif not "%5"=="%3" goto badargs\nif "%3"=="acme/slow-max:high" goto quota\necho REVIEW_RESULT=PASS\nexit /b 0\n:quota\necho Cloud Code Assist API error (429): quota reached 1>&2\nexit /b 1\n:badargs\necho args=%1,%2,%3,%4,%5,%6,%7,%8,%9 1>&2\nexit /b 2\n'
    : '#!/bin/sh\nif [ "$4" != "--slow=$3" ]; then exit 2; fi\nif [ "$3" = "acme/slow-max:high" ]; then echo "Cloud Code Assist API error (429): quota reached" >&2; exit 1; fi\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      primaryModel: '@slow',
      maxFallbacks: 1,
      modelsProvider: async () => ['fallback/working:high-model'],
    });
    const review = await adapter.executeReview({ prompt, cwd });

    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /^REVIEW_RESULT=PASS$/m);
    assert.deepEqual(review.modelsTried, ['@slow', 'fallback/working:high-model']);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('OMP_REVIEW_KIT_EFFORT rewrites the effort suffix of a resolved role', async () => {
  const previous = process.env.OMP_REVIEW_KIT_EFFORT;
  process.env.OMP_REVIEW_KIT_EFFORT = 'low';
  try {
    const events = [];
    const telemetry = {
      record: async (type, payload) => events.push({ type, payload }),
      updateLastRun: async () => {},
    };
    const spawned = [];
    const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      primaryModel: '@smol',
      runner: async (text, root, timeoutMs, model) => {
        spawned.push(model);
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    const review = await adapter.executeReview({ prompt, cwd, telemetry });

    assert.equal(review.status, 0);
    assert.deepEqual(spawned, ['acme/smol-flash:low']);
    assert.equal(review.attempts[0].resolvedModel, 'acme/smol-flash:low');
    assert.equal(
      events.find((e) => e.type === 'review_chain').payload.effortOverride,
      'low'
    );
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_EFFORT;
    else process.env.OMP_REVIEW_KIT_EFFORT = previous;
  }
});

test('OMP_REVIEW_KIT_EFFORT appends effort to a concrete selector and reaches probes', async () => {
  const previous = process.env.OMP_REVIEW_KIT_EFFORT;
  process.env.OMP_REVIEW_KIT_EFFORT = 'max';
  try {
    const probed = [];
    const spawned = [];
    const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      primaryModel: 'acme/explicit-1',
      maxFallbacks: 1,
      modelsProvider: async () => ['@task'],
      modelProbe: async (root, timeoutMs, model) => {
        probed.push(model);
        return result(0, 'READY');
      },
      runner: async (text, root, timeoutMs, model) => {
        spawned.push(model);
        return model === 'acme/explicit-1:max'
          ? result(1, '', '429 quota exceeded')
          : result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    const review = await adapter.executeReview({ prompt, cwd });

    assert.equal(review.status, 0);
    assert.deepEqual(spawned, ['acme/explicit-1:max', 'acme/task-fast:max']);
    assert.deepEqual(probed, ['acme/task-fast:max']);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_EFFORT;
    else process.env.OMP_REVIEW_KIT_EFFORT = previous;
  }
});

test('without OMP_REVIEW_KIT_EFFORT resolved selectors default to low effort', async () => {
  const previous = process.env.OMP_REVIEW_KIT_EFFORT;
  delete process.env.OMP_REVIEW_KIT_EFFORT;
  try {
    const spawned = [];
    const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      primaryModel: '@task',
      runner: async (text, root, timeoutMs, model) => {
        spawned.push(model);
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    const review = await adapter.executeReview({ prompt, cwd });

    assert.equal(review.status, 0);
    assert.deepEqual(spawned, ['acme/task-fast:low']);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_EFFORT;
    else process.env.OMP_REVIEW_KIT_EFFORT = previous;
  }
});

test('sanitizeReviewerOutput removes Working... lines and normalizes CRLF to LF', () => {
  // Given
  const noise = 'Working...\n';
  const crlfNoise = '  working...  \r\n';
  const mixed = 'Review starting\r\nWorking...\r\nWarnings detected\r\n';

  // When
  const cleanNoise = sanitizeReviewerOutput(noise);
  const cleanCrlf = sanitizeReviewerOutput(crlfNoise);
  const cleanMixed = sanitizeReviewerOutput(mixed);

  // Then
  assert.equal(cleanNoise, '');
  assert.equal(cleanCrlf, '');
  assert.equal(cleanMixed, 'Review starting\nWarnings detected\n');
  assert.equal(sanitizeReviewerOutput(''), '');
  assert.equal(sanitizeReviewerOutput(null), '');
});

test('S6: stderr "Working...\\n" + clean stdout with standalone marker => combined has marker and no "Working"', async () => {
  // Given
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    runner: async () => result(0, '### Review coverage\nAll tests passed.\nREVIEW_RESULT=PASS\n', 'Working...\n'),
  });

  // When
  const review = await adapter.executeReview({ prompt, cwd });

  // Then
  assert.equal(review.status, 0);
  assert.ok(review.combined.includes('REVIEW_RESULT=PASS\n'));
  assert.ok(!review.combined.includes('Working...'));
});

test('E3: stderr/stdout with CRLF REVIEW_RESULT=PASS\\r\\n => combined contains clean REVIEW_RESULT=PASS\\n line', async () => {
  // Given
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    runner: async () => result(0, '', 'REVIEW_RESULT=PASS\r\n'),
  });

  // When
  const review = await adapter.executeReview({ prompt, cwd });

  // Then
  assert.equal(review.status, 0);
  assert.ok(review.combined.includes('REVIEW_RESULT=PASS\n'));
  assert.ok(!review.combined.includes('REVIEW_RESULT=PASS\r\n'));
});

test('E9: literal "Working..." line inside STDOUT report body => preserved byte-for-byte', async () => {
  // Given
  const stdoutBody = '### Review coverage\nWorking...\nAll tests passed.\nREVIEW_RESULT=PASS\n';
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    runner: async () => result(0, stdoutBody, 'Working...\n'),
  });

  // When
  const review = await adapter.executeReview({ prompt, cwd });

  // Then
  assert.equal(review.status, 0);
  assert.equal(review.stdout, stdoutBody);
  assert.ok(review.combined.includes(stdoutBody));
});

test('isModelProviderFailure delegates marker detection to ReviewVerdict invariant', () => {
  // Given
  const passResult = result(1, 'REVIEW_RESULT=PASS\n', '');
  const blockResult = result(1, 'REVIEW_RESULT=BLOCK\n', 'provider quota exceeded');
  const multipleResult = result(1, 'REVIEW_RESULT=PASS\nREVIEW_RESULT=BLOCK\n', '');
  const missingResult = result(1, '', '429 quota exceeded');

  // When / Then
  assert.equal(isModelProviderFailure(passResult), false);
  assert.equal(isModelProviderFailure(blockResult), false);
  assert.equal(isModelProviderFailure(multipleResult), false);
  assert.equal(isModelProviderFailure(missingResult), true);
});

test('default subprocess runner skips title and rules for the read-only review child', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-spawn-diet-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const argsPath = path.join(baseDir, 'args.txt');
  const command = isWindows
    ? '@echo off\n> "%OMP_REVIEW_TEST_ARGS%" echo %*\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_REVIEW_TEST_ARGS"\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  const previousArgsPath = process.env.OMP_REVIEW_TEST_ARGS;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ARGS = argsPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model');

    assert.equal(review.status, 0, review.stderr);
    const args = await readFile(argsPath, 'utf8');
    assert.match(args, /--no-title/);
    assert.match(args, /--no-rules/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    if (previousArgsPath === undefined) delete process.env.OMP_REVIEW_TEST_ARGS;
    else process.env.OMP_REVIEW_TEST_ARGS = previousArgsPath;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('parseReviewMaxTime accepts documented omp duration shapes', () => {
  assert.deepEqual(parseReviewMaxTime('15m'), { arg: '15m', ms: 900_000 });
  assert.deepEqual(parseReviewMaxTime('600'), { arg: '600', ms: 600_000 });
  assert.deepEqual(parseReviewMaxTime('1h'), { arg: '1h', ms: 3_600_000 });
  assert.deepEqual(parseReviewMaxTime(' 10m '), { arg: '10m', ms: 600_000 });
});

test('parseReviewMaxTime disables the bound on empty, zero, or invalid values', () => {
  for (const value of ['', '0', '  ', '10x', '-5m', '1d', 'm', '15 m', '15m;rm', null, undefined, 42]) {
    assert.deepEqual(parseReviewMaxTime(value), { arg: null, ms: null }, `value: ${String(value)}`);
  }
});

test('isMaxTimeExpiry matches only empty output at the bound', () => {
  assert.equal(isMaxTimeExpiry({ stdout: '', durationMs: 900_000, maxTimeMs: 900_000 }), true);
  assert.equal(isMaxTimeExpiry({ stdout: '  \n ', durationMs: 871_000, maxTimeMs: 900_000 }), true);
  assert.equal(isMaxTimeExpiry({ stdout: '', durationMs: 869_999, maxTimeMs: 900_000 }), false);
  assert.equal(isMaxTimeExpiry({ stdout: 'REVIEW_RESULT=PASS\n', durationMs: 900_000, maxTimeMs: 900_000 }), false);
  assert.equal(isMaxTimeExpiry({ stdout: '', durationMs: 900_000, maxTimeMs: null }), false);
  assert.equal(isMaxTimeExpiry({ stdout: '', durationMs: 900_000, maxTimeMs: 0 }), false);
});

test('review attempts forward the configured max-time while keeping the runner timeout unset', async () => {
  const previous = process.env.OMP_REVIEW_KIT_MAX_TIME;
  process.env.OMP_REVIEW_KIT_MAX_TIME = '10m';
  try {
    let observed;
    const adapter = new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      runner: async (text, root, timeoutMs, model, options) => {
        observed = { timeoutMs, maxTime: options?.maxTime };
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    await adapter.executeReview({ prompt, cwd });

    assert.deepEqual(observed, { timeoutMs: undefined, maxTime: '10m' });
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_MAX_TIME;
    else process.env.OMP_REVIEW_KIT_MAX_TIME = previous;
  }
});

test('review attempts leave max-time unset by default and forward it when configured', async () => {
  const previous = process.env.OMP_REVIEW_KIT_MAX_TIME;
  try {
    const seen = [];
    const capture = () => new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      runner: async (text, root, timeoutMs, model, options) => {
        seen.push(options?.maxTime ?? null);
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    delete process.env.OMP_REVIEW_KIT_MAX_TIME;
    await capture().executeReview({ prompt, cwd });
    process.env.OMP_REVIEW_KIT_MAX_TIME = '0';
    await capture().executeReview({ prompt, cwd });
    process.env.OMP_REVIEW_KIT_MAX_TIME = '15m';
    await capture().executeReview({ prompt, cwd });

    assert.deepEqual(seen, [null, null, '15m']);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_MAX_TIME;
    else process.env.OMP_REVIEW_KIT_MAX_TIME = previous;
  }
});

test('attempt record flags max-time expiry without triggering the fallback chain', async () => {
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    maxTime: '1s',
    runner: async () => result(0, ''),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.attempts.length, 1);
  assert.equal(review.attempts[0].timedOut, true);
  assert.equal(review.attempts[0].providerFailure, false);

  const verdictAdapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    maxTime: '1s',
    runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
  });
  const verdictReview = await verdictAdapter.executeReview({ prompt, cwd });
  assert.equal(verdictReview.attempts[0].timedOut, false);
});

test('review_chain telemetry records the effective max-time bound', async () => {
  const previous = process.env.OMP_REVIEW_KIT_MAX_TIME;
  try {
    const events = [];
    const telemetry = {
      record: async (type, payload) => events.push({ type, payload }),
      updateLastRun: async () => {},
    };
    const run = (maxTime) => new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      ...(maxTime === undefined ? {} : { maxTime }),
      runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
    }).executeReview({ prompt, cwd, telemetry });

    delete process.env.OMP_REVIEW_KIT_MAX_TIME;
    await run(undefined);
    await run('0');
    await run('15m');

    const chains = events.filter((event) => event.type === 'review_chain');
    assert.deepEqual(chains.map((event) => event.payload.maxTime), [null, null, '15m']);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_MAX_TIME;
    else process.env.OMP_REVIEW_KIT_MAX_TIME = previous;
  }
});

test('default subprocess runner forwards a valid max-time to the omp child', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-max-time-e2e-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const argsPath = path.join(baseDir, 'args.txt');
  const command = isWindows
    ? '@echo off\n> "%OMP_REVIEW_TEST_ARGS%" echo %*\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_REVIEW_TEST_ARGS"\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  const previousArgsPath = process.env.OMP_REVIEW_TEST_ARGS;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ARGS = argsPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model', { maxTime: '15m' });

    assert.equal(review.status, 0, review.stderr);
    const args = await readFile(argsPath, 'utf8');
    assert.match(args, /--max-time(?:\s+|=)15m/);
    assert.match(args, /--no-title/);
    assert.match(args, /--no-rules/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    if (previousArgsPath === undefined) delete process.env.OMP_REVIEW_TEST_ARGS;
    else process.env.OMP_REVIEW_TEST_ARGS = previousArgsPath;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner drops invalid max-time values', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-max-time-drop-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const argsPath = path.join(baseDir, 'args.txt');
  const command = isWindows
    ? '@echo off\n> "%OMP_REVIEW_TEST_ARGS%" echo %*\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_REVIEW_TEST_ARGS"\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  const previousArgsPath = process.env.OMP_REVIEW_TEST_ARGS;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ARGS = argsPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model', { maxTime: '15m&whoami' });

    assert.equal(review.status, 0, review.stderr);
    const args = await readFile(argsPath, 'utf8');
    assert.doesNotMatch(args, /--max-time/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    if (previousArgsPath === undefined) delete process.env.OMP_REVIEW_TEST_ARGS;
    else process.env.OMP_REVIEW_TEST_ARGS = previousArgsPath;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('containsProviderRefusal matches quota text anywhere in the chunk', () => {
  assert.equal(containsProviderRefusal('Cloud Code Assist API error (429): quota reached'), true);
  assert.equal(containsProviderRefusal('HTTP 429 Too Many Requests'), true);
  assert.equal(containsProviderRefusal('Working...'), false);
  assert.equal(containsProviderRefusal(''), false);
  assert.equal(containsProviderRefusal(null), false);
  assert.equal(containsProviderRefusal(undefined), false);
});

test('containsQuotaStallSignal catches mid-line log shapes the strict pattern misses', () => {
  assert.equal(containsQuotaStallSignal('Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 6h 5m'), true);
  assert.equal(containsQuotaStallSignal('"errorMessage":"429 Error 429: Daily free limit (type=INFERENCE_CAP_ERROR)"'), true);
  assert.equal(containsQuotaStallSignal('429 quota exceeded'), true);
  assert.equal(containsQuotaStallSignal('Working...'), false);
  assert.equal(containsQuotaStallSignal('"requestBytes":241285,"compressedBytes":85699'), false);
  assert.equal(containsQuotaStallSignal(''), false);
  assert.equal(containsQuotaStallSignal(null), false);
});

test('isQuotaStallStderr detects only the runner stall marker', () => {
  assert.equal(isQuotaStallStderr('Review stalled on provider quota after 300000ms\n429 quota'), true);
  assert.equal(isQuotaStallStderr('Review timed out after 60000ms\n'), false);
  assert.equal(isQuotaStallStderr('429 quota exceeded'), false);
  assert.equal(isQuotaStallStderr(''), false);
  assert.equal(isQuotaStallStderr(null), false);
});

test('review attempts forward the quota-stall bound with 5m default', async () => {
  const previous = process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS;
  try {
    const seen = [];
    const capture = () => new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      runner: async (text, root, timeoutMs, model, options) => {
        seen.push(options?.quotaStallMs);
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    delete process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS;
    await capture().executeReview({ prompt, cwd });
    process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS = '0';
    await capture().executeReview({ prompt, cwd });
    process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS = 'bogus';
    await capture().executeReview({ prompt, cwd });
    process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS = '60000';
    await capture().executeReview({ prompt, cwd });

    assert.deepEqual(seen, [300_000, 0, 300_000, 60_000]);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS;
    else process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS = previous;
  }
});

test('review_chain telemetry records the effective quota-stall bound', async () => {
  const previous = process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS;
  try {
    const events = [];
    const telemetry = {
      record: async (type, payload) => events.push({ type, payload }),
      updateLastRun: async () => {},
    };
    const run = (quotaStallMs) => new OmpCliReviewerAdapter({
      roleResolver: testRoleResolver,
      ...(quotaStallMs === undefined ? {} : { quotaStallMs }),
      runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
    }).executeReview({ prompt, cwd, telemetry });

    delete process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS;
    await run(undefined);
    await run(0);

    const chains = events.filter((event) => event.type === 'review_chain');
    assert.deepEqual(chains.map((event) => event.payload.quotaStallMs), [300_000, 0]);
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS;
    else process.env.OMP_REVIEW_KIT_QUOTA_STALL_MS = previous;
  }
});

test('quota-stall kill advances the outer chain with a fresh attempt', async () => {
  const calls = [];
  const adapter = new OmpCliReviewerAdapter({
    roleResolver: testRoleResolver,
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['@slow', 'free/provider-model:high'],
    modelProbe: async () => result(0),
    runner: async (text, root, timeoutMs, model) => {
      calls.push(model);
      return calls.length === 1
        ? result(1, '', 'Review stalled on provider quota after 300000ms\nWorking...\n')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(review.modelsTried, ['@slow', 'free/provider-model:high']);
  assert.equal(review.attempts.length, 2);
  assert.equal(review.attempts[0].stalledOnQuota, true);
  assert.equal(review.attempts[0].providerFailure, true);
  assert.equal(review.attempts[1].stalledOnQuota, false);
});

test('default subprocess runner kills a quota-grinding child and marks the stall', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-quota-stall-e2e-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\necho Cloud Code Assist API error (429): quota reached 1>&2\nping -n 6 127.0.0.1 >nul\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\necho "Cloud Code Assist API error (429): quota reached" >&2\nsleep 5\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model', { quotaStallMs: 500 });

    assert.equal(review.status, 1);
    assert.match(review.stderr, /Review stalled on provider quota after 500ms/);
    assert.match(review.stderr, /quota reached/);
    assert.equal(review.stdout, '');
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner lets stdout progress cancel the stall watchdog', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-quota-progress-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\necho Cloud Code Assist API error (429): quota reached 1>&2\necho REVIEW_RESULT=PASS\nping -n 3 127.0.0.1 >nul\nexit /b 0\n'
    : '#!/bin/sh\necho "Cloud Code Assist API error (429): quota reached" >&2\nprintf "REVIEW_RESULT=PASS\\n"\nsleep 2\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model', { quotaStallMs: 500 });

    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /REVIEW_RESULT=PASS/);
    assert.doesNotMatch(review.stderr, /Review stalled on provider quota/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner never arms the watchdog without a refusal', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-quota-quiet-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\nping -n 2 127.0.0.1 >nul\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nsleep 1\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model', { quotaStallMs: 300 });

    assert.equal(review.status, 0, review.stderr);
    assert.doesNotMatch(review.stderr, /Review stalled on provider quota/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('isModelProviderFailure classifies a stall marker without refusal text', () => {
  assert.equal(isModelProviderFailure(result(1, '', 'Review stalled on provider quota after 300000ms\nWorking...\n')), true);
  assert.equal(isModelProviderFailure(result(0, '', 'Review stalled on provider quota after 300000ms\n')), false);
});

test('childLogHasQuotaSignal reads only the matching pid log tail', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-quota-log-'));
  try {
    await writeFile(path.join(baseDir, 'omp.2026-09-17.424242.log'), '{"message":"devin: sending chat request"}\n{"errorMessage":"429 Error 429: Daily free limit (type=INFERENCE_CAP_ERROR)"}\n', 'utf8');
    await writeFile(path.join(baseDir, 'omp.2026-09-17.111.log'), '{"message":"devin: sending chat request"}\n', 'utf8');

    assert.equal(await childLogHasQuotaSignal({ logDir: baseDir, pid: 424242 }), true);
    assert.equal(await childLogHasQuotaSignal({ logDir: baseDir, pid: 111 }), false);
    assert.equal(await childLogHasQuotaSignal({ logDir: baseDir, pid: 999999 }), false);
    assert.equal(await childLogHasQuotaSignal({ logDir: path.join(baseDir, 'missing'), pid: 424242 }), false);
    assert.equal(await childLogHasQuotaSignal({ logDir: baseDir, pid: 0 }), false);
    assert.equal(await childLogHasQuotaSignal({ logDir: baseDir, pid: -5 }), false);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('default subprocess runner kills on a quota signal in the child log', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-quota-log-e2e-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const logDir = path.join(baseDir, 'logs');
  const command = isWindows
    ? '@echo off\nping -n 6 127.0.0.1 >nul\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nsleep 5\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, 'provider/model', {
      quotaStallMs: 400,
      quotaPollMs: 50,
      quotaLogDir: logDir,
      onSpawn: (pid) => {
        void (async () => {
          await mkdir(logDir, { recursive: true });
          await writeFile(path.join(logDir, `omp.2026-09-17.${pid}.log`), '{"errorMessage":"429 Error 429: Daily free limit (type=INFERENCE_CAP_ERROR)"}\n', 'utf8');
        })();
      },
    });

    assert.equal(review.status, 1);
    assert.match(review.stderr, /Review stalled on provider quota after 400ms/);
    assert.equal(review.stdout, '');
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});
