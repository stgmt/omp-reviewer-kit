// Given/When/Then over the native task seam: engine loading, the structural overlay, reviewer
// selection, the progress line and the provenance of the reviewer. Pure: the library is not loaded.
// The engine's import seam is driven with a failing module, which is the failure it must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STRUCTURAL_OVERLAY, describeUpdate, fallbackOf, loadOmpEngine, progressEvents, provenanceOf, reviewerFromRun, reviewerTranscript, runReviewerTask, stageEvidence } from '../src/native/task-engine.mjs';

test('Given the library cannot load one of its modules, When the engine is loaded, Then loading rejects and no partial engine is returned', async () => {
  const importer = specifier => (specifier.endsWith('/config/settings')
    ? Promise.reject(new Error('cannot load config/settings'))
    : Promise.resolve({}));
  await assert.rejects(loadOmpEngine(importer), /cannot load config\/settings/);
});

test('Given the structural overlay, When read, Then it sets only task.structured and names no model, role or fallback', () => {
  assert.deepEqual(STRUCTURAL_OVERLAY, { 'task.structured': true });
});

test('Given a run with several results, When the reviewer is selected, Then it is the first result', () => {
  const first = { agent: 'reviewer-kit' };
  const second = { agent: 'review-context-scout' };
  assert.equal(reviewerFromRun({ details: { results: [first, second] } }), first);
});

test('Given a run with no results, When the reviewer is selected, Then there is no reviewer', () => {
  assert.equal(reviewerFromRun({ details: { results: [] } }), undefined);
  assert.equal(reviewerFromRun({}), undefined);
  assert.equal(reviewerFromRun(undefined), undefined);
});

test('Given a task update with results that have not exited, When described, Then each unfinished result counts as running', () => {
  assert.equal(describeUpdate({}), 'review: native task update (0 result(s), 0 running)');
  assert.equal(describeUpdate({ details: { results: [{ exitCode: 0 }, {}, {}] } }), 'review: native task update (3 result(s), 2 running)');
});

test('Given OMP progress entries, When they are turned into live events, Then only names, statuses and counters leave the engine', () => {
  const events = progressEvents({
    details: {
      progress: [
        {
          agent: 'review-context-scout',
          status: 'completed',
          durationMs: 62_000,
          tokens: 18_000,
          requests: 12,
          modelRole: 'task',
          resolvedModel: 'resolved-model',
          currentTool: 'read',
          prompt: 'text that must not travel',
        },
        { status: 'running' },
      ],
    },
  });
  assert.deepEqual(events, [
    {
      agent: 'review-context-scout',
      lane: null,
      status: 'completed',
      durationMs: 62_000,
      tokens: 18_000,
      requests: 12,
      contextTokens: null,
      role: 'task',
      model: 'resolved-model',
    },
  ]);
});

test('Given an update without progress, When live events are asked for, Then there are none', () => {
  assert.deepEqual(progressEvents({}), []);
  assert.deepEqual(progressEvents({ details: { results: [{ exitCode: 0 }] } }), []);
  assert.deepEqual(progressEvents(undefined), []);
});

test('Given a reviewer with a role and no resolved model, When its provenance is read, Then the role is kept and the model is null', () => {
  assert.deepEqual(provenanceOf({ modelRole: 'task' }), { role: 'task', model: null });
});

test('Given a reviewer with a resolved model and no role, When its provenance is read, Then the model is kept and the role is null', () => {
  assert.deepEqual(provenanceOf({ resolvedModel: 'anthropic/claude-haiku-5-5' }), { role: null, model: 'anthropic/claude-haiku-5-5' });
});

test('Given no reviewer, When its provenance is read, Then both fields are null', () => {
  assert.deepEqual(provenanceOf(undefined), { role: null, model: null });
});

test('Given OMP moved the reviewer off its requested model, When its fallback is read, Then the move and the requested selector are reported', () => {
  assert.deepEqual(fallbackOf({ resolvedModelIsFallback: true, modelOverride: ['anthropic/claude-haiku-5-5:medium'] }), {
    applied: true,
    requested: 'anthropic/claude-haiku-5-5:medium',
  });
});

test('Given OMP reports a string override and no fallback, When its fallback is read, Then the request is kept and the move is false', () => {
  assert.deepEqual(fallbackOf({ modelOverride: 'openai-codex/gpt-6-luna' }), { applied: false, requested: 'openai-codex/gpt-6-luna' });
});

test('Given no reviewer or no override, When its fallback is read, Then nothing is claimed', () => {
  assert.deepEqual(fallbackOf(undefined), { applied: false, requested: null });
  assert.deepEqual(fallbackOf({ resolvedModelIsFallback: 'true' }), { applied: false, requested: null });
});

test('Given a reviewer result with a Markdown output path, When its transcript is derived, Then the sibling JSONL log is named', () => {
  assert.equal(reviewerTranscript({ outputPath: 'C:\\sessions\\Review\\Review.md' }), 'C:\\sessions\\Review\\Review.jsonl');
});

test('Given a reviewer result without a Markdown output path, When its transcript is derived, Then there is none', () => {
  assert.equal(reviewerTranscript({ outputPath: 'C:\\sessions\\Review\\review.txt' }), null);
  assert.equal(reviewerTranscript({}), null);
  assert.equal(reviewerTranscript(undefined), null);
});

test('Given the library loads, When the engine is loaded, Then each export comes from its own module and all seven modules are requested', async () => {
  const modules = {
    '@oh-my-pi/pi-coding-agent/config/settings': { Settings: 'settings-class' },
    '@oh-my-pi/pi-coding-agent/config/model-registry': { ModelRegistry: 'registry-class' },
    '@oh-my-pi/pi-coding-agent/sdk': { discoverAuthStorage: 'discover-auth' },
    '@oh-my-pi/pi-coding-agent/session/session-manager': { SessionManager: 'session-manager-class' },
    '@oh-my-pi/pi-coding-agent/task/index': { TaskTool: 'task-tool' },
    '@oh-my-pi/pi-coding-agent/utils/event-bus': { EventBus: 'event-bus-class' },
    '@oh-my-pi/pi-coding-agent/registry/agent-registry': { MAIN_AGENT_ID: 'main-agent-id' },
  };
  const requested = [];
  const engine = await loadOmpEngine(specifier => {
    requested.push(specifier);
    return Promise.resolve(modules[specifier]);
  });
  assert.deepEqual(engine, {
    Settings: 'settings-class',
    ModelRegistry: 'registry-class',
    discoverAuthStorage: 'discover-auth',
    SessionManager: 'session-manager-class',
    TaskTool: 'task-tool',
    EventBus: 'event-bus-class',
    MAIN_AGENT_ID: 'main-agent-id',
  });
  assert.deepEqual(requested.sort(), Object.keys(modules).sort());
});

test('Given a stub engine, When the reviewer task runs, Then it calls the native task as reviewer-kit with the explicit kit root, the structural overlay and the progress line', async () => {
  const kitRoot = path.resolve('kit-root-fixture');
  const calls = {};
  const reviewer = { agent: 'reviewer-kit', exitCode: 0, aborted: false, extractedToolData: {} };
  const stub = {
    Settings: { init: async () => ({ overlay: overlayed => ({ overlayed }) }) },
    discoverAuthStorage: async () => 'auth',
    ModelRegistry: class {
      constructor(auth) { this.auth = auth; }
      async refresh() {}
    },
    SessionManager: {
      create: () => ({
        setSessionName: async () => {},
        ensureOnDisk: async () => {},
        getSessionFile: () => 'session.jsonl',
        getSessionId: () => 'sid',
        getArtifactsDir: () => 'artifacts',
        getArtifactManager: () => 'artifact-manager',
      }),
    },
    EventBus: class {},
    MAIN_AGENT_ID: 'main',
    TaskTool: {
      create: async session => {
        calls.session = session;
        return {
          execute: async (id, params, signal, onUpdate) => {
            calls.execute = { id, params };
            onUpdate({ details: { results: [{}] } });
            return { details: { results: [reviewer] } };
          },
        };
      },
    },
  };
  const progress = [];
  const result = await runReviewerTask({
    cwd: 'repo',
    kitRoot,
    assignment: 'ASSIGNMENT',
    onProgress: line => progress.push(line),
    loadEngine: async () => stub,
  });
  assert.deepEqual(calls.execute, { id: 'reviewer-kit-review', params: { agent: 'reviewer-kit', name: 'Review', task: 'ASSIGNMENT' } });
  assert.deepEqual(calls.session.effectiveExtensionRoots(), { explicit: [kitRoot], mode: 'explicit-only', configured: [], configuredLevel: 'user' });
  assert.deepEqual(calls.session.settings, { overlayed: STRUCTURAL_OVERLAY });
  assert.equal(result.reviewer, reviewer);
  assert.equal(result.sessionFile, 'session.jsonl');
  assert.deepEqual(progress, ['review: native task update (1 result(s), 1 running)']);
});

test('Given a nested result with every metric, When its evidence is read, Then the duration, tokens, requests and context are kept', () => {
  const [stage] = stageEvidence({
    extractedToolData: {
      task: [
        {
          results: [
            {
              agent: 'review-context-scout',
              modelRole: 'task',
              resolvedModel: 'resolved-model',
              exitCode: 0,
              aborted: false,
              durationMs: 62_000,
              tokens: 18_000,
              requests: 12,
              contextTokens: 5_000,
              structuredOutput: { status: 'valid', data: { test_harness: 'present' } },
            },
          ],
        },
      ],
    },
  });
  assert.equal(stage.durationMs, 62_000);
  assert.equal(stage.tokens, 18_000);
  assert.equal(stage.requests, 12);
  assert.equal(stage.contextTokens, 5_000);
});

test('Given a nested result without metrics, When its evidence is read, Then every metric stays null', () => {
  const [stage] = stageEvidence({ extractedToolData: { task: [{ results: [{ agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredOutput: { status: 'valid', data: {} } }] }] } });
  assert.equal(stage.durationMs, null);
  assert.equal(stage.tokens, null);
  assert.equal(stage.requests, null);
  assert.equal(stage.contextTokens, null);
});

test('Given several progress entries from the native task, When the reviewer task runs, Then every converted event reaches the observer and a throwing observer does not stop the review', async () => {
  const reviewer = { agent: 'reviewer-kit', exitCode: 0, aborted: false, extractedToolData: {} };
  const stub = {
    Settings: { init: async () => ({ overlay: overlayed => ({ overlayed }) }) },
    discoverAuthStorage: async () => 'auth',
    ModelRegistry: class {
      async refresh() {}
    },
    SessionManager: {
      create: () => ({
        setSessionName: async () => {},
        ensureOnDisk: async () => {},
        getSessionFile: () => 'session.jsonl',
        getSessionId: () => 'sid',
        getArtifactsDir: () => 'artifacts',
        getArtifactManager: () => 'artifact-manager',
      }),
    },
    EventBus: class {},
    MAIN_AGENT_ID: 'main',
    TaskTool: {
      create: async () => ({
        execute: async (id, params, signal, onUpdate) => {
          onUpdate({ details: { progress: [{ agent: 'review-context-scout', status: 'completed', durationMs: 1_000 }] } });
          onUpdate({ details: { progress: [{ agent: 'review-risk-hunter', status: 'completed', durationMs: 2_000 }, { agent: 'review-finding-verifier', status: 'completed', durationMs: 3_000 }] } });
          return { details: { results: [reviewer] } };
        },
      }),
    },
  };
  const seen = [];
  const result = await runReviewerTask({
    cwd: 'repo',
    kitRoot: path.resolve('kit-root-fixture'),
    assignment: 'ASSIGNMENT',
    onEvent: event => {
      seen.push(`${event.agent}:${event.status}:${event.durationMs}`);
      if (seen.length === 2) throw new Error('observer exploded');
    },
    loadEngine: async () => stub,
  });
  assert.deepEqual(seen, ['review-context-scout:completed:1000', 'review-risk-hunter:completed:2000', 'review-finding-verifier:completed:3000']);
  assert.equal(result.reviewer, reviewer);
});
