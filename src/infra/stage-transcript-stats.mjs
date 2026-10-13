import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPTS = 40;

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction))];
}

/**
 * Stage label from a transcript file name: `ReviewerKit.Scout.jsonl` -> `Scout`,
 * the orchestrator's own `ReviewerKit.jsonl` keeps its name.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function stageLabelFromTranscript(fileName) {
  const stem = String(fileName).replace(/\.jsonl$/i, '');
  const dot = stem.indexOf('.');
  return dot >= 0 ? stem.slice(dot + 1) : stem;
}

/**
 * Condenses one OMP session transcript (JSONL) into latency counters: how many
 * model turns and tool calls a stage took and how long a turn takes. Lines
 * that are not JSON are ignored.
 *
 * @param {string} text
 * @param {string} stage
 * @returns {{ stage: string, turns: number, toolCalls: number, tools: Record<string, number>, startedAtMs: number, spanMs: number, turnGapMedianMs: number|null, turnGapP90Ms: number|null, turnGapMaxMs: number|null, model: string|null }}
 */
export function summarizeTranscript(text, stage) {
  const tools = {};
  const turnTimes = [];
  const reads = new Set();
  let repeatedReads = 0;
  let readResponseBytes = 0;
  let invalidYields = 0;
  const identity = transcriptIdentity(text);
  let firstAt = Infinity;
  let lastAt = -Infinity;
  let model = null;
  let subagentModel = null;
  let toolCalls = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) {
      if (at < firstAt) firstAt = at;
      if (at > lastAt) lastAt = at;
    }
    if (entry.type === 'model_change' && typeof entry.model === 'string') {
      if (String(entry.role ?? '').startsWith('subagent:')) subagentModel ??= entry.model;
      else model ??= entry.model;
    }
    if (entry.type === 'message' && entry.message?.role === 'toolResult') {
      if (entry.message.toolName === 'yield' && (entry.message.isError || !['success', 'aborted'].includes(entry.message.details?.status))) invalidYields++;
      if (entry.message.toolName === 'read') readResponseBytes += Buffer.byteLength(JSON.stringify(entry.message.content ?? []));
    }
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    if (Number.isFinite(at)) turnTimes.push(at);
    for (const item of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (item?.type !== 'toolCall' && item?.type !== 'tool_use') continue;
      toolCalls += 1;
      const name = String(item.name ?? item.toolName ?? 'unknown');
      tools[name] = (tools[name] ?? 0) + 1;
      if (name === 'read') {
        const args = item.arguments ?? item.input ?? {};
        const key = JSON.stringify([args.path, args.offset, args.limit]);
        if (reads.has(key)) repeatedReads++;
        reads.add(key);
      }
    }
  }
  const gaps = [];
  for (let i = 1; i < turnTimes.length; i += 1) gaps.push(turnTimes[i] - turnTimes[i - 1]);
  gaps.sort((a, b) => a - b);
  return {
    stage,
    agent: identity?.agent ?? null,
    sessionId: identity?.sessionId ?? null,
    taskId: identity?.taskId ?? null,
    complete: identity?.complete ?? false,
    workSpanMs: identity?.completedAtMs && Number.isFinite(firstAt) ? identity.completedAtMs - firstAt : null,
    repeatedReads, readResponseBytes, invalidYields,
    turns: turnTimes.length,
    toolCalls,
    tools,
    startedAtMs: Number.isFinite(firstAt) ? firstAt : 0,
    spanMs: lastAt > firstAt ? lastAt - firstAt : 0,
    turnGapMedianMs: percentile(gaps, 0.5),
    turnGapP90Ms: percentile(gaps, 0.9),
    turnGapMaxMs: gaps.length > 0 ? gaps[gaps.length - 1] : null,
    model: subagentModel ?? model,
  };
}

/**
 * Summarises every stage transcript an OMP review child left in its
 * `--session-dir` (`<session>/<artifacts>/<Parent>/<Parent>.<Stage>.jsonl`, plus the
 * orchestrator's `<artifacts>/<Parent>.jsonl`). Never throws: telemetry must
 * not be able to change a verdict.
 *
 * @param {string|null|undefined} sessionDir
 * @returns {Promise<ReturnType<typeof summarizeTranscript>[]>}
 */
export async function summarizeStageTranscripts(sessionDir) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) return [];
  const stages = [];
  try {
    for (const artifacts of await readdir(sessionDir, { withFileTypes: true })) {
      if (!artifacts.isDirectory()) continue;
      const artifactsDir = path.join(sessionDir, artifacts.name);
      const files = [];
      for (const entry of await readdir(artifactsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(artifactsDir, entry.name));
        if (!entry.isDirectory()) continue;
        const nested = path.join(artifactsDir, entry.name);
        for (const inner of await readdir(nested, { withFileTypes: true })) {
          if (inner.isFile() && inner.name.endsWith('.jsonl')) files.push(path.join(nested, inner.name));
        }
      }
      for (const file of files.slice(0, MAX_TRANSCRIPTS)) {
        const info = await stat(file).catch(() => null);
        if (!info || info.size === 0 || info.size > TRANSCRIPT_MAX_BYTES) continue;
        stages.push(summarizeTranscript(await readFile(file, 'utf8'), stageLabelFromTranscript(path.basename(file))));
      }
    }
  } catch {
    // keep whatever was read before the failure
  }
  return stages.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

const STAGE_RESULT_MAX_BYTES = 2 * 1024 * 1024;

export function transcriptIdentity(text) {
  let init = null;
  let completion = null;
  let completedAtMs = null;
  for (const line of String(text).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'session_init') {
      if (init) return null;
      init = entry;
    }
    if (entry?.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === 'yield') {
      completion = entry.message.isError ? null : entry.message.details;
      completedAtMs = Date.parse(entry.timestamp);
    }
  }
  if (!init || typeof init.agent !== 'string') return null;
  const data = completion?.data;
  const complete = completion?.status === 'success' && !data?.aborted && !data?.error;
  return { agent: init.agent, task: String(init.task ?? ''), sessionId: init.id,
    taskId: String(init.task ?? '').match(/(?:^|\n)REVIEW_TASK_ID=([A-Za-z0-9-]+)(?:\n|$)/)?.[1] ?? null, complete,
    completedAtMs: complete && Number.isFinite(completedAtMs) ? completedAtMs : null, data };
}

export async function readArtifactIdentity(file) {
  try {
    const transcript = file.replace(/\.md$/i, '.jsonl');
    const info = await stat(transcript);
    if (!info.isFile() || info.size > TRANSCRIPT_MAX_BYTES) return null;
    return transcriptIdentity(await readFile(transcript, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Newest stage result artifact (`<artifacts>/<Parent>/<Parent>.<Stage>.md`)
 * whose stage label matches `labelPattern`, as text; empty when none exists.
 * Never throws.
 *
 * @param {string|null|undefined} sessionDir
 * @param {RegExp} labelPattern
 * @returns {Promise<string>}
 */
export async function readStageResult(sessionDir, labelPattern) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) return '';
  let best = null;
  let matches = 0;
  try {
    for (const artifacts of await readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
      if (!artifacts.isDirectory()) continue;
      const artifactsDir = path.join(sessionDir, artifacts.name);
      for (const entry of await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(artifactsDir, entry.name);
        for (const inner of await readdir(nested, { withFileTypes: true }).catch(() => [])) {
          if (!inner.isFile() || !inner.name.endsWith('.md')) continue;
          const full = path.join(nested, inner.name);
          if (typeof labelPattern === 'string') {
            const identity = await readArtifactIdentity(full);
            if (!identity?.complete || identity.agent !== labelPattern) continue;
            matches++;
          } else if (!labelPattern.test(stageLabelFromTranscript(inner.name.replace(/\.md$/i, '.jsonl')))) continue;
          const info = await stat(full).catch(() => null);
          if (!info || info.size === 0 || info.size > STAGE_RESULT_MAX_BYTES) continue;
          if (!best || info.mtimeMs > best.mtimeMs || (full > best.file && info.mtimeMs === best.mtimeMs)) {
            best = { file: full, mtimeMs: info.mtimeMs };
          }
        }
      }
    }
    if (typeof labelPattern === 'string' && matches !== 1) return '';
    return best ? await readFile(best.file, 'utf8') : '';
  } catch {
    return '';
  }
}
