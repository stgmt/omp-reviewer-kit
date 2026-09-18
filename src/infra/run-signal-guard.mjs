/**
 * Signal guard for review runs.
 * Traps SIGINT / SIGTERM to record failure telemetry and update live state
 * before forcing process termination.
 */

/**
 * Creates an interruption signal handler that updates telemetry and exits.
 *
 * @param {{
 *   telemetry?: { record?: (type: string, payload?: object) => Promise<void>, updateLastRun?: (state: object, opts?: { force?: boolean }) => Promise<void> },
 *   runId?: string,
 *   exit?: (code: number) => void,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {(signal: string) => Promise<void>}
 */
export function createSignalHandler({
  telemetry,
  runId,
  cleanup,
  exit = process.exit,
  timeoutMs = 500,
} = {}) {
  return async function handler(signal) {
    const error = `interrupted by signal ${signal}`;
    const code = signal === 'SIGTERM' ? 143 : 130;
    const telemetryWork = (async () => {
      try {
        await telemetry?.record?.('run_failed', { error });
      } catch {
        // Telemetry calls must never throw out of the handler
      }
      try {
        await telemetry?.updateLastRun?.({
          state: 'interrupted',
          error,
          runId,
          finishedAt: new Date().toISOString(),
          exitCode: 1,
        }, { force: true });
      } catch {
        // Telemetry calls must never throw out of the handler
      }
      // Snapshot dirs are removed here because exit() below never returns,
      // so the normal finally cleanup cannot run.
      try {
        await cleanup?.();
      } catch {
        // Cleanup must never throw out of the handler
      }
    })();

    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    });

    try {
      await Promise.race([telemetryWork, timeoutPromise]);
    } catch {
      // Guard against any race rejection
    } finally {
      clearTimeout(timer);
    }

    try {
      exit(code);
    } catch {
      // Guard against injectable exit throwing
    }
  };
}

/**
 * Installs one-shot SIGINT/SIGTERM handlers for a review run.
 *
 * @param {{
 *   telemetry?: { record?: (type: string, payload?: object) => Promise<void>, updateLastRun?: (state: object, opts?: { force?: boolean }) => Promise<void> },
 *   runId?: string,
 *   exit?: (code: number) => void,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {() => void}
 */
export function installRunSignalGuard({
  telemetry,
  runId,
  cleanup,
  exit = process.exit,
  timeoutMs = 500,
} = {}) {
  // Accepted E10 race: OS pid reuse can theoretically misattribute liveness — safety-neutral, verdict path untouched.
  const handler = createSignalHandler({ telemetry, runId, cleanup, exit, timeoutMs });
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);

  return function uninstall() {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}
