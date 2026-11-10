// The host-driven stage pipeline: one native task per stage, in order, each result journaled the
// moment it exists. A stage with a valid journal entry is not run again, so a killed review continues
// from the first stage that has no result instead of starting over.

import { stageEntryValid } from '../domain/review-journal.mjs';

/**
 * Runs the plan, reusing journaled stages.
 *
 * `steps` are executed in order. A step's `task` may be a string or a function of the evidence map,
 * because a hunter needs the scout result and the verifier needs every hunter.
 *
 * @param {{
 *   runner: { run: (agent: string, name: string, task: string) => Promise<{ evidence: object }> },
 *   steps: Array<{
 *     id: string,
 *     agent: string,
 *     name: string,
 *     task: string | ((evidence: Map<string, object>) => string),
 *     when?: (evidence: Map<string, object>) => boolean,
 *   }>,
 *   journal?: {
 *     key: string,
 *     read: (id: string) => Promise<object|null>,
 *     write: (id: string, evidence: object) => Promise<void>,
 *   } | null,
 *   onProgress?: (line: string) => void,
 * }} input
 * @returns {Promise<{ stages: object[], evidence: Map<string, object>, reused: string[] }>}
 */
export async function runStagePipeline({ runner, steps, journal = null, onProgress = () => {} }) {
  const evidence = new Map();
  const stages = [];
  const reused = [];
  for (const step of steps) {
    if (typeof step.when === 'function' && !step.when(evidence)) continue;
    let stageEvidence = null;
    if (journal) {
      const entry = await journal.read(step.id);
      if (stageEntryValid(entry, { key: journal.key, stageId: step.id })) {
        stageEvidence = entry.evidence;
        reused.push(step.id);
        onProgress(`review: stage ${step.id} reused (journal)`);
      }
    }
    if (!stageEvidence) {
      const task = typeof step.task === 'function' ? step.task(evidence) : step.task;
      const outcome = await runner.run(step.agent, step.name, task);
      stageEvidence = outcome?.evidence ?? null;
      if (!stageEvidence) throw new Error(`stage ${step.id} produced no evidence`);
      if (journal) await journal.write(step.id, stageEvidence);
    }
    evidence.set(step.id, stageEvidence);
    stages.push(stageEvidence);
  }
  return { stages, evidence, reused };
}

/**
 * The tool budget of one hunter lane, from what the scout found: a small diff and few consumers get
 * a short leash; anything larger gets the full one.
 *
 * @param {{ changedPaths: number, consumers: number }} input
 * @returns {number}
 */
export function hunterBudget({ changedPaths, consumers }) {
  return changedPaths <= 5 && consumers <= 3 ? 15 : 30;
}
