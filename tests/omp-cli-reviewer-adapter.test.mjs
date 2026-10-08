import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OmpCliReviewerAdapter,
  mergeRegistryProxyEnv,
  containsProviderRefusal,
  formatReviewProgress,
  isChildCrash,
  isMaxTimeExpiry,
  isModelProviderFailure,
  parseReviewMaxTime,
  parseReviewProgress,
  sanitizeReviewerOutput,
} from '../src/infra/omp-cli-reviewer-adapter.mjs';

const prompt = 'review this staged change';
const cwd = process.cwd();
const isWindows = process.platform === 'win32';

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}




test('never passes a timeout to full review attempts', async () => {
  const calls = [];
  const adapter = new OmpCliReviewerAdapter({
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
    progress: (event) => progress.push(event),
    runner: async (text, root, timeoutMs, options) => {
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
    { state: 'response', text: 'model response received; checking verdict | elapsed 0s' },
  );
});

test('a provider failure is one attempt and a fast infrastructure error, never a model switch', async () => {
  const calls = [];
  const adapter = new OmpCliReviewerAdapter({
    runner: async (text, root, timeoutMs, options) => {
      calls.push({ timeoutMs, options });
      return result(1, '', '429 quota exceeded');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, undefined);
  assert.match(review.stderr, /reviewer-kit infrastructure failure/);
  assert.match(review.stderr, /does not choose models/);
  assert.match(review.stderr, /429 quota exceeded/);
  assert.deepEqual(review.modelsTried, []);
  assert.equal(review.attempts.length, 1);
  assert.equal(review.attempts[0].providerFailure, true);
});

test('a hard child crash with no output is re-run exactly once', async () => {
  let calls = 0;
  const adapter = new OmpCliReviewerAdapter({
    runner: async () => {
      calls += 1;
      return calls === 1 ? result(3221226505) : result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 0);
  assert.equal(calls, 2);
  assert.equal(review.attempts.length, 2);
  assert.equal(isChildCrash(result(-1)), true);
  assert.equal(isChildCrash(result(3221226505, 'partial output')), false);
  assert.equal(isChildCrash(result(1)), false);
});

test('a persistent child crash stops after the single re-run', async () => {
  let calls = 0;
  const adapter = new OmpCliReviewerAdapter({
    runner: async () => {
      calls += 1;
      return result(3221226505);
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.status, 3221226505);
  assert.equal(calls, 2);
});

test('an injected runner skips the real health call; an injected preflight failure blocks before any review', async () => {
  let reviewCalls = 0;
  const events = [];
  const telemetry = {
    record: async (type, payload) => events.push({ type, payload }),
    updateLastRun: async () => {},
  };
  const adapter = new OmpCliReviewerAdapter({
    runner: async () => {
      reviewCalls += 1;
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
    preflight: async (root, timeoutMs) => {
      assert.equal(root, cwd);
      assert.equal(timeoutMs, 90_000);
      return result(1, '', 'Set an API key environment variable');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(reviewCalls, 0);
  assert.equal(review.status, 1);
  assert.deepEqual(review.attempts, []);
  assert.match(review.stderr, /reviewer-kit infrastructure failure/);
  assert.match(review.stderr, /Set an API key environment variable/);
  assert.equal(events.find((e) => e.type === 'preflight_finished').payload.healthy, false);

  const healthy = new OmpCliReviewerAdapter({
    runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
    preflight: async () => result(0, 'READY'),
  });
  assert.equal((await healthy.executeReview({ prompt, cwd })).status, 0);
});

test('a preflight that exits 0 without an answer blocks fast; stderr noise beside an answer is healthy', async () => {
  const silent = new OmpCliReviewerAdapter({
    runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
    preflight: async () => result(0, '', '429 Too Many Requests'),
  });
  const blocked = await silent.executeReview({ prompt, cwd });
  assert.equal(blocked.status, 1);
  assert.deepEqual(blocked.attempts, []);

  const noisy = new OmpCliReviewerAdapter({
    runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
    preflight: async () => result(0, 'READY', "403 side model free tier (type=FreeTierError)"),
  });
  const passed = await noisy.executeReview({ prompt, cwd });
  assert.equal(passed.status, 0);
  assert.equal(passed.attempts.length, 1);
});

test('does not retry a real BLOCK verdict', async () => {
  let calls = 0;
  const adapter = new OmpCliReviewerAdapter({
    runner: async () => {
      calls += 1;
      return result(1, 'REVIEW_RESULT=BLOCK\n', 'provider quota exceeded');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(calls, 1);
  assert.equal(review.status, 1);
});

test('does not retry a review timeout', async () => {
  let runnerCalls = 0;
  const adapter = new OmpCliReviewerAdapter({
    runner: async () => {
      runnerCalls += 1;
      return result(1, '', 'Review timed out after 600000ms');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(runnerCalls, 1);
  assert.equal(review.status, 1);
});

test('provider failure detection excludes verdicts and timeouts', () => {
  assert.equal(isModelProviderFailure(result(1, '', '429 quota exceeded')), true);
  assert.equal(isModelProviderFailure(result(1, 'REVIEW_RESULT=BLOCK\n', 'review found a defect')), false);
  assert.equal(isModelProviderFailure(result(1, 'REVIEW_RESULT=BLOCK\n', 'provider quota exceeded')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'REVIEW_RESULT=BLOCK\nprovider quota exceeded')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'Review timed out after 10ms')), false);
  assert.equal(isModelProviderFailure(result(1, '', 'Model \"x\" not found')), true);
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
test('captures child pid and per-attempt telemetry records', async () => {
  const events = [];
  const telemetry = {
    record: async (type, payload) => events.push({ type, payload }),
    updateLastRun: async () => {},
  };
  const adapter = new OmpCliReviewerAdapter({
    runner: async (text, root, timeoutMs, options) => {
      options.onSpawn?.(424242);
      options.onOutput('Working...\n', 'stderr');
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(review.status, 0);
  assert.equal(review.attempts.length, 1);
  assert.equal(review.attempts[0].pid, 424242);
  assert.equal(review.attempts[0].status, 0);
  assert.equal(review.attempts[0].providerFailure, false);
  assert.ok(Number.isFinite(review.attempts[0].durationMs));
  const types = events.map((event) => event.type);
  assert.ok(types.includes('review_attempt_started'));
  assert.ok(types.includes('review_attempt_working'));
  assert.ok(types.includes('review_attempt_finished'));
  assert.equal(events.find((e) => e.type === 'review_attempt_started').payload.pid, 424242);
});

test('a throwing telemetry sink never changes the verdict', async () => {
  const telemetry = {
    record: async () => { throw new Error('telemetry exploded'); },
    updateLastRun: async () => { throw new Error('telemetry exploded'); },
  };
  const adapter = new OmpCliReviewerAdapter({
    runner: async (text, root, timeoutMs, options) => {
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
    runner: async (text, root, timeoutMs, options) => {
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

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 50);
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
    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, {
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

    const review = await OmpCliReviewerAdapter.defaultRunner('dispatch contract', cwd, 0);
    const [args, stdin] = await Promise.all([
      readFile(argsPath, 'utf8'),
      readFile(stdinPath, 'utf8'),
    ]);

    assert.equal(review.status, 0, review.stderr);
    assert.match(args, /--tools(?:\s+|=)task,read/);
    assert.doesNotMatch(stdin, /pins the active and slow model roles/);
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

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0);

    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /REVIEW_RESULT=PASS/);
    assert.doesNotMatch(review.stderr, /Review timed out/);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
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

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0);

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
      runner: async (text, root, timeoutMs, options) => {
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
      runner: async (text, root, timeoutMs, options) => {
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
    maxTime: '1s',
    runner: async () => result(0, ''),
  });

  const review = await adapter.executeReview({ prompt, cwd });

  assert.equal(review.attempts.length, 1);
  assert.equal(review.attempts[0].timedOut, true);
  assert.equal(review.attempts[0].providerFailure, false);

  const verdictAdapter = new OmpCliReviewerAdapter({
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

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, { maxTime: '15m' });

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

    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0, { maxTime: '15m&whoami' });

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


const SOCKET_ERROR_LINE = '{"level":"warn","message":"agent turn ended with provider error","provider":"devin","model":"swe-2","errorMessage":"The socket connection was closed unexpectedly."}\n';
const PROGRESS_LINE = '{"level":"debug","message":"devin: sending chat request","model":"swe-2","tools":10}\n';

test('onStage wiring accumulates stageHistory in call order into telemetry and attempt records', async () => {
  // Coverage gap 1: the onStage handler (stageHistory.push, progress emit,
  // updateLastRun with stage/stagesCompleted/stageHistory) had only
  // source-text pins. Deleting the push must fail this test.
  const updates = [];
  const telemetry = {
    record: async () => {},
    updateLastRun: async (state) => { updates.push({ hasHistory: 'stageHistory' in state, ...state, stageHistory: (state.stageHistory ?? []).map((s) => ({ ...s })) }); },
  };
  const adapter = new OmpCliReviewerAdapter({
    runner: async (text, root, timeoutMs, options) => {
      options.onSpawn?.(4242);
      options.onStage?.({ stage: 'scout', completed: 1 });
      options.onStage?.({ stage: 'verifier', completed: 2 });
      return result(0, 'REVIEW_RESULT=PASS\n');
    },
  });

  const review = await adapter.executeReview({ prompt, cwd, telemetry });

  assert.equal(review.status, 0);
  const stageUpdates = updates.filter((u) => u.hasHistory);
  assert.equal(stageUpdates.length, 2, 'one updateLastRun per onStage call');
  assert.equal(stageUpdates[0].stage, 'scout');
  assert.equal(stageUpdates[0].stagesCompleted, 1);
  assert.equal(stageUpdates[0].stageHistory.length, 1);
  assert.equal(stageUpdates[0].stageHistory[0].stage, 'scout');
  assert.equal(stageUpdates[1].stage, 'verifier');
  assert.equal(stageUpdates[1].stagesCompleted, 2);
  assert.equal(stageUpdates[1].stageHistory.length, 2);
  assert.deepEqual(stageUpdates[1].stageHistory.map((s) => s.stage), ['scout', 'verifier']);
  assert.equal(review.attempts.length, 1);
  assert.deepEqual(review.attempts[0].stageHistory.map((s) => s.stage), ['scout', 'verifier']);
});

test('stage poller dedups repeated stages and never regresses on log truncation', async () => {
  // Coverage gap 2: the restructured poller (unconditional childLogReadStage
  // per tick, dedup, monotonic rank guard) was dead in tests. Removing the
  // dedup or the rank guard must fail this test.
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-stage-poller-'));
  const logDir = path.join(baseDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\nnode -e "setTimeout(() => {}, 2000)"\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nsleep 1\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  const synthesisLog = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  const fullRun = synthesisLog([
    { message: 'Configured subagent runtime model fallback chain', role: 'subagent:ReviewerKit.ContextScout' },
    { message: 'subagent launch timing', agent: 'review-context-scout' },
    { message: 'Configured subagent runtime model fallback chain', role: 'subagent:ReviewerKit.SecurityHunter' },
    { message: 'subagent launch timing', agent: 'review-risk-hunter' },
    { message: 'Configured subagent runtime model fallback chain', role: 'subagent:ReviewerKit.CorrectnessHunter' },
    { message: 'subagent launch timing', agent: 'review-risk-hunter' },
    { message: 'Configured subagent runtime model fallback chain', role: 'subagent:ReviewerKit.FindingVerifier' },
    { message: 'subagent launch timing', agent: 'review-finding-verifier' },
  ]);
  const truncatedRun = synthesisLog([
    { message: 'Configured subagent runtime model fallback chain', role: 'subagent:ReviewerKit.ContextScout' },
  ]);
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const stages = [];
    let childPid = 0;
    const runPromise = OmpCliReviewerAdapter.defaultRunner('probe', cwd, 15000, {
      stagePollMs: 50,
      logDir,
      onSpawn: (pid) => { childPid = pid; },
      onStage: (info) => { stages.push({ ...info }); },
    });
    while (!childPid) await new Promise((r) => setTimeout(r, 10));
    await writeFile(path.join(logDir, `omp.2099-01-01.${childPid}.log`), fullRun, 'utf8');
    const deadline = Date.now() + 5000;
    while (stages.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(stages.length, 1, 'first tick reports the finished run');
    assert.equal(stages[0].stage, 'synthesis');
    assert.equal(stages[0].completed, 3, 'scout + risk + verifier stages — 3 stages, not 4 agents');
    // Truncate the tail back to scout-only: the monotonic guard must clamp
    // instead of reporting a regression, and dedup must not re-emit.
    await writeFile(path.join(logDir, `omp.2099-01-01.${childPid}.log`), truncatedRun, 'utf8');
    const review = await runPromise;
    assert.equal(review.status, 0, review.stderr);
    assert.equal(stages.length, 1, 'no regression and no duplicate stage reports');
    assert.equal(stages[0].stage, 'synthesis');
    assert.equal(stages[0].completed, 3);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});
test('stage poller forwards the child log time to onActivity while the review runs', async () => {
  // Coverage gap h: childLogAt, the activity signal behind the quiet judgement, reaches
  // telemetry only through this production poller; the adapter tests inject a mock runner.
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-activity-poller-'));
  const logDir = path.join(baseDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\nnode -e "setTimeout(() => {}, 1500)"\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nsleep 1.5\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const activity = [];
    let childPid = 0;
    const runPromise = OmpCliReviewerAdapter.defaultRunner('probe', cwd, 15000, {
      stagePollMs: 50,
      logDir,
      onSpawn: (pid) => { childPid = pid; },
      onStage: () => {},
      onActivity: (logAt) => { activity.push(logAt); },
    });
    while (!childPid) await new Promise((r) => setTimeout(r, 10));
    const logFile = path.join(logDir, `omp.2099-01-01.${childPid}.log`);
    await writeFile(logFile, `${JSON.stringify({ message: 'subagent launch timing', agent: 'review-context-scout' })}\n`, 'utf8');
    const review = await runPromise;

    assert.equal(review.status, 0, review.stderr);
    const expectedAt = new Date((await stat(logFile)).mtimeMs).toISOString();
    assert.ok(activity.includes(expectedAt), `the poller reports the log time ${expectedAt}; got ${JSON.stringify(activity)}`);
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});
test('stage poller: a tick resolving after child settle never emits onStage', async () => {
  // coverage-2: the poller's Promise.all can still be in-flight when close()
  // settles the child — without the post-settle guard its .then delivers a
  // stage update that regresses last-run state to 'reviewing'. Timing:
  // instant-exit child (~30-50ms spawn+echo) vs a fat 64MB log tail — the
  // first 5ms tick starts while the child is alive and its log read resolves
  // only after settle, deterministically crossing the boundary.
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-stage-settle-'));
  const logDir = path.join(baseDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const command = isWindows
    ? '@echo off\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previousCommand = process.env.OMP_REVIEW_KIT_OMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  const stageLine = JSON.stringify({ message: 'Configured subagent runtime model fallback chain', role: 'subagent:ReviewerKit.ContextScout' });
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);

    const stages = [];
    let resolved = false;
    let childPid = 0;
    const runPromise = OmpCliReviewerAdapter.defaultRunner('probe', cwd, 15000, {
      stagePollMs: 5,
      logDir,
      onSpawn: (pid) => { childPid = pid; },
      onStage: (info) => { stages.push({ ...info, postResolve: resolved }); },
    });
    while (!childPid) await new Promise((r) => setTimeout(r, 10));
    // 64MB tail: readLogTail's async read outlives the instant-exit child, so
    // the in-flight tick resolves strictly after close()/settle.
    const payload = stageLine + '\n' + 'x'.repeat(64 * 1024 * 1024);
    await writeFile(path.join(logDir, `omp.2099-01-01.${childPid}.log`), payload, 'utf8');
    const review = await runPromise;
    resolved = true;
    assert.equal(review.status, 0, review.stderr);
    // Let every pending tick's Promise.all settle past the read.
    await new Promise((r) => setTimeout(r, 1200));
    const postResolve = stages.filter((s) => s.postResolve);
    assert.deepEqual(postResolve, [], 'post-settle ticks must not deliver stage callbacks');
  } finally {
    if (previousCommand === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = previousCommand;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('mergeRegistryProxyEnv (src): unindented forged rows and non-REG_SZ/non-PI_ never merge; parent env not mutated', () => {
  const registryOut = [
    'HKEY_CURRENT_USER\\Environment',
    'PI_PROXY_X REG_SZ http://evil',          // no leading whitespace = forged/non-registry row
    '    PI_PROXY_EXPAND    REG_EXPAND_SZ    %SystemRoot%\\skip',
    '    NOT_PI    REG_SZ    also-skipped',
    '    PI_PROXY_META    REG_SZ    http://127.0.0.1:3128',
  ].join('\n');
  const env = { PATH: '/x' };
  const merged = mergeRegistryProxyEnv(env, registryOut);
  assert.equal(merged.PI_PROXY_X, undefined, 'unindented row must not merge');
  assert.equal(merged.PI_PROXY_EXPAND, undefined, 'REG_EXPAND_SZ must not merge');
  assert.equal(merged.NOT_PI, undefined);
  assert.equal(merged.PI_PROXY_META, 'http://127.0.0.1:3128');
  assert.deepEqual(env, { PATH: '/x' }, 'input env must not be mutated');
});

test('mergeRegistryProxyEnv (src): parent-set value wins; case-variant spelling also suppresses on win32', () => {
  const registryOut = '    PI_PROXY_META    REG_SZ    http://127.0.0.1:3128';
  // Exact-case parent wins on every platform.
  assert.equal(
    mergeRegistryProxyEnv({ PI_PROXY_META: 'parent' }, registryOut).PI_PROXY_META,
    'parent',
  );
  if (process.platform === 'win32') {
    // A lowercase/variant inherited key must still suppress the registry row —
    // else both spellings reach the child env with unpredictable resolution.
    const merged = mergeRegistryProxyEnv({ pi_proxy_meta: 'parent' }, registryOut);
    assert.equal(merged.PI_PROXY_META, undefined, 'registry row must not duplicate a case-variant parent key');
    assert.equal(merged.pi_proxy_meta, 'parent');
  } else {
    // POSIX envs are case-sensitive: distinct names both survive by design.
    const merged = mergeRegistryProxyEnv({ pi_proxy_meta: 'parent' }, registryOut);
    assert.equal(merged.PI_PROXY_META, 'http://127.0.0.1:3128');
  }
});

test('spawn env wiring: registry PI_PROXY_* reaches the child, parent-set value wins (r27 coverage-2)', { skip: !isWindows }, async () => {
  // The merge function is tested in isolation; this pins the spawn-side
  // wiring: env option must be mergeRegistryProxyEnv() output, not plain
  // process.env. A fake .cmd echoes the env slice it actually receives.
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-envwire-'));
  const commandPath = path.join(baseDir, 'fake-omp.cmd');
  const envDump = path.join(baseDir, 'envdump.txt');
  const prevOmp = process.env.OMP_REVIEW_KIT_OMP;
  const prevDump = process.env.OMP_REVIEW_TEST_ENVDUMP;
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ENVDUMP = envDump;
  const prevProbe = process.env.PI_PROXY_PROBE_REGONLY;
  const prevParent = process.env.PI_PROXY_PARENT_SET;
  try {
    delete process.env.PI_PROXY_PROBE_REGONLY; // must come ONLY from the registry merge
    process.env.PI_PROXY_PARENT_SET = 'parent-wins';
    await writeFile(commandPath, [
      '@echo off',
      `> "%OMP_REVIEW_TEST_ENVDUMP%" set PI_PROXY_`,
      'echo REVIEW_RESULT=PASS',
      'exit /b 0',
    ].join('\r\n'), 'utf8');
    const review = await OmpCliReviewerAdapter.defaultRunner('env probe', cwd, 0, {
      registryEnv: '    PI_PROXY_PROBE_REGONLY    REG_SZ    http://127.0.0.1:3199\r\n    PI_PROXY_PARENT_SET    REG_SZ    registry-loses',
    });
    assert.equal(review.status, 0, review.stderr);
    const dump = await readFile(envDump, 'utf8');
    assert.match(dump, /PI_PROXY_PROBE_REGONLY=http:\/\/127\.0\.0\.1:3199/,
      'registry-only PI_PROXY_* must reach the child env');
    assert.match(dump, /PI_PROXY_PARENT_SET=parent-wins/,
      'parent-set value must override the registry row');
    assert.doesNotMatch(dump, /PI_PROXY_PARENT_SET=registry-loses/);
  } finally {
    if (prevOmp === undefined) delete process.env.OMP_REVIEW_KIT_OMP;
    else process.env.OMP_REVIEW_KIT_OMP = prevOmp;
    if (prevDump === undefined) delete process.env.OMP_REVIEW_TEST_ENVDUMP;
    else process.env.OMP_REVIEW_TEST_ENVDUMP = prevDump;
    if (prevProbe === undefined) delete process.env.PI_PROXY_PROBE_REGONLY;
    else process.env.PI_PROXY_PROBE_REGONLY = prevProbe;
    if (prevParent === undefined) delete process.env.PI_PROXY_PARENT_SET;
    else process.env.PI_PROXY_PARENT_SET = prevParent;
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});
