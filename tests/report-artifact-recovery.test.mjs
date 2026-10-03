import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as srcAdapter from '../src/infra/omp-cli-reviewer-adapter.mjs';
import * as runnerAdapter from '../scripts/run-review.mjs';
import * as pluginAdapter from '../.omp/review-kit/run-review.mjs';
import { FileSystemSnapshotAdapter as SrcSnapshotAdapter } from '../src/infra/filesystem-snapshot-adapter.mjs';
import { StagedSnapshot } from '../src/domain/staged-snapshot.mjs';
import { ReviewPrompt } from '../src/domain/review-prompt.mjs';
import { ReviewVerdict } from '../src/domain/review-verdict.mjs';

const isWindows = process.platform === 'win32';
const cwd = process.cwd();

const REPORT = [
  '### Review coverage',
  '- `src/a.mjs` | inspected 1 unit',
  '### Verified-OK',
  '- `tests/a.test.mjs` covers the changed branch',
  '',
  'REVIEW_RESULT=PASS',
].join('\n');

const FAILURE_STDOUT = [
  'REVIEW_REJECTION_ENVELOPE_BEGIN',
  '{"schema":"review-rejection-envelope@1","kind":"review_failure","diff_hash":"x","findings":[],"non_coverable_items":[],"failure":{"code":"execution_failure","message":"Task completed but full report unreadable"}}',
  'REVIEW_REJECTION_ENVELOPE_END',
  'REVIEW_RESULT=BLOCK',
  '',
].join('\n');

// The task tool stores a string yield payload JSON-encoded under
// <session>/<artifacts>/<TaskId>.md; subagent results live one level deeper.
async function writeTaskArtifact(sessionDir, text, { taskId = 'ReviewerKit', nested = false, encode = true } = {}) {
  const dir = path.join(sessionDir, '2026-10-03T00-00-00-000Z_session', ...(nested ? ['ReviewerKit'] : []));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${taskId}.md`), encode ? JSON.stringify(text) : text);
}

const ADAPTERS = [
  ['src adapter', srcAdapter],
  ['runner copy', runnerAdapter],
  ['plugin copy', pluginAdapter],
];

const SNAPSHOT_ADAPTERS = [
  ['src snapshot adapter', SrcSnapshotAdapter],
  ['runner copy snapshot adapter', runnerAdapter.FileSystemSnapshotAdapter],
  ['plugin copy snapshot adapter', pluginAdapter.FileSystemSnapshotAdapter],
];

function promptClassOf(mod) {
  return mod.ReviewPrompt ?? ReviewPrompt;
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A fake `omp`: appends {args, env} per invocation to a JSONL dump, answers
// the model-less probe with READY and everything else with `reply`.
async function makeFakeOmp(root, reply = 'REVIEW_RESULT=PASS\n') {
  const dump = path.join(root, 'invocations.jsonl');
  const script = path.join(root, 'fake-omp-dump.mjs');
  await writeFile(script, [
    "import { appendFileSync } from 'node:fs';",
    "let input = '';",
    "process.stdin.on('data', (c) => { input += c; });",
    "process.stdin.on('end', () => {",
    '  const args = process.argv.slice(2);',
    `  appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ args, env: { num: process.env.OMP_TEST_NUM ?? null, obj: process.env.OMP_TEST_OBJ ?? null, str: process.env.OMP_TEST_STR ?? null } }) + '\\n');`,
    `  process.stdout.write(args.includes('--no-tools') ? 'READY\\n' : ${JSON.stringify(reply)});`,
    '});',
  ].join('\n'));
  const launcher = path.join(root, isWindows ? 'fake-omp-dump.cmd' : 'fake-omp-dump.sh');
  await writeFile(launcher, isWindows
    ? `@echo off\r\nnode "${script}" %*\r\n`
    : `#!/bin/sh\nexec node "${script}" "$@"\n`);
  if (!isWindows) await chmod(launcher, 0o755);
  const invocations = async () => (await readFile(dump, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { launcher, invocations };
}

for (const [label, mod] of ADAPTERS) {
  const { OmpCliReviewerAdapter, decodeTaskArtifact, recoverTaskReport, reviewOutputNeedsRecovery } = mod;

  test(`${label}: Given a dispatcher execution_failure and a persisted task result, When the attempt ends, Then the reviewer report becomes the output`, async () => {
    const events = [];
    const telemetry = { record: async (type, payload) => events.push({ type, payload }), updateLastRun: async () => {} };
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        await writeTaskArtifact(options.sessionDir, REPORT);
        return { status: 0, stdout: FAILURE_STDOUT, stderr: '' };
      },
    });

    const review = await adapter.executeReview({ prompt: 'p', cwd, telemetry });

    assert.match(review.stdout, /### Verified-OK/);
    assert.equal(review.stdout.includes('execution_failure'), false);
    assert.equal(ReviewVerdict.fromOutput(review.stdout).value, 'PASS');
    const recovered = events.find((event) => event.type === 'report_artifact_recovered');
    assert.equal(recovered.payload.reason, 'execution_failure');
    assert.equal(recovered.payload.bytes, Buffer.byteLength(REPORT));
    assert.equal(review.attempts[0].reportRecovered.reason, 'execution_failure');
    // The recovery must not rewrite the recorded dispatcher output size.
    assert.equal(review.attempts[0].stdoutBytes, Buffer.byteLength(FAILURE_STDOUT));
  });

  test(`${label}: Given dispatcher output without any verdict marker, When a task result exists, Then it is recovered as missing_marker`, async () => {
    const events = [];
    const telemetry = { record: async (type, payload) => events.push({ type, payload }), updateLastRun: async () => {} };
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        await writeTaskArtifact(options.sessionDir, REPORT);
        return { status: 0, stdout: 'Review dispatched. Awaiting settled result.\n', stderr: '' };
      },
    });

    const review = await adapter.executeReview({ prompt: 'p', cwd, telemetry });

    assert.match(review.stdout, /REVIEW_RESULT=PASS\s*$/);
    assert.equal(events.find((event) => event.type === 'report_artifact_recovered').payload.reason, 'missing_marker');
  });

  test(`${label}: Given a healthy dispatcher verdict, When an artifact also exists, Then the dispatcher output is kept untouched`, async () => {
    const dispatcherOutput = '### Review coverage\nREVIEW_RESULT=BLOCK\n';
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        await writeTaskArtifact(options.sessionDir, REPORT);
        return { status: 0, stdout: dispatcherOutput, stderr: '' };
      },
    });

    const review = await adapter.executeReview({ prompt: 'p', cwd });

    assert.equal(review.stdout, dispatcherOutput);
    assert.equal(review.attempts[0].reportRecovered, undefined);
  });

  test(`${label}: Given no usable task result, When the dispatcher failed, Then the failure output is kept (fail closed)`, async () => {
    const cases = {
      'no artifact at all': async () => {},
      'artifact without a verdict marker': (dir) => writeTaskArtifact(dir, '### Review coverage\nno marker here'),
      'subagent artifact one level too deep': (dir) => writeTaskArtifact(dir, REPORT, { nested: true }),
      'non-markdown artifact': async (dir) => {
        const sub = path.join(dir, 'session');
        await mkdir(sub, { recursive: true });
        await writeFile(path.join(sub, 'ReviewerKit.jsonl'), JSON.stringify(REPORT));
      },
    };
    for (const [name, prepare] of Object.entries(cases)) {
      const adapter = new OmpCliReviewerAdapter({
        runner: async (text, root, timeoutMs, options) => {
          await prepare(options.sessionDir);
          return { status: 0, stdout: FAILURE_STDOUT, stderr: '' };
        },
      });
      const review = await adapter.executeReview({ prompt: 'p', cwd });
      assert.equal(review.stdout, FAILURE_STDOUT, name);
      assert.equal(ReviewVerdict.fromOutput(review.stdout).value, 'BLOCK', name);
    }
  });

  test(`${label}: Given several task results, When recovering, Then the newest one with a marker wins`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rk-recover-'));
    try {
      await writeTaskArtifact(dir, 'old report\nREVIEW_RESULT=BLOCK', { taskId: 'First' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeTaskArtifact(dir, REPORT, { taskId: 'Second' });

      const recovered = await recoverTaskReport(dir);

      assert.equal(recovered.text, REPORT);
      assert.match(recovered.file, /Second\.md$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${label}: decodeTaskArtifact unwraps JSON strings only, and reviewOutputNeedsRecovery flags missing markers and execution_failure`, async () => {
    assert.equal(decodeTaskArtifact(JSON.stringify(REPORT)), REPORT);
    assert.equal(decodeTaskArtifact(REPORT), REPORT);
    assert.equal(decodeTaskArtifact('"unterminated'), '"unterminated');
    assert.equal(decodeTaskArtifact('{"summary":"OK"}'), '{"summary":"OK"}');
    assert.equal(reviewOutputNeedsRecovery('REVIEW_RESULT=PASS\n'), false);
    assert.equal(reviewOutputNeedsRecovery(''), true);
    assert.equal(reviewOutputNeedsRecovery(undefined), true);
    assert.equal(reviewOutputNeedsRecovery('text REVIEW_RESULT=PASS inline\n'), true);
    assert.equal(reviewOutputNeedsRecovery(FAILURE_STDOUT), true);
    assert.equal(await recoverTaskReport(''), null);
  });

  test(`${label}: Given a prompt with a report path, When the child is spawned, Then the path is exported and the session dir is removed afterwards`, async () => {
    const reportPath = path.join(tmpdir(), 'reviewer-kit-report-test.md');
    const seen = [];
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        seen.push({ sessionDir: options.sessionDir, env: options.env });
        assert.ok((await stat(options.sessionDir)).isDirectory());
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
    });

    await adapter.executeReview({ prompt: ReviewPrompt.forDiff('a'.repeat(64), '', [], { reportPath }), cwd });
    await adapter.executeReview({ prompt: 'plain string prompt', cwd });

    assert.equal(seen[0].env.OMP_REVIEW_KIT_REPORT_PATH, reportPath);
    assert.equal(seen[1].env, undefined);
    assert.match(path.basename(seen[0].sessionDir), new RegExp(`^reviewer-kit-session-${process.pid}-`));
    for (const { sessionDir } of seen) {
      await assert.rejects(stat(sessionDir), { code: 'ENOENT' });
    }
  });
}

for (const [label, mod] of ADAPTERS) {
  const { OmpCliReviewerAdapter, decodeTaskArtifact, recoverTaskReport } = mod;

  test(`${label}: the real reviewer-kit result shape (object with a report field) is recovered through the adapter`, async () => {
    const yielded = { verdict: 'PASS', envelope_kind: null, confirmed_findings: 0, diff_hash: 'f'.repeat(64), report: REPORT };
    assert.equal(decodeTaskArtifact(JSON.stringify(yielded)), REPORT);
    assert.equal(decodeTaskArtifact(JSON.stringify({ verdict: 'PASS' })), JSON.stringify({ verdict: 'PASS' }));
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        await writeTaskArtifact(options.sessionDir, yielded);
        return { status: 0, stdout: FAILURE_STDOUT, stderr: '' };
      },
    });

    const review = await adapter.executeReview({ prompt: 'p', cwd });

    assert.equal(review.stdout, REPORT);
  });

  test(`${label}: recovery skips an empty artifact and refuses an oversized one`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rk-size-'));
    try {
      const sub = path.join(dir, 'session');
      await mkdir(sub, { recursive: true });
      await writeFile(path.join(sub, 'Empty.md'), '');
      await writeTaskArtifact(dir, REPORT, { taskId: 'Marker' });
      const recovered = await recoverTaskReport(dir);
      assert.match(recovered.file, /Marker\.md$/);
      assert.equal(recovered.text, REPORT);

      const big = await mkdtemp(path.join(tmpdir(), 'rk-big-'));
      try {
        await writeTaskArtifact(big, `${'x'.repeat(9 * 1024 * 1024)}\n${REPORT}`);
        assert.equal(await recoverTaskReport(big), null);
      } finally {
        await rm(big, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${label}: when the session dir cannot be created the attempt degrades without recovery`, async () => {
    const events = [];
    const telemetry = { record: async (type, payload) => events.push({ type, payload }), updateLastRun: async () => {} };
    const missing = path.join(tmpdir(), `rk-missing-${process.pid}-${Date.now()}`, 'nested');
    const seen = [];
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        seen.push(options);
        return { status: 0, stdout: FAILURE_STDOUT, stderr: '' };
      },
    });

    const review = await withEnv({ TEMP: missing, TMP: missing, TMPDIR: missing }, () => adapter.executeReview({ prompt: 'p', cwd, telemetry }));

    assert.equal(seen[0].sessionDir, undefined);
    assert.equal(review.attempts[0].reportRecovered, undefined);
    assert.equal(events.some((event) => event.type === 'report_artifact_recovered'), false);
    assert.equal(review.stdout, FAILURE_STDOUT);
  });

  test(`${label}: the crash retry keeps the report path and gets its own session dir`, async () => {
    const reportPath = path.join(tmpdir(), 'reviewer-kit-report-retry.md');
    const calls = [];
    const adapter = new OmpCliReviewerAdapter({
      runner: async (text, root, timeoutMs, options) => {
        calls.push({ env: options.env, sessionDir: options.sessionDir });
        if (calls.length === 1) return { status: -1, stdout: '', stderr: '' };
        await writeTaskArtifact(options.sessionDir, REPORT);
        return { status: 0, stdout: 'Working...\n', stderr: '' };
      },
    });

    const review = await adapter.executeReview({ prompt: promptClassOf(mod).forDiff('d'.repeat(64), '', [], { reportPath }), cwd });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].env.OMP_REVIEW_KIT_REPORT_PATH, reportPath);
    assert.equal(calls[1].env.OMP_REVIEW_KIT_REPORT_PATH, reportPath);
    assert.notEqual(calls[0].sessionDir, calls[1].sessionDir);
    for (const { sessionDir } of calls) {
      assert.match(path.basename(sessionDir), new RegExp(`^reviewer-kit-session-${process.pid}-`));
      await assert.rejects(stat(sessionDir), { code: 'ENOENT' });
    }
    assert.equal(review.stdout, REPORT);
  });

  test(`${label}: model-less probes and verbatim re-emit stay ephemeral (--no-session, never --session-dir)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-argv-'));
    try {
      const fake = await makeFakeOmp(root);
      await withEnv({ OMP_REVIEW_KIT_OMP: fake.launcher }, async () => {
        await OmpCliReviewerAdapter.defaultPreflight(cwd, 15_000);
        await new OmpCliReviewerAdapter({ preflight: null }).reemitVerbatim({ prompt: 'p', cwd });
      });

      const calls = await fake.invocations();
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.ok(call.args.includes('--no-session'), call.args.join(' '));
        assert.equal(call.args.includes('--session-dir'), false, call.args.join(' '));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${label}: defaultRunner exports only string env values to the child`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-env-'));
    try {
      const fake = await makeFakeOmp(root);
      await withEnv({ OMP_REVIEW_KIT_OMP: fake.launcher, OMP_TEST_NUM: undefined, OMP_TEST_OBJ: undefined, OMP_TEST_STR: undefined }, () =>
        OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, { env: { OMP_TEST_NUM: 42, OMP_TEST_OBJ: { a: 1 }, OMP_TEST_STR: 'kept' } }));

      const [call] = await fake.invocations();
      assert.deepEqual(call.env, { num: null, obj: null, str: 'kept' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${label}: ReviewPrompt carries the report path accessor and the best-effort wording`, () => {
    const Prompt = promptClassOf(mod);
    const reportPath = path.join(tmpdir(), 'reviewer-kit-report-accessor.md');
    const withPath = Prompt.forDiff('b'.repeat(64), '', [], { reportPath });
    const withoutPath = Prompt.forDiff('b'.repeat(64));

    assert.equal(withPath.reportPath, reportPath);
    assert.match(withPath.toString(), /best-effort durable copy/);
    assert.equal(withoutPath.reportPath, null);
  });
}

for (const [label, mod] of ADAPTERS) {
  const { OmpCliReviewerAdapter, decodeTaskArtifact, recoverTaskReport } = mod;

  test(`${label}: recoverTaskReport resolves null instead of rejecting for an unreadable or invalid session dir`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-badsession-'));
    try {
      const file = path.join(root, 'not-a-dir.txt');
      await writeFile(file, 'x');
      assert.equal(await recoverTaskReport(file), null);
      assert.equal(await recoverTaskReport(path.join(root, 'deleted-before-the-call')), null);
      assert.equal(await recoverTaskReport(null), null);
      assert.equal(await recoverTaskReport(undefined), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${label}: equal mtimes pick the greater path deterministically, and a newer mtime beats a greater path`, async () => {
    const REPORT_BLOCK = 'first report\nREVIEW_RESULT=BLOCK';
    const dir = await mkdtemp(path.join(tmpdir(), 'rk-tie-'));
    try {
      const when = new Date(Date.now() - 5000);
      await writeTaskArtifact(dir, REPORT_BLOCK, { taskId: 'First' });
      await writeTaskArtifact(dir, REPORT, { taskId: 'Second' });
      for (const name of ['First', 'Second']) {
        const file = path.join(dir, '2026-10-03T00-00-00-000Z_session', `${name}.md`);
        await utimes(file, when, when);
      }

      const tied = await recoverTaskReport(dir);

      assert.match(tied.file, /Second\.md$/);
      assert.equal(tied.text, REPORT);

      const older = new Date(Date.now() - 60_000);
      const newer = new Date(Date.now() - 1000);
      const sessionDir = path.join(dir, '2026-10-03T00-00-00-000Z_session');
      await utimes(path.join(sessionDir, 'Second.md'), older, older);
      await utimes(path.join(sessionDir, 'First.md'), newer, newer);

      const byTime = await recoverTaskReport(dir);

      assert.match(byTime.file, /First\.md$/);
      assert.equal(byTime.text, REPORT_BLOCK);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${label}: recovery ignores a directory named like a report and keeps looking`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rk-trap-'));
    try {
      await mkdir(path.join(dir, 'session', 'Trap.md'), { recursive: true });
      await writeTaskArtifact(dir, REPORT, { taskId: 'Real' });

      const recovered = await recoverTaskReport(dir);

      assert.match(recovered.file, /Real\.md$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${label}: a JSON result without a usable report field is kept raw and never decoded into a verdict`, () => {
    assert.equal(decodeTaskArtifact('{"report": '), '{"report": ');
    assert.equal(decodeTaskArtifact('{"report": 5}'), '{"report": 5}');
    assert.equal(decodeTaskArtifact('  {"report":"a\\nREVIEW_RESULT=PASS"}  '), 'a\nREVIEW_RESULT=PASS');
    assert.equal(decodeTaskArtifact('null'), 'null');
  });

  test(`${label}: an empty sessionDir option keeps the child ephemeral`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-emptysess-'));
    try {
      const fake = await makeFakeOmp(root);
      await withEnv({ OMP_REVIEW_KIT_OMP: fake.launcher }, () =>
        OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, { sessionDir: '' }));

      const [call] = await fake.invocations();
      assert.ok(call.args.includes('--no-session'));
      assert.equal(call.args.includes('--session-dir'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [label, SnapshotAdapter] of SNAPSHOT_ADAPTERS) {
  test(`${label}: the orphan session sweep removes only dead-owner dirs older than the TTL`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-sweep-'));
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 60 * 1000);
    const deadPid = 2_147_483_000;
    const dirs = {
      liveOwnerOld: [`reviewer-kit-session-${process.pid}-aaaa`, old],
      deadOwnerOld: [`reviewer-kit-session-${deadPid}-bbbb`, old],
      deadOwnerRecent: [`reviewer-kit-session-${deadPid}-cccc`, recent],
      noPidOld: ['reviewer-kit-session-notapid-dddd', old],
      foreignOld: ['some-other-tool-cache', old],
    };
    const staleFile = `reviewer-kit-session-${deadPid}-stale`;
    try {
      for (const [name, when] of Object.values(dirs)) {
        await mkdir(path.join(root, name), { recursive: true });
        await utimes(path.join(root, name), when, when);
      }
      await writeFile(path.join(root, staleFile), 'not a directory');
      await utimes(path.join(root, staleFile), old, old);
      await withEnv({ TEMP: root, TMP: root, TMPDIR: root }, async () => {
        const adapter = new SnapshotAdapter();
        const dir = await adapter.create(
          new StagedSnapshot([{ path: 'a.txt', content: Buffer.from('v1') }]),
          { diffBytes: Buffer.from('diff'), changedPaths: ['a.txt'], reuseDir: path.join(root, 'reviewer-kit-snapshot-sweep') },
        );
        await adapter.remove(dir);
      });

      const left = new Set(await readdir(root));
      assert.equal(left.has(dirs.liveOwnerOld[0]), true, 'a live owner pid protects its session dir');
      assert.equal(left.has(dirs.deadOwnerOld[0]), false, 'dead owner past the TTL is swept');
      assert.equal(left.has(dirs.deadOwnerRecent[0]), true, 'inside the TTL nothing is swept');
      assert.equal(left.has(dirs.noPidOld[0]), false, 'a name without an owner pid is swept once past the TTL');
      assert.equal(left.has(dirs.foreignOld[0]), true, 'a foreign stale directory outside the session prefix is never touched');
      assert.equal(left.has(staleFile), true, 'a stale plain file under the session prefix is not a session dir and is left alone');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('ReviewPrompt exposes the report path and tells the reviewer the write is best-effort', () => {
  const reportPath = path.join(tmpdir(), 'reviewer-kit-report-x.md');
  const withPath = ReviewPrompt.forDiff('b'.repeat(64), '', [], { reportPath });
  const withoutPath = ReviewPrompt.forDiff('b'.repeat(64));

  assert.equal(withPath.reportPath, reportPath);
  assert.equal(withoutPath.reportPath, null);
  assert.match(withPath.toString(), /best-effort durable copy/);
  assert.match(withPath.toString(), /must not retry or work around it/);
  assert.equal(withoutPath.toString().includes('durable per-run report path'), false);
});

test('reviewer-kit agent treats the report write as best-effort and never works around a denial', async () => {
  const agent = await readFile(new URL('../agents/reviewer-kit.md', import.meta.url), 'utf8');

  assert.match(agent, /best-effort attempt to write/);
  assert.match(agent, /do not retry, rephrase, or work around it/);
  assert.match(agent, /the runner recovers the complete report from your yielded task result/);
});

// End to end through the real defaultRunner: a fake `omp` records its argv and
// environment, persists the task artifact where the real task tool would, and
// prints the dispatcher failure the incident produced.
for (const [label, mod] of ADAPTERS) {
  test(`${label}: defaultRunner spawns omp with --session-dir (not --no-session) and the exported report path, and recovers the report`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-fake-omp-'));
    const previousOmp = process.env.OMP_REVIEW_KIT_OMP;
    try {
      const dump = path.join(root, 'invocation.json');
      const script = path.join(root, 'fake-omp.mjs');
      await writeFile(script, [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        'const args = process.argv.slice(2);',
        "let input = '';",
        "process.stdin.on('data', (c) => { input += c; });",
        "process.stdin.on('end', () => {",
        "  if (args.includes('--no-tools')) { process.stdout.write('READY\\n'); return; }",
        "  const at = args.indexOf('--session-dir');",
        `  writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ args, reportPath: process.env.OMP_REVIEW_KIT_REPORT_PATH ?? null }));`,
        '  if (at >= 0) {',
        "    const dir = path.join(args[at + 1], 'sess');",
        '    mkdirSync(dir, { recursive: true });',
        `    writeFileSync(path.join(dir, 'ReviewerKit.md'), JSON.stringify(${JSON.stringify(REPORT)}));`,
        '  }',
        `  process.stdout.write(${JSON.stringify(FAILURE_STDOUT)});`,
        '});',
      ].join('\n'));
      const launcher = path.join(root, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
      await writeFile(launcher, isWindows
        ? `@echo off\r\nnode "${script}" %*\r\n`
        : `#!/bin/sh\nexec node "${script}" "$@"\n`);
      if (!isWindows) await chmod(launcher, 0o755);
      process.env.OMP_REVIEW_KIT_OMP = launcher;
      const reportPath = path.join(tmpdir(), 'reviewer-kit-report-e2e.md');

      const adapter = new mod.OmpCliReviewerAdapter({ preflight: null });
      const review = await adapter.executeReview({
        prompt: ReviewPrompt.forDiff('c'.repeat(64), '', [], { reportPath }),
        cwd,
      });

      const invocation = JSON.parse(await readFile(dump, 'utf8'));
      assert.ok(invocation.args.includes('--session-dir'));
      assert.equal(invocation.args.includes('--no-session'), false);
      assert.equal(invocation.reportPath, reportPath);
      assert.equal(review.stdout, REPORT);
      const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith(`reviewer-kit-session-${process.pid}-`));
      assert.deepEqual(leftovers, [], 'the per-attempt session dir must be removed');
    } finally {
      if (previousOmp === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
      else process.env.OMP_REVIEW_KIT_OMP = previousOmp;
      await rm(root, { recursive: true, force: true });
    }
  });
}
