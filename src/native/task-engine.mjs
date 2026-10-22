// The one model-facing call of the kit: OMP's own TaskTool, invoked directly with
// `agent: "reviewer-kit"`. The assignment carries the staged inputs and nothing else. Models,
// roles, effort, credentials and fallback chains are resolved by OMP from the owner's
// configuration; this module reads none of them and writes no model settings.

import path from 'node:path';

/**
 * Structural overlay only: children must complete with a `yield`, otherwise OMP has no
 * completion evidence to read. It names no model, role or fallback.
 */
export const STRUCTURAL_OVERLAY = { 'task.structured': true };

/**
 * Loads OMP's library lazily so a missing or mismatched install is reported as a diagnostic
 * instead of crashing the launcher. `importer` is the import seam: a failed module rejects the
 * whole load, so no partial engine is ever returned.
 */
export async function loadOmpEngine(importer = specifier => import(specifier)) {
  const [settings, registry, sdk, sessions, task, bus, agents] = await Promise.all([
    importer('@oh-my-pi/pi-coding-agent/config/settings'),
    importer('@oh-my-pi/pi-coding-agent/config/model-registry'),
    importer('@oh-my-pi/pi-coding-agent/sdk'),
    importer('@oh-my-pi/pi-coding-agent/session/session-manager'),
    importer('@oh-my-pi/pi-coding-agent/task/index'),
    importer('@oh-my-pi/pi-coding-agent/utils/event-bus'),
    importer('@oh-my-pi/pi-coding-agent/registry/agent-registry'),
  ]);
  return {
    Settings: settings.Settings,
    ModelRegistry: registry.ModelRegistry,
    discoverAuthStorage: sdk.discoverAuthStorage,
    SessionManager: sessions.SessionManager,
    TaskTool: task.TaskTool,
    EventBus: bus.EventBus,
    MAIN_AGENT_ID: agents.MAIN_AGENT_ID,
  };
}

/**
 * Runs `reviewer-kit` through the native TaskTool and returns the native evidence.
 *
 * @param {{
 *   cwd: string,
 *   kitRoot: string,
 *   assignment: string,
 *   onProgress?: (line: string) => void,
 *   loadEngine?: typeof loadOmpEngine,
 * }} input
 * @returns {Promise<{ reviewer: object|undefined, stages: object[], sessionFile: string }>}
 */
export async function runReviewerTask({ cwd, kitRoot, assignment, onProgress = () => {}, loadEngine = loadOmpEngine }) {
  const omp = await loadEngine();
  const base = await omp.Settings.init({ cwd });
  const authStorage = await omp.discoverAuthStorage(undefined, { settings: base });
  const modelRegistry = new omp.ModelRegistry(authStorage);
  await modelRegistry.refresh();

  const sessionManager = omp.SessionManager.create(cwd);
  await sessionManager.setSessionName('reviewer-kit native review', 'auto');
  await sessionManager.ensureOnDisk();
  const sessionFile = sessionManager.getSessionFile();

  // Agent discovery reads only the kit's own `agents/` directory: `explicit-only` skips the
  // installed plugin copies, so the review runs the agents of the checkout it was launched from.
  const session = {
    cwd,
    hasUI: false,
    suppressSpawnAdvisory: true,
    enableLsp: false,
    enableIrc: false,
    enableMCP: false,
    eventBus: new omp.EventBus(),
    getSessionFile: () => sessionFile,
    getSessionId: () => sessionManager.getSessionId(),
    getArtifactsDir: () => sessionManager.getArtifactsDir(),
    getArtifactManager: () => sessionManager.getArtifactManager(),
    getAgentId: () => omp.MAIN_AGENT_ID,
    getSessionSpawns: () => undefined,
    effectiveExtensionRoots: () => ({
      explicit: [path.resolve(kitRoot)],
      mode: 'explicit-only',
      configured: [],
      configuredLevel: 'user',
    }),
    sessionManager,
    settings: base.overlay(STRUCTURAL_OVERLAY),
    authStorage,
    modelRegistry,
  };

  const tool = await omp.TaskTool.create(session);
  const run = await tool.execute('reviewer-kit-review', { agent: 'reviewer-kit', name: 'Review', task: assignment }, undefined, update => {
    onProgress(describeUpdate(update));
  });
  const reviewer = reviewerFromRun(run);
  return { reviewer, stages: stageEvidence(reviewer), sessionFile };
}

/**
 * The reviewer is the first result of the run: the native task that ran `reviewer-kit`.
 *
 * @param {{ details?: { results?: object[] } } | undefined} run
 * @returns {object|undefined}
 */
export function reviewerFromRun(run) {
  return run?.details?.results?.[0];
}

/**
 * The reviewer's own final `yield`: the decoded Markdown and the yield status. `text` is `null`
 * when the payload carries no Markdown report. The yield contract is one raw string; a payload of
 * exactly one `report` string field is the same string after JSON serialization, decoded once.
 * Any other shape has no report, and the verdict blocks on it.
 *
 * @param {object|undefined} reviewer
 * @returns {{ status: string|null, text: string|null } | undefined}
 */
export function reviewerYield(reviewer) {
  const yields = reviewer?.extractedToolData?.yield ?? [];
  const last = yields[yields.length - 1];
  return last ? { status: last.status ?? null, text: decodeReport(last.data) } : undefined;
}

function decodeReport(data) {
  if (typeof data === 'string') return data;
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
  if (keys.length === 1 && keys[0] === 'report' && typeof data.report === 'string') return data.report;
  return null;
}

/**
 * Stage evidence: the nested native task results OMP attaches to the reviewer's result.
 *
 * @param {object|undefined} reviewer
 */
export function stageEvidence(reviewer) {
  return (reviewer?.extractedToolData?.task ?? []).flatMap(call =>
    (call.results ?? []).map(result => ({
      agent: result.agent ?? null,
      exitCode: result.exitCode ?? null,
      aborted: result.aborted === true,
      structuredStatus: result.structuredOutput?.status ?? null,
      data: result.structuredOutput?.data ?? null,
      role: result.modelRole ?? null,
      model: result.resolvedModel ?? null,
    })),
  );
}

/**
 * Reviewer result summary for the audit trail: the OMP role and resolved model it ran on.
 * Read-only; the verdict never branches on it.
 *
 * @param {object} reviewer
 */
export function provenanceOf(reviewer) {
  return { role: reviewer?.modelRole ?? null, model: reviewer?.resolvedModel ?? null };
}

export function describeUpdate(update) {
  const results = update?.details?.results ?? [];
  const running = results.filter(result => result.exitCode === undefined).length;
  return `review: native task update (${results.length} result(s), ${running} running)`;
}
