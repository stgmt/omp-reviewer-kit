import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const roleNames = ['reviewer-kit', 'review-context-scout', 'review-risk-hunter', 'review-finding-verifier'];
const state = { externalRequests: 0, calls: [], gates: [], outputs: [] };
const scenario = process.env.REVIEW_SDK_SCENARIO ?? 'clean';
const candidate = { candidate_id: 'correctness-1', lane: 'correctness', priority: 'P1', title: 'Fixture defect', file_path: 'src/a.mjs', line_start: 1, line_end: 1, observed_behavior: 'incorrect', expected_behavior: 'correct', trigger_scenario: 'fixture input', impact: 'fixture loss', red_proof: 'fixture red control', evidence: ['src/a.mjs:1'] };
const gap = { coverage_id: 'coverage-1', file_path: 'src/a.mjs', line_start: 1, line_end: 1, behavior: 'fixture changed behavior', severity: 'blocking', impact: 'fixture reachable impact', file_class: 'executable', test_harness: 'present', required_tests: [{ kind: 'edge', scenario: 'fixture edge', mutant: '' }, { kind: 'mutation', scenario: 'fixture mutation', mutant: 'fixture changed lines' }] };
const { red_proof, ...finding } = candidate;
const manifest = JSON.parse(readFileSync(process.env.OMP_REVIEW_KIT_BATCH_MANIFEST, 'utf8'));
globalThis.fetch = async () => { state.externalRequests++; throw new Error('OFFLINE_NETWORK_DENIED'); };

export default function probe(pi) {
  pi.on('tool_call', (event) => { if (event.toolName === 'task') state.gates.push({ type: 'call', tasks: event.input.tasks?.map((t) => t.name) ?? [event.input.name] }); });
  pi.on('tool_result', async (event) => {
    if (event.toolName === 'task') {
      state.gates.push({ type: 'result', ids: event.details?.results?.map((r) => r.id) });
      state.outputs.push(...(event.details?.results ?? []).map((result) => ({ agent: result.agent, modelRole: result.modelRole, data: result.structuredOutput?.data, valid: result.structuredOutput?.status, source: result.structuredOutput?.source, mode: result.structuredOutput?.mode })));
      await writeFile(process.env.REVIEW_SDK_RESULT, JSON.stringify(state));
    }
  });
  pi.registerProvider('review-offline', {
    api: 'review-offline-api', apiKey: 'LOCAL_NOT_A_CREDENTIAL', baseUrl: 'http://127.0.0.1:1',
    models: ['fixture', 'forbidden-parent'].map((id) => ({ id, name: 'Offline', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
    streamSimple(model, context) {
      const system = String(context.systemPrompt);
      const role = roleNames.find((name) => system.includes(`You are \`${name}\``));
      if (!role || model.id !== 'fixture') throw new Error('OFFLINE_UNEXPECTED_PARENT_INFERENCE');
      if (!(context.tools ?? []).length) throw new Error('OFFLINE_MODEL_PREFLIGHT_FORBIDDEN');
      const results = context.messages.filter((m) => m.role === 'toolResult');
      const user = context.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content)).join('\n');
      const scope = manifest.scouts.find((s) => user.includes(`REVIEW_TASK_ID=${s.id}`)) ?? manifest.scouts[0];
      const taskId = user.match(/REVIEW_TASK_ID=([A-Za-z0-9-]+)/)?.[1] ?? role;
      state.calls.push({ role, taskId, at: Date.now(), tools: (context.tools ?? []).map((t) => t.name) });
      const data = role === 'review-context-scout' ? {
        change_goal: 'fixture', changed_paths: scope.paths, relevant_consumers: [], invariants: ['fixture owned contract inspected'], test_evidence: [], test_harness: 'present',
        coverage_map: [], non_coverable_items: [], claims: [], declared_checks: [], unknowns: [], reviewed_paths: scope.paths,
        completion: { scope_id: scope.id, completed_paths: scope.paths, unresolved: [] },
      } : role === 'review-risk-hunter' ? { coverage_summary: 'fixture', candidates: [], coverage_gaps: [], suppressed_coverage_items: [] }
        : { coverage_summary: 'fixture', decisions: [], confirmed_findings: [], confirmed_coverage_gaps: [], rejected_coverage_gaps: [] };
      if (role === 'review-context-scout' && scenario === 'empty-scout') {
        data.change_goal = '';
        for (const field of ['changed_paths', 'reviewed_paths', 'invariants']) data[field] = [];
      }
      if (role === 'review-context-scout' && scenario === 'invalid-scout') data.coverage_map = [{ behavior: 'fixture', file_path: scope.paths[0], line_start: { invalid: true }, line_end: 1, covering_test: null }];
      const needsVerifier = ['confirmed', 'coverage', 'missing-disposition', 'rejected', 'previous-fixed', 'previous-still', 'previous-missing'].includes(scenario);
      if (role === 'review-risk-hunter' && needsVerifier && !scenario.startsWith('previous-') && taskId.includes('correctness')) {
        if (scenario === 'coverage') data.coverage_gaps = [gap];
        else data.candidates = [candidate];
      }
      if (role === 'review-finding-verifier' && needsVerifier && scenario !== 'missing-disposition' && scenario !== 'previous-missing') {
        if (scenario.startsWith('previous-')) data.decisions = [{ candidate_id: 'old1', disposition: scenario === 'previous-fixed' ? 'fixed' : 'still_present', triage: 'not_applicable', reason: 'fixture previous disposition', evidence: 'src/a.mjs:1' }];
        else if (scenario === 'coverage') data.confirmed_coverage_gaps = [gap];
        else {
          data.decisions = [{ candidate_id: candidate.candidate_id, disposition: scenario === 'rejected' ? 'rejected' : 'confirmed', triage: 'not_applicable', reason: 'fixture disposition', evidence: 'src/a.mjs:1' }];
          if (scenario !== 'rejected') data.confirmed_findings = [finding];
        }
      }
      const batchEnabled = process.env.REVIEW_SDK_BATCH !== '0';
      const taskCall = (tasks) => ({ type: 'toolCall', name: 'task', arguments: batchEnabled ? { tasks } : tasks[0] });
      let item;
      if (role === 'reviewer-kit') {
        const scouts = manifest.scouts.map((s) => ({ name: s.id, agent: 'review-context-scout', task: 'scout' }));
        const hunters = manifest.hunters.filter((_, i) => process.env.REVIEW_SDK_OMIT_HUNTER !== '1' || i === 0).map((h) => ({ name: h.id, agent: 'review-risk-hunter', task: 'hunt' }));
        // Failed scout fixtures must consume their one allowed task retry before synthesis.
        // Advancing to hunters after the first failure only tests dispatch rejection, not terminal failure.
        const stages = ['empty-scout', 'invalid-scout'].includes(scenario) ? [scouts, scouts]
          : batchEnabled ? [scouts, hunters] : [...scouts, ...hunters].map((task) => [task]);
        if (needsVerifier) stages.push([{ name: 'Verifier', agent: 'review-finding-verifier', task: 'verify authoritative candidates and gaps' }]);
        item = results.length < stages.length ? taskCall(stages[results.length])
          : { type: 'toolCall', name: 'yield', arguments: { data: 'REVIEW_RESULT=PASS\n' } };
      } else item = { type: 'toolCall', name: 'yield', arguments: { data } };
      if (item.type === 'toolCall') item.id = `${role}-${results.length}`;
      const message = { role: 'assistant', content: [item], api: 'review-offline-api', provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: item.type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
      return {
        async *[Symbol.asyncIterator]() {
          if (role === 'review-context-scout' || role === 'review-risk-hunter') await new Promise((resolve) => setTimeout(resolve, 800));
          [...state.calls].reverse().find((c) => c.taskId === taskId).finishedAt = Date.now();
          yield { type: 'start', partial: message };
          if (item.type === 'toolCall') {
            yield { type: 'toolcall_start', contentIndex: 0, partial: message };
            yield { type: 'toolcall_end', contentIndex: 0, toolCall: item, partial: message };
          }
          yield { type: 'done', reason: message.stopReason, message };
        }, result: async () => message,
      };
    },
  });
}
