import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OmpCliReviewerAdapter,
  formatReviewProgress,
  isModelProviderFailure,
  parseReviewProgress,
} from '../src/infra/omp-cli-reviewer-adapter.mjs';

const prompt = 'review this staged change';
const cwd = process.cwd();
const isWindows = process.platform === 'win32';

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}


test('uses the default model selector when no model is configured', async () => {
  const previous = process.env.OMP_REVIEW_KIT_MODEL;
  delete process.env.OMP_REVIEW_KIT_MODEL;
  try {
    let selectedModel;
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, model) => {
        selectedModel = model;
        return result(0, 'REVIEW_RESULT=PASS\n');
      },
    });

    const review = await adapter.executeReview({ prompt, cwd });

    assert.equal(review.status, 0);
    assert.equal(selectedModel, '@slow');
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_MODEL;
    else process.env.OMP_REVIEW_KIT_MODEL = previous;
  }
});


test('normalizes a non-positive probe timeout', async () => {
  let observedTimeout;
  const adapter = new OmpCliReviewerAdapter({
    primaryModel: '@slow',
    maxFallbacks: 1,
    probeTimeoutMs: 0,
    modelsProvider: async () => ['fallback/model'],
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
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['@slow', 'free/provider-model'],
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
  assert.deepEqual(review.modelsTried, ['@slow', 'free/provider-model']);
  assert.deepEqual(calls.map(({ model }) => model), ['@slow', 'free/provider-model']);
  assert.deepEqual(calls.map(({ timeoutMs }) => timeoutMs), [undefined, undefined]);
});

test('ignores timeout options for all full review attempts', async () => {
  const timeouts = [];
  const adapter = new OmpCliReviewerAdapter({
    primaryModel: '@slow',
    modelsProvider: async () => ['fallback/working'],
    modelProbe: async () => result(0, 'READY'),
    runner: async (text, root, timeoutMs, model) => {
      timeouts.push(timeoutMs);
      return model === '@slow'
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
    primaryModel: '@slow',
    modelsProvider: async () => ['free/provider-model'],
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
    primaryModel: '@slow',
    modelsProvider: async () => {
      providerCalls += 1;
      return ['free/provider-model'];
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
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['@slow', 'fallback/one', 'fallback/one', 'fallback/two', 'fallback/three'],
    modelProbe: async () => result(0),
    runner: async (text, root, timeoutMs, model) => {
      calls.push({ model, timeoutMs });
      return result(1, '', 'provider error: capacity unavailable');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.deepEqual(review.modelsTried, ['@slow', 'fallback/one', 'fallback/two']);
  assert.deepEqual(calls.map(({ timeoutMs }) => timeoutMs), [undefined, undefined, undefined]);
});

test('skips unavailable fallback candidates before spending a review attempt', async () => {
  const probes = [];
  const reviews = [];
  const adapter = new OmpCliReviewerAdapter({
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['fallback/unavailable', 'fallback/working'],
    modelProbe: async (root, timeoutMs, model) => {
      probes.push(model);
      return model === 'fallback/unavailable'
        ? result(1, '', '401 invalid API-key')
        : result(0, 'READY');
    },
    runner: async (text, root, timeoutMs, model) => {
      reviews.push(model);
      return model === '@slow'
        ? result(1, '', '429 quota exceeded')
        : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(probes, ['fallback/unavailable', 'fallback/working']);
  assert.deepEqual(reviews, ['@slow', 'fallback/working']);
  assert.deepEqual(review.modelsTried, ['@slow', 'fallback/unavailable', 'fallback/working']);
});

test('continues probing after unavailable candidates until the fallback review cap', async () => {
  const probes = [];
  const adapter = new OmpCliReviewerAdapter({
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['fallback/unavailable-1', 'fallback/unavailable-2', 'fallback/working'],
    modelProbe: async (root, timeoutMs, model) => {
      probes.push(model);
      return model === 'fallback/working' ? result(0, 'READY') : result(1, '', '401 invalid API-key');
    },
    runner: async (text, root, timeoutMs, model) => model === 'fallback/working'
      ? result(0, 'REVIEW_RESULT=PASS\n')
      : result(1, '', '429 quota exceeded'),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.deepEqual(probes, ['fallback/unavailable-1', 'fallback/unavailable-2', 'fallback/working']);
});

test('keeps the review blocked when every fallback probe fails', async () => {
  const reviews = [];
  const adapter = new OmpCliReviewerAdapter({
    primaryModel: '@slow',
    maxFallbacks: 2,
    modelsProvider: async () => ['fallback/one', 'fallback/two'],
    modelProbe: async () => result(1, '', 'provider unavailable'),
    runner: async (text, root, timeoutMs, model) => {
      reviews.push(model);
      return result(1, '', '429 quota exceeded');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.deepEqual(reviews, ['@slow']);
  assert.deepEqual(review.modelsTried, ['@slow', 'fallback/one', 'fallback/two']);
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
    primaryModel: '@slow',
    maxFallbacks: 1,
    modelsProvider: async () => ['fallback/model'],
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

test('bounds fallback model catalog discovery', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-model-catalog-timeout-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\nping -n 4 127.0.0.1 >nul\n'
    : '#!/bin/sh\nsleep 1\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  const previousFallbacks = process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  delete process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const startedAt = Date.now();
    const models = await OmpCliReviewerAdapter.defaultModelsProvider(50);

    assert.deepEqual(models, []);
    assert.ok(Date.now() - startedAt < 2000, 'catalog discovery exceeded its bound');
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    if (previousFallbacks === undefined) delete process.env.OMP_REVIEW_KIT_FALLBACK_MODELS;
    else process.env.OMP_REVIEW_KIT_FALLBACK_MODELS = previousFallbacks;
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
    ? '@echo off\nif not "%4"=="--slow" goto badargs\nif not "%5"=="%3" goto badargs\nif not "%6"=="--smol" goto badargs\nif not "%7"=="%3" goto badargs\nif "%3"=="@slow" goto quota\necho REVIEW_RESULT=PASS\nexit /b 0\n:quota\necho Cloud Code Assist API error (429): quota reached 1>&2\nexit /b 1\n:badargs\necho args=%1,%2,%3,%4,%5,%6,%7,%8,%9 1>&2\nexit /b 2\n'
    : '#!/bin/sh\nif [ "$4" != "--slow=$3" ] || [ "$5" != "--smol=$3" ] ]; then exit 2; fi\nif [ "$3" = "@slow" ]; then echo "Cloud Code Assist API error (429): quota reached" >&2; exit 1; fi\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const adapter = new OmpCliReviewerAdapter({
      primaryModel: '@slow',
      maxFallbacks: 1,
      modelsProvider: async () => ['fallback/working-model'],
    });
    const review = await adapter.executeReview({ prompt, cwd });

    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /^REVIEW_RESULT=PASS$/m);
    assert.deepEqual(review.modelsTried, ['@slow', 'fallback/working-model']);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});
