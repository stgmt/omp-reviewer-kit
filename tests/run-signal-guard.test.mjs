import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { createSignalHandler, installRunSignalGuard } from '../src/infra/run-signal-guard.mjs';
import {
  PluginInstallerService,
  checkProcessLiveness,
  reconcileLastRun,
} from '../src/application/installer-service.mjs';

describe('Feature: Review Run Signal Guard (S7)', () => {
  it('S7a: handler("SIGINT") records run_failed, updates last-run to interrupted with force:true, and exits with 130', async () => {
    // Given fake telemetry sink and fake exit function
    const events = [];
    const lastRunUpdates = [];
    let exitCode = null;

    const telemetry = {
      record: async (type, payload) => {
        events.push({ type, payload });
      },
      updateLastRun: async (state, opts) => {
        lastRunUpdates.push({ state, opts });
      },
    };
    const exit = (code) => {
      exitCode = code;
    };

    // When invoking the signal handler with SIGINT
    const handler = createSignalHandler({
      telemetry,
      runId: 'test-run-sigint',
      exit,
      timeoutMs: 500,
    });
    await handler('SIGINT');

    // Then run_failed is recorded with interruption details
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'run_failed');
    assert.equal(events[0].payload.error, 'interrupted by signal SIGINT');

    // And last-run state is updated to interrupted with force: true and exitCode 1
    assert.equal(lastRunUpdates.length, 1);
    assert.equal(lastRunUpdates[0].state.state, 'interrupted');
    assert.equal(lastRunUpdates[0].state.error, 'interrupted by signal SIGINT');
    assert.equal(lastRunUpdates[0].state.runId, 'test-run-sigint');
    assert.equal(lastRunUpdates[0].state.exitCode, 1);
    assert.ok(typeof lastRunUpdates[0].state.finishedAt === 'string');
    assert.deepEqual(lastRunUpdates[0].opts, { force: true });

    // And process exits with 130
    assert.equal(exitCode, 130);
  });

  it('S7b: handler("SIGTERM") records run_failed, updates last-run, and exits with 143', async () => {
    // Given fake telemetry sink and fake exit function
    const events = [];
    const lastRunUpdates = [];
    let exitCode = null;

    const telemetry = {
      record: async (type, payload) => {
        events.push({ type, payload });
      },
      updateLastRun: async (state, opts) => {
        lastRunUpdates.push({ state, opts });
      },
    };
    const exit = (code) => {
      exitCode = code;
    };

    // When invoking the signal handler with SIGTERM
    const handler = createSignalHandler({
      telemetry,
      runId: 'test-run-sigterm',
      exit,
      timeoutMs: 500,
    });
    await handler('SIGTERM');

    // Then run_failed is recorded and last-run is updated
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.error, 'interrupted by signal SIGTERM');
    assert.equal(lastRunUpdates.length, 1);
    assert.equal(lastRunUpdates[0].state.state, 'interrupted');

    // And process exits with 143
    assert.equal(exitCode, 143);
  });

  it('S7c: telemetry that never resolves is bounded by timeoutMs and exit is called fast', async () => {
    // Given telemetry operations that return slow promises (50ms > 10ms timeout)
    let exitCode = null;
    const hangingTelemetry = {
      record: () => new Promise((resolve) => setTimeout(resolve, 50)),
      updateLastRun: () => new Promise((resolve) => setTimeout(resolve, 50)),
    };
    const exit = (code) => {
      exitCode = code;
    };

    // When invoking handler with timeoutMs: 10
    const startedAt = Date.now();
    const handler = createSignalHandler({
      telemetry: hangingTelemetry,
      runId: 'test-run-hang',
      exit,
      timeoutMs: 10,
    });
    await handler('SIGINT');
    const elapsed = Date.now() - startedAt;

    // Then exit was called with 130 within bounded time
    assert.equal(exitCode, 130);
    assert.ok(elapsed < 250, `Handler took ${elapsed}ms, expected fast exit`);

    // Await mock timers to drain so Node test runner observes a resolved event loop
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('S7d: install adds SIGINT/SIGTERM listeners, uninstall removes them without residue', () => {
    // Given initial process listener counts
    const intBefore = process.listenerCount('SIGINT');
    const termBefore = process.listenerCount('SIGTERM');

    // When installing the signal guard
    const uninstall = installRunSignalGuard({
      runId: 'test-guard-listener',
      exit: () => {},
    });

    // Then exactly one listener is added for SIGINT and SIGTERM
    assert.equal(process.listenerCount('SIGINT'), intBefore + 1);
    assert.equal(process.listenerCount('SIGTERM'), termBefore + 1);

    // When calling uninstall
    uninstall();

    // Then listeners return to original baseline with no residue
    assert.equal(process.listenerCount('SIGINT'), intBefore);
    assert.equal(process.listenerCount('SIGTERM'), termBefore);
  });
});

describe('Feature: Stale Reviewing Status Liveness Reconciler (S8 & E11)', () => {
  it('S8a: reviewing with dead pid reconciles to state interrupted mentioning process gone and no finish event', () => {
    // Given a last-run object in reviewing state with a non-existent pid (2**31 - 1)
    const deadPid = 2 ** 31 - 1;
    const lastRun = {
      runId: '2026-09-15T00-00-00-000Z-dead',
      state: 'reviewing',
      pid: deadPid,
      model: '@smol',
    };

    // When reconciling last-run state
    const result = reconcileLastRun(lastRun);

    // Then state is marked interrupted and error mentions process gone and no finish event
    assert.equal(result.state, 'interrupted');
    assert.match(result.error, /process gone/i);
    assert.match(result.error, /no finish event/i);
  });

  it('S8b: reviewing with mock ESRCH error reconciles to state interrupted', () => {
    // Given a mock kill function that throws ESRCH
    const mockKill = () => {
      const err = new Error('No such process');
      err.code = 'ESRCH';
      throw err;
    };
    const lastRun = {
      runId: '2026-09-15T00-00-00-000Z-mock-dead',
      state: 'reviewing',
      pid: 99999,
      model: '@smol',
    };

    // When reconciling with mock kill function
    const result = reconcileLastRun(lastRun, mockKill);

    // Then state is marked interrupted
    assert.equal(result.state, 'interrupted');
    assert.match(result.error, /process gone/i);
  });

  it('S8c: reviewing with current process.pid remains in reviewing state', () => {
    // Given a last-run object with current process.pid (guaranteed alive)
    const lastRun = {
      runId: '2026-09-15T00-00-00-000Z-alive',
      state: 'reviewing',
      pid: process.pid,
      model: '@smol',
    };

    // When reconciling last-run state
    const result = reconcileLastRun(lastRun);

    // Then state remains reviewing
    assert.equal(result.state, 'reviewing');
  });

  it('S8d: reviewing with mock EPERM remains in reviewing state (process exists)', () => {
    // Given a mock kill function that throws EPERM (operation not permitted -> process is alive)
    const mockKill = () => {
      const err = new Error('Operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    const lastRun = {
      runId: '2026-09-15T00-00-00-000Z-eperm',
      state: 'reviewing',
      pid: 1234,
      model: '@smol',
    };

    // When reconciling with mock kill function
    const result = reconcileLastRun(lastRun, mockKill);

    // Then state remains reviewing
    assert.equal(result.state, 'reviewing');
  });

  it('S8e: reviewing without pid or with non-integer pid reconciles to unknown', () => {
    // Given reviewing states with missing or non-integer pid
    const withoutPid = {
      runId: '2026-09-15T00-00-00-000Z-no-pid',
      state: 'reviewing',
      model: '@smol',
    };
    const stringPid = {
      runId: '2026-09-15T00-00-00-000Z-str-pid',
      state: 'reviewing',
      pid: '12345',
      model: '@smol',
    };

    // When reconciling
    const resWithout = reconcileLastRun(withoutPid);
    const resString = reconcileLastRun(stringPid);

    // Then state becomes unknown
    assert.equal(resWithout.state, 'unknown');
    assert.equal(resString.state, 'unknown');
  });

  it('S8f: reviewing with indeterminate kill error reconciles to unknown', () => {
    // Given a mock kill function throwing an unmapped error
    const mockKill = () => {
      const err = new Error('Unknown system failure');
      err.code = 'EINVAL';
      throw err;
    };
    const lastRun = {
      runId: '2026-09-15T00-00-00-000Z-einval',
      state: 'reviewing',
      pid: 12345,
    };

    // When reconciling
    const result = reconcileLastRun(lastRun, mockKill);

    // Then state becomes unknown
    assert.equal(result.state, 'unknown');
  });

  it('S8g: finished runs (passed, blocked, skipped, failed) retain their state untouched', () => {
    // Given terminal last-run objects
    const passed = { state: 'passed', verdict: 'PASS', exitCode: 0 };
    const blocked = { state: 'blocked', verdict: 'BLOCK', exitCode: 1 };
    const skipped = { state: 'skipped', verdict: 'SKIPPED', exitCode: 0 };
    const failed = { state: 'failed', exitCode: 1, error: 'syntax error' };

    // When reconciling terminal states
    assert.equal(reconcileLastRun(passed).state, 'passed');
    assert.equal(reconcileLastRun(blocked).state, 'blocked');
    assert.equal(reconcileLastRun(skipped).state, 'skipped');
    assert.equal(reconcileLastRun(failed).state, 'failed');
  });

  it('E11: corrupt or missing last-run degrades safely without throwing', () => {
    // Given missing or non-object lastRun inputs
    assert.equal(reconcileLastRun(undefined), undefined);
    assert.equal(reconcileLastRun(null), null);
    assert.equal(reconcileLastRun('corrupt-string'), 'corrupt-string');
    assert.deepEqual(reconcileLastRun({}), {});
    assert.equal(checkProcessLiveness(undefined), 'unknown');
    assert.equal(checkProcessLiveness(null), 'unknown');
    assert.equal(checkProcessLiveness('not-pid'), 'unknown');
  });

  it('PluginInstallerService.status() integrates liveness check for reviewing last-run.json', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-status-stale-'));
    try {
      const repoDir = path.join(baseDir, 'repo');
      await mkdir(repoDir, { recursive: true });
      spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8', windowsHide: true });
      const reportsDir = path.join(repoDir, 'audit-reports', 'commit-reviews');
      await mkdir(reportsDir, { recursive: true });
      await writeFile(path.join(reportsDir, 'last-run.json'), JSON.stringify({
        schema: 'review-last-run@1',
        runId: 'stale-run-1',
        state: 'reviewing',
        pid: 2 ** 31 - 1,
        model: '@smol',
        updatedAt: '2026-09-15T12:00:00.000Z',
      }), 'utf8');

      // When running status via PluginInstallerService
      const installer = new PluginInstallerService();
      const status = await installer.status(repoDir);

      // Then lastRun state is reconciled to interrupted with explanatory error
      assert.ok(status.lastRun);
      assert.equal(status.lastRun.state, 'interrupted');
      assert.match(status.lastRun.error, /process gone.*no finish event/i);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
