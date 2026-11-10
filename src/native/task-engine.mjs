// The one model-facing call of the kit: OMP's own TaskTool, invoked directly with
// `agent: "reviewer-kit"`. The assignment carries the staged inputs and nothing else. Models,
// roles, effort, credentials and fallback chains are resolved by OMP from the owner's
// configuration; this module reads none of them and writes no model settings.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readReportEnvelope } from '../domain/report-envelope.mjs';

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
export async function loadOmpEngine(importer = specifier => {
  const runtime = process.env.OMP_REVIEW_KIT_RUNTIME_ROOT;
  if (!runtime) return import(specifier);
  // Bun's NODE_PATH lookup can select a different globally cached package for subpath imports.
  // Resolve each entry from the provisioned package's parent and reject a path outside that package.
  const entry = import.meta.resolve(specifier, path.join(runtime, 'package.json'));
  const packageRoot = path.join(runtime, 'node_modules', '@oh-my-pi', 'pi-coding-agent');
  const relative = path.relative(packageRoot, fileURLToPath(entry));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`resolved OMP entry outside the pinned runtime: ${specifier}`);
  }
  return import(entry);
}) {
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
 * The OMP session the review's native tasks run in: one kit extension root, no UI, no MCP, and the
 * structural overlay that requires a child to finish with a `yield`.
 *
 * @param {{ cwd: string, kitRoot: string, loadEngine?: typeof loadOmpEngine }} input
 * @returns {Promise<{ tool: object, sessionFile: string }>}
 */
export async function createReviewSession({ cwd, kitRoot, loadEngine = loadOmpEngine }) {
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
  return { tool, sessionFile };
}

/**
 * Runs one native task of the review in a session the host owns. The pipeline calls this once per
 * stage, so the host decides what runs and what is reused; OMP still resolves the model.
 *
 * @param {{
 *   cwd: string, kitRoot: string,
 *   onProgress?: (line: string) => void, onEvent?: (event: object) => void,
 *   loadEngine?: typeof loadOmpEngine,
 * }} input
 * @returns {Promise<{ sessionFile: string, run: (agent: string, name: string, task: string) => Promise<{ result: object|undefined, evidence: object }> }>}
 */
export async function createStageRunner({ cwd, kitRoot, onProgress = () => {}, onEvent = () => {}, loadEngine = loadOmpEngine }) {
  const { tool, sessionFile } = await createReviewSession({ cwd, kitRoot, loadEngine });
  const emit = event => {
    try {
      onEvent(event);
    } catch {
      // The observer is fail-open: a broken sink never interrupts the review.
    }
  };
  return {
    sessionFile,
    async run(agent, name, task) {
      const run = await tool.execute(`review-${agent}-${name}`, { agent, name, task }, undefined, update => {
        onProgress(describeUpdate(update));
        for (const event of progressEvents(update)) emit(event);
      });
      const result = run?.details?.results?.[0];
      return { result, evidence: evidenceFromResult(result) };
    },
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
 *   onEvent?: (event: object) => void,
 *   loadEngine?: typeof loadOmpEngine,
 * }} input
 * @returns {Promise<{ reviewer: object|undefined, stages: object[], sessionFile: string }>}
 */
export async function runReviewerTask({ cwd, kitRoot, assignment, onProgress = () => {}, onEvent = () => {}, loadEngine = loadOmpEngine }) {
  const runner = await createStageRunner({ cwd, kitRoot, onProgress, onEvent, loadEngine });
  const { result } = await runner.run('reviewer-kit', 'Review', assignment);
  return { reviewer: result, stages: stageEvidence(result), sessionFile: runner.sessionFile };
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
  if (!last) return undefined;
  const envelope = readReportEnvelope(last.data);
  return {
    status: last.status ?? null,
    text: envelope.markdown,
    reason: envelope.reason,
    observed: envelope.observed,
  };
}

/**
 * Stage evidence: the nested native task results OMP attaches to the reviewer's result.
 *
 * @param {object|undefined} reviewer
 */
export function stageEvidence(reviewer) {
  return (reviewer?.extractedToolData?.task ?? []).flatMap(call =>
    (call.results ?? []).map(result => evidenceFromResult(result)),
  );
}

/**
 * The evidence of one native task result: who ran, whether it completed with a valid structured
 * result, what it reported and what it cost. One shape for the single-call path and the host-driven
 * pipeline, so the verdict reads the same thing either way.
 *
 * @param {object|undefined} result
 * @returns {object}
 */
export function evidenceFromResult(result) {
  return {
    agent: result?.agent ?? null,
    // The lane is what the verdict matches a hunter against; it comes from the child's own
    // structured payload, and it is persisted so a record can show what the verdict saw.
    lane: result?.structuredOutput?.data?.lane ?? null,
    exitCode: result?.exitCode ?? null,
    aborted: result?.aborted === true,
    structuredStatus: result?.structuredOutput?.status ?? null,
    data: result?.structuredOutput?.data ?? null,
    role: result?.modelRole ?? null,
    model: result?.resolvedModel ?? null,
    durationMs: result?.durationMs ?? null,
    tokens: result?.tokens ?? null,
    requests: result?.requests ?? null,
    contextTokens: result?.contextTokens ?? null,
  };
}

/**
 * Live stage events for the hook log and the run record, built from OMP's own `AgentProgress`
 * entries. The numbers are whatever OMP reported for that stage; a stage with no entry yet is not
 * invented here. Nothing but names, statuses and counters leaves this function.
 *
 * @param {{ details?: { progress?: object[] } }} [update]
 * @returns {Array<{ agent: string|null, lane: string|null, status: string|null, durationMs: number|null, tokens: number|null, requests: number|null, contextTokens: number|null, role: string|null, model: string|null }>}
 */
export function progressEvents(update) {
  const progress = update?.details?.progress;
  if (!Array.isArray(progress)) return [];
  return progress
    .filter(entry => entry && typeof entry === 'object' && typeof entry.agent === 'string')
    .map(entry => ({
      agent: entry.agent,
      lane: entry.lane ?? null,
      status: typeof entry.status === 'string' ? entry.status : null,
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
      tokens: typeof entry.tokens === 'number' ? entry.tokens : null,
      requests: typeof entry.requests === 'number' ? entry.requests : null,
      contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : null,
      role: entry.modelRole ?? null,
      model: entry.resolvedModel ?? null,
    }));
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

/**
 * Whether OMP moved the reviewer off the model it requested. The requested selector is the first
 * entry of OMP's own `modelOverride`; the applied one is already in the provenance. Observability
 * only: the verdict never branches on it.
 *
 * @param {object|undefined} reviewer
 * @returns {{ applied: boolean, requested: string|null }}
 */
export function fallbackOf(reviewer) {
  const override = reviewer?.modelOverride;
  const requested = Array.isArray(override) ? (override[0] ?? null) : (typeof override === 'string' ? override : null);
  return { applied: reviewer?.resolvedModelIsFallback === true, requested };
}

/**
 * The reviewer's own OMP session log, derived from the `outputPath` OMP reports on the result. Null
 * when OMP reports no Markdown path: the evidence is then unknown rather than absent.
 *
 * @param {object|undefined} reviewer
 * @returns {string|null}
 */
export function reviewerTranscript(reviewer) {
  const outputPath = typeof reviewer?.outputPath === 'string' ? reviewer.outputPath : '';
  return /\.md$/i.test(outputPath) ? outputPath.replace(/\.md$/i, '.jsonl') : null;
}

export function describeUpdate(update) {
  const results = update?.details?.results ?? [];
  const running = results.filter(result => result.exitCode === undefined).length;
  return `review: native task update (${results.length} result(s), ${running} running)`;
}
