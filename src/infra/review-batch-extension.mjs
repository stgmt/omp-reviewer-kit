import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gateReviewBatch, validateBatchResults, mergeScoutReports } from '../domain/review-batch.mjs';

export function registerReviewBatchGate(pi, manifestPath = process.env.OMP_REVIEW_KIT_BATCH_MANIFEST) {
  if (!manifestPath || pi.__reviewKitBatchGate) return;
  pi.__reviewKitBatchGate = true;
  const manifestPromise = readFile(manifestPath, 'utf8').then((text) => {
    const manifest = JSON.parse(text);
    if (manifest.schema !== 'review-batch@1' || !manifest.invocationToken || !Array.isArray(manifest.scouts) || !Array.isArray(manifest.hunters)) throw new Error('Invalid review invocation manifest');
    return manifest;
  });
  // Attach rejection immediately: bad inputs block tool calls, never become an
  // unhandled rejection or silently turn this review into an ungated session.
  manifestPromise.catch(() => {});
  const calls = new Map();
  const started = new Map();
  const stageResults = new Map();
  const completed = new Set();
  let mergedScout;
  let hunterData = [];
  let failed = false;
  let rejectedYields = 0;
  const record = async (event) => {
    const manifest = await manifestPromise;
    await appendFile(`${manifestPath}.events`, JSON.stringify({ invocationToken: manifest.invocationToken, ...event }) + '\n', { mode: 0o600 });
  };
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'yield' && rejectedYields >= 2) {
      return { input: { error: 'Repeated invalid structured submissions; review incomplete.' } };
    }
    if (['edit', 'write', 'eval'].includes(event.toolName) || /^mcp/.test(event.toolName)) {
      return { block: true, reason: 'Review child permits read-only inspection and native task/yield only.' };
    }
    if (event.toolName !== 'task') return;
    try {
      const manifest = await manifestPromise;
      const taskSchema = pi.getAllTools?.().find((tool) => tool.name === 'task')?.parameters;
      const schema = typeof taskSchema?.toJsonSchema === 'function' ? taskSchema.toJsonSchema() : taskSchema;
      const batchEnabled = schema ? Object.hasOwn(schema.properties ?? {}, 'tasks') : true;
      const input = gateReviewBatch(event.input, manifest, { batchEnabled });
      const stage = input.tasks[0].agent;
      if (stage === 'review-finding-verifier') {
        input.context += `\nAuthoritative completed hunter outputs (verify every candidate and coverage gap):\n${JSON.stringify(hunterData)}\nAuthoritative previous findings (decide fixed/still_present for each id):\n${JSON.stringify(manifest.previousFindings ?? [])}`;
      }
      const parentAgent = ctx?.sessionManager?.getEntries?.().find((e) => e.type === 'session_init')?.agent;
      if ((parentAgent === 'reviewer-kit' && stage === 'reviewer-kit') || (parentAgent && parentAgent !== 'reviewer-kit')) throw new Error('Review spawn hierarchy violated');
      if (ctx?.sessionManager && !parentAgent && stage !== 'reviewer-kit') throw new Error('Dispatcher must spawn reviewer-kit, not a specialist');
      const dispatched = started.get(stage) ?? new Set();
      if (failed || input.tasks.some((task) => dispatched.has(task.name))) throw new Error('Review stage already dispatched or failed; do not rerun the whole stage');
      if (stage === 'review-risk-hunter' && !completed.has('review-context-scout')) throw new Error('Scout must complete before hunting');
      if (stage === 'review-finding-verifier' && !completed.has('review-risk-hunter')) throw new Error('Hunters must complete before verification');
      for (const task of input.tasks) dispatched.add(task.name);
      started.set(stage, dispatched);
      calls.set(event.toolCallId, input);
      if (!batchEnabled) {
        const task = input.tasks[0];
        return { input: { ...task, task: `${input.context}\n${task.task}\nNative task.batch is disabled: dispatch every planned task once using flat calls. Wait for the complete merged stage before proceeding.` } };
      }
      return { input };
    } catch (error) {
      return { block: true, reason: error.message };
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === 'yield' && (event.isError || event.details?.status === 'invalid')) rejectedYields++;
    if (event.toolName !== 'task') return;
    const input = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    if (!input) return;
    try {
      const parentId = ctx?.sessionManager?.getEntries?.().find((e) => e.type === 'session_init')?.agent === 'reviewer-kit'
        ? path.basename(ctx.sessionManager.getSessionFile(), '.jsonl') : null;
      if (event.isError) throw new Error('Native task failed');
      const results = validateBatchResults(input, event.details, parentId);
      const manifest = await manifestPromise;
      const stage = input.tasks[0].agent;
      const planned = stage === 'review-context-scout' ? manifest.scouts : stage === 'review-risk-hunter' ? manifest.hunters : input.tasks.map((task) => ({ id: task.name }));
      const collected = stageResults.get(stage) ?? new Map();
      for (let i = 0; i < results.length; i++) collected.set(input.tasks[i].name, results[i]);
      stageResults.set(stage, collected);
      if (planned.some((task) => !collected.has(task.id))) {
        return { additionalContext: `Stage incomplete. Dispatch remaining planned tasks: ${planned.filter((task) => !collected.has(task.id)).map((task) => task.id).join(', ')}. Do not begin the next stage.` };
      }
      const ordered = planned.map((task) => collected.get(task.id));
      if (stage === 'review-context-scout') {
        const merged = mergeScoutReports(ordered.map((result) => result.structuredOutput.data), manifest.scouts);
        mergedScout = merged;
        await record({ stage, tasks: planned.map((task) => task.id), complete: true, mergedScout: merged });
        completed.add(stage);
        return { additionalContext: 'Use the complete merged scout result below for all hunter and verifier inputs; do not launch a second general scout.',
          content: [{ type: 'text', text: JSON.stringify(merged) }], details: { ...event.details, mergedScout: merged } };
      }
      let blocksApproval = false;
      if (stage === 'review-risk-hunter') hunterData = ordered.map((result) => result.structuredOutput.data);
      if (stage === 'review-finding-verifier') {
        const data = ordered[0].structuredOutput.data;
        const candidates = hunterData.flatMap((hunter) => hunter.candidates);
        const gaps = hunterData.flatMap((hunter) => hunter.coverage_gaps);
        if (candidates.some((candidate) => data.decisions.filter((decision) => decision.candidate_id === candidate.candidate_id).length !== 1)
          || gaps.some((gap) => [...data.confirmed_coverage_gaps, ...data.rejected_coverage_gaps].filter((item) => item.coverage_id === gap.coverage_id).length !== 1)
          || (manifest.previousFindings ?? []).some((finding) => data.decisions.filter((decision) => decision.candidate_id === finding.id && ['fixed', 'still_present'].includes(decision.disposition)).length !== 1)) {
          throw new Error('Verifier omitted or duplicated an authoritative candidate/coverage disposition');
        }
        blocksApproval = data.confirmed_findings.length > 0 || data.decisions.some((decision) => ['confirmed', 'still_present'].includes(decision.disposition))
          || (data.confirmed_coverage_gaps.length > 0 && !String(mergedScout?.test_harness).startsWith('absent'));
      }
      await record({ stage, tasks: planned.map((task) => task.id), complete: true, blocksApproval,
        ...(stage === 'review-finding-verifier' ? { verifierData: ordered[0].structuredOutput.data } : {}),
        requiresVerifier: ordered.some((result) => (result.structuredOutput?.data?.candidates?.length ?? 0) > 0 || (result.structuredOutput?.data?.coverage_gaps?.length ?? 0) > 0) });
      completed.add(stage);
    } catch (error) {
      failed = true;
      await record({ stage: input.tasks[0].agent, complete: false, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }).catch(() => {});
      return { isError: true, content: [{ type: 'text', text: `Review stage incomplete: ${error.message}. Do not approve this review.` }, ...event.content] };
    }
  });
}
