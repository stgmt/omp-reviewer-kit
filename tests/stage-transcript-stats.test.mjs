import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as srcAdapter from '../src/infra/omp-cli-reviewer-adapter.mjs';
import * as srcStats from '../src/infra/stage-transcript-stats.mjs';
import * as runnerAdapter from '../scripts/run-review.mjs';

const cwd = process.cwd();
const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const iso = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();

const assistant = (offsetSeconds, ...toolNames) => JSON.stringify({
  type: 'message',
  timestamp: iso(offsetSeconds),
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '...' },
      ...toolNames.map((name) => ({ type: 'toolCall', name })),
    ],
  },
});

const transcript = (modelId, role, lines, start = 0) => [
  JSON.stringify({ type: 'session', timestamp: iso(start) }),
  JSON.stringify({ type: 'model_change', timestamp: iso(start), model: 'parent/model' }),
  JSON.stringify({ type: 'model_change', timestamp: iso(start), model: modelId, role }),
  JSON.stringify({ type: 'message', timestamp: iso(1), message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
  JSON.stringify({ type: 'message', timestamp: iso(2), message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } }),
  ...lines,
  'not json at all',
].join('\n');

const SCOUT = transcript('model/scout', 'subagent:ReviewerKit.Scout', [
  assistant(10, 'read', 'grep', 'read'),
  assistant(40, 'bash'),
  assistant(160, 'read', 'read'),
]);
const HUNTER = transcript('model/hunter', 'subagent:ReviewerKit.Hunt', [
  assistant(500, 'read'),
  assistant(700),
], 400);

async function makeSessionDir() {
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'omp-stage-stats-'));
  const artifacts = path.join(sessionDir, '2026-10-04T10-00-00-000Z_abc');
  await mkdir(path.join(artifacts, 'ReviewerKit'), { recursive: true });
  await writeFile(path.join(sessionDir, '2026-10-04T10-00-00-000Z_abc.jsonl'), '{"type":"session"}\n');
  await writeFile(path.join(artifacts, 'ReviewerKit.jsonl'), transcript('model/orchestrator', undefined, [assistant(900, 'task')], 800));
  await writeFile(path.join(artifacts, 'ReviewerKit', 'ReviewerKit.Scout.jsonl'), SCOUT);
  await writeFile(path.join(artifacts, 'ReviewerKit', 'ReviewerKit.Hunt.jsonl'), HUNTER);
  return sessionDir;
}

for (const [label, stats] of [
  ['src module', srcStats],
  ['runner copy', runnerAdapter],
]) {
  test(`${label}: stage labels come from the transcript file name`, () => {
    assert.equal(stats.stageLabelFromTranscript('ReviewerKit.Scout.jsonl'), 'Scout');
    assert.equal(stats.stageLabelFromTranscript('ReviewerKit.Verifier2.jsonl'), 'Verifier2');
    assert.equal(stats.stageLabelFromTranscript('ReviewerKit.jsonl'), 'ReviewerKit');
  });

  test(`${label}: Given a transcript, When summarised, Then turns, tool calls, turn gaps and the subagent model are counted`, () => {
    const summary = stats.summarizeTranscript(SCOUT, 'Scout');

    assert.equal(summary.stage, 'Scout');
    assert.equal(summary.turns, 3);
    assert.equal(summary.toolCalls, 6);
    assert.deepEqual(summary.tools, { read: 4, grep: 1, bash: 1 });
    assert.equal(summary.model, 'model/scout');
    assert.equal(summary.startedAtMs, T0);
    assert.equal(summary.spanMs, 160_000);
    // turn timestamps 10s, 40s, 160s -> gaps 30s and 120s
    assert.equal(summary.turnGapMedianMs, 120_000);
    assert.equal(summary.turnGapP90Ms, 120_000);
    assert.equal(summary.turnGapMaxMs, 120_000);
  });

  test(`${label}: Given a transcript with one turn or none, Then the gap fields are null and the span is zero-safe`, () => {
    const single = stats.summarizeTranscript(transcript('m', undefined, [assistant(5, 'read')]), 'X');
    assert.equal(single.turns, 1);
    assert.equal(single.turnGapMedianMs, null);
    assert.equal(single.turnGapMaxMs, null);
    const empty = stats.summarizeTranscript('', 'Empty');
    assert.equal(empty.turns, 0);
    assert.equal(empty.spanMs, 0);
    assert.equal(empty.startedAtMs, 0);
    assert.equal(empty.model, null);
  });

  test(`${label}: Given a transcript with several hundred thousand timestamped lines, Then the span is still computed`, () => {
    const filler = Array.from({ length: 300_000 }, (_, i) => JSON.stringify({ type: 'message', timestamp: iso(i % 7), message: { role: 'toolResult', content: [] } }));
    const summary = stats.summarizeTranscript(transcript('m', undefined, [...filler, assistant(900, 'read')]), 'Big');
    assert.equal(summary.startedAtMs, T0);
    assert.equal(summary.spanMs, 900_000);
    assert.equal(summary.turns, 1);
  });

  test(`${label}: Given an orchestrator transcript without subagent role, Then its own model is reported`, () => {
    const summary = stats.summarizeTranscript([
      JSON.stringify({ type: 'model_change', timestamp: iso(0), model: 'only/model' }),
      assistant(5),
    ].join('\n'), 'ReviewerKit');
    assert.equal(summary.model, 'only/model');
  });

  test(`${label}: Given a session dir, When summarised, Then stages are listed in start order including the orchestrator`, async () => {
    const sessionDir = await makeSessionDir();
    try {
      const stages = await stats.summarizeStageTranscripts(sessionDir);
      assert.deepEqual(stages.map((s) => s.stage), ['Scout', 'Hunt', 'ReviewerKit']);
      assert.equal(stages.find((s) => s.stage === 'Hunt').toolCalls, 1);
      assert.equal(stages.find((s) => s.stage === 'ReviewerKit').tools.task, 1);
      for (let i = 1; i < stages.length; i += 1) assert.ok(stages[i - 1].startedAtMs <= stages[i].startedAtMs);
      // The session's own top-level JSONL is not a stage.
      assert.equal(stages.length, 3);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test(`${label}: Given more transcripts than the cap, Then only the first 40 of an artifacts dir are summarised`, async () => {
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'omp-stage-cap-'));
    try {
      const artifacts = path.join(sessionDir, 'run_a');
      await mkdir(artifacts, { recursive: true });
      for (let i = 0; i < 45; i += 1) await writeFile(path.join(artifacts, `Agent.S${String(i).padStart(2, '0')}.jsonl`), transcript('m', undefined, [assistant(10 + i, 'read')]));
      assert.equal((await stats.summarizeStageTranscripts(sessionDir)).length, 40);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test(`${label}: Given an empty transcript and one over 64 MiB, Then neither becomes a stage`, async () => {
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'omp-stage-bounds-'));
    try {
      const artifacts = path.join(sessionDir, 'run_a');
      await mkdir(artifacts, { recursive: true });
      await writeFile(path.join(artifacts, 'Agent.Empty.jsonl'), '');
      await writeFile(path.join(artifacts, 'Agent.Huge.jsonl'), '');
      await truncate(path.join(artifacts, 'Agent.Huge.jsonl'), 64 * 1024 * 1024 + 1);
      await writeFile(path.join(artifacts, 'Agent.Fine.jsonl'), transcript('m', undefined, [assistant(10, 'read')]));
      const summarised = await stats.summarizeStageTranscripts(sessionDir);
      assert.deepEqual(summarised.map((s) => s.stage), ['Fine']);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test(`${label}: Given transcripts whose directory order is the reverse of their start order, Then stages come back in start order`, async () => {
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'omp-stage-order-'));
    try {
      const artifacts = path.join(sessionDir, 'run_a');
      await mkdir(artifacts, { recursive: true });
      for (let i = 0; i < 6; i += 1) {
        await writeFile(path.join(artifacts, `Agent.F${i}.jsonl`), [assistant(1000 - i * 100, 'read'), assistant(1000 - i * 100 + 50, 'read')].join('\n'));
      }
      const order = (await stats.summarizeStageTranscripts(sessionDir)).map((s) => s.stage);
      assert.deepEqual(order, ['F5', 'F4', 'F3', 'F2', 'F1', 'F0']);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test(`${label}: Given a missing, empty or unreadable session dir, Then the summary is an empty list and never throws`, async () => {
    assert.deepEqual(await stats.summarizeStageTranscripts(undefined), []);
    assert.deepEqual(await stats.summarizeStageTranscripts(''), []);
    assert.deepEqual(await stats.summarizeStageTranscripts(path.join(tmpdir(), 'does-not-exist-omp-stage')), []);
    const empty = await mkdtemp(path.join(tmpdir(), 'omp-stage-empty-'));
    try {
      assert.deepEqual(await stats.summarizeStageTranscripts(empty), []);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
}

for (const [label, mod] of [['src adapter', srcAdapter], ['runner copy', runnerAdapter]]) {
  test(`${label}: Given an attempt that left stage transcripts, When it finishes, Then a stage_stats event precedes review_attempt_finished`, async () => {
    const events = [];
    const telemetry = { record: async (type, payload) => events.push({ type, payload }), updateLastRun: async () => {} };
    const adapter = new mod.OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        const artifacts = path.join(options.sessionDir, '2026-10-04T10-00-00-000Z_abc', 'ReviewerKit');
        await mkdir(artifacts, { recursive: true });
        await writeFile(path.join(artifacts, 'ReviewerKit.Scout.jsonl'), SCOUT);
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
    });

    await adapter.executeReview({ prompt: 'p', cwd, telemetry });

    const types = events.map((e) => e.type);
    const statsAt = types.indexOf('stage_stats');
    assert.ok(statsAt >= 0, 'stage_stats recorded');
    assert.ok(statsAt < types.indexOf('review_attempt_finished'));
    const { payload } = events[statsAt];
    assert.equal(payload.attemptIndex, 0);
    assert.equal(payload.stages.length, 1);
    assert.equal(payload.stages[0].stage, 'Scout');
    assert.equal(payload.stages[0].turns, 3);
  });

  test(`${label}: Given an attempt without transcripts, Then no stage_stats event is recorded`, async () => {
    const events = [];
    const telemetry = { record: async (type, payload) => events.push({ type, payload }), updateLastRun: async () => {} };
    const adapter = new mod.OmpCliReviewerAdapter({
      runner: async () => ({ status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }),
    });
    await adapter.executeReview({ prompt: 'p', cwd, telemetry });
    assert.equal(events.some((e) => e.type === 'stage_stats'), false);
  });
}
