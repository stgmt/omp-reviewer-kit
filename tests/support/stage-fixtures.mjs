// One definition of a completed native stage result and of a passing reviewer yield, shared by the
// suite. These are the shapes `evaluateReview` reads; a change to one of them must reach every test
// that builds a review, and a single owner is what makes that mechanical instead of six-file work.

/**
 * @param {string} agent
 * @param {object} data
 * @param {{ role?: string|null, model?: string|null, durationMs?: number, tokens?: number, requests?: number }} [extra]
 * @returns {object}
 */
export function completed(agent, data, extra = {}) {
  return {
    agent,
    exitCode: 0,
    aborted: false,
    structuredStatus: 'valid',
    data,
    ...extra,
  };
}

/**
 * @param {string} [text]
 * @returns {{ exitCode: number, aborted: boolean, yieldStatus: string, text: string }}
 */
export function reviewerPass(text = '## Review\n\nREVIEW_RESULT=PASS') {
  return { exitCode: 0, aborted: false, yieldStatus: 'success', text };
}

/**
 * The engine OMP's library would provide, reduced to what the native stage runner needs: it records
 * the working directory the session was created in and the abort signal handed to each native call.
 * `initCwds` is how a test proves which directory the review's stages actually run in.
 *
 * @param {{ execute: (id: string, params: object) => Promise<unknown> }} input
 * @returns {{ engine: object, initCwds: string[], abortSignals: Array<AbortSignal|undefined> }}
 */
export function createStubEngine({ execute }) {
  const initCwds = [];
  const abortSignals = [];
  const engine = {
    Settings: {
      init: async ({ cwd }) => {
        initCwds.push(cwd);
        return { overlay: overlayed => ({ overlayed }) };
      },
    },
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
        execute: async (id, params, signal) => {
          abortSignals.push(signal);
          return execute(id, params);
        },
      }),
    },
  };
  return { engine, initCwds, abortSignals };
}
