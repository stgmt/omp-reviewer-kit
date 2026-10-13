import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readStageResult, summarizeTranscript } from '../src/infra/stage-transcript-stats.mjs';
import { formatScoutBaseline, parseScoutBaseline, scoutSnapshotFingerprint } from '../src/domain/scout-baseline.mjs';

test('Given arbitrary scout task name, When role identity is genuine, Then baseline is found; misleading names miss', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rk-scout-identity-'));
  try {
    const nested = path.join(root, 'artifacts', 'Review');
    await mkdir(nested, { recursive: true });
    const file = path.join(nested, 'Review.ContextRound2');
    await writeFile(`${file}.md`, 'actual scout');
    const write = (agent, status = 'success') => writeFile(`${file}.jsonl`, [
      { type: 'session_init', agent }, { type: 'message', message: { role: 'toolResult', toolName: 'yield', details: { status } } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    await write('review-context-scout');
    assert.equal(await readStageResult(root, 'review-context-scout'), 'actual scout');
    await write('review-risk-hunter');
    assert.equal(await readStageResult(root, 'review-context-scout'), '');
    await write('review-context-scout', 'aborted');
    assert.equal(await readStageResult(root, 'review-context-scout'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Given staged dependencies, When caller, test, harness, deletion or rename changes, Then conservative fingerprint invalidates', () => {
  const files = ['src/a.mjs', 'src/consumer.mjs', 'tests/different.test.mjs', 'package.json'].map((p) => ({ path: p, content: Buffer.from('a') }));
  const before = scoutSnapshotFingerprint(files);
  assert.equal(scoutSnapshotFingerprint([...files].reverse()), before);
  for (let i = 0; i < files.length; i++) {
    const changed = files.map((f, j) => j === i ? { ...f, content: Buffer.from('b') } : f);
    assert.notEqual(scoutSnapshotFingerprint(changed), before);
  }
  assert.notEqual(scoutSnapshotFingerprint(files.slice(1)), before);
  assert.notEqual(scoutSnapshotFingerprint(files.map((f, i) => i === 0 ? { ...f, path: 'renamed.mjs' } : f)), before);
  const report = parseScoutBaseline(JSON.stringify({ coverage_map: Array.from({ length: 61 }, () => ({ behavior: 'b', file_path: 'a' })) }));
  assert.equal(report.bounds.truncated, true);
  assert.equal(report.bounds.coverageTotal, 61);
  const baseline = parseScoutBaseline(JSON.stringify({ coverage_map: [{ behavior: 'b', file_path: 'src/a.mjs', covering_test: 'tests/a.test.mjs' }] }));
  baseline.snapshotFingerprint = before;
  assert.match(formatScoutBaseline({ baseline, deltaPaths: [], round: 2, snapshotFingerprint: before }), /Fingerprint status: reusable/);
  assert.doesNotMatch(formatScoutBaseline({ baseline, deltaPaths: [], round: 2, snapshotFingerprint: scoutSnapshotFingerprint(files.slice(1)) }), /Fingerprint status: reusable/);
  baseline.bounds.truncated = true;
  assert.doesNotMatch(formatScoutBaseline({ baseline, deltaPaths: [], round: 2, snapshotFingerprint: before }), /Fingerprint status: reusable/);
});

test('Given read repetitions and late disposal, When summarising, Then work span excludes cleanup without raw input exposure', () => {
  const entries = [
    { type: 'session_init', agent: 'review-context-scout', id: 'session', timestamp: '2026-10-12T00:00:00Z' },
    ...[1, 2].map((second) => ({ type: 'message', timestamp: `2026-10-12T00:00:0${second}Z`, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'private', offset: 1, limit: 10 } }] } })),
    { type: 'message', timestamp: '2026-10-12T00:00:03Z', message: { role: 'toolResult', toolName: 'yield', details: { status: 'success' } } },
    { type: 'custom', timestamp: '2026-10-12T00:07:03Z' },
  ];
  const summary = summarizeTranscript(entries.map((e) => JSON.stringify(e)).join('\n'), 'scout');
  assert.equal(summary.repeatedReads, 1);
  assert.equal(summary.workSpanMs, 3000);
  assert.equal(summary.spanMs, 423000);
  assert.equal(JSON.stringify(summary).includes('private'), false);
});
