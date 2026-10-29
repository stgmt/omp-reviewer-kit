// Given/When/Then over the fallback evidence read from OMP's reviewer session log. Pure: the log is
// text, and the file seam is exercised with a real temporary file and with a missing path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFallbackEvidence, readFallbackEvidence, summarizeProviderError } from '../src/native/fallback-evidence.mjs';

const CHAIN = '{"type":"session_init","retryFallback":{"primary":"anthropic/claude-haiku-5-5:medium","chain":["openai-codex/gpt-6-luna:xhigh","openrouter/openrouter/free"]}}';
const ERROR = '{"type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"403 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"permission_error\\"}}"}}';

test('Given a log with an installed chain and a provider error, When parsed, Then the chain length and the error are read', () => {
  const evidence = parseFallbackEvidence([CHAIN, ERROR].join('\n'));
  assert.equal(evidence.chainLength, 2);
  assert.equal(evidence.errors.length, 1);
  assert.match(evidence.errors[0], /^403 /);
});

test('Given a truncated line and a successful assistant turn, When parsed, Then both are ignored and only the error counts', () => {
  const ok = '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[]}}';
  const evidence = parseFallbackEvidence(['not json at all', ok, ERROR].join('\n'));
  assert.equal(evidence.chainLength, null);
  assert.equal(evidence.errors.length, 1);
});

test('Given the same provider error twice, When parsed, Then it is reported once', () => {
  const evidence = parseFallbackEvidence([ERROR, ERROR].join('\n'));
  assert.deepEqual(evidence.errors.length, 1);
});

test('Given a log without a session_init record, When parsed, Then the chain length is unknown and no error is invented', () => {
  assert.deepEqual(parseFallbackEvidence(''), { chainLength: null, errors: [] });
});

test('Given a session log on disk, When the evidence is read, Then the file answers both questions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fallback-evidence-'));
  try {
    const file = path.join(dir, 'Review.jsonl');
    await writeFile(file, `${CHAIN}\n${ERROR}\n`, 'utf8');
    const evidence = await readFallbackEvidence(file);
    assert.equal(evidence.chainLength, 2);
    assert.equal(evidence.errors.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given no path or a path that does not exist, When the evidence is read, Then it is unknown rather than empty', async () => {
  assert.equal(await readFallbackEvidence(null), null);
  assert.equal(await readFallbackEvidence(undefined), null);
  assert.equal(await readFallbackEvidence(path.join(tmpdir(), 'no-such-review-session.jsonl')), null);
});

test('Given a multi-line provider error, When summarized, Then it becomes one bounded line', () => {
  assert.equal(summarizeProviderError('403 permission_error:\n  OAuth not allowed'), '403 permission_error: OAuth not allowed');
  assert.equal(summarizeProviderError(undefined), null);
  assert.equal(summarizeProviderError('   '), null);
  const long = summarizeProviderError('x'.repeat(500));
  assert.equal(long.length, 200);
  assert.match(long, /\.\.\.$/);
});
