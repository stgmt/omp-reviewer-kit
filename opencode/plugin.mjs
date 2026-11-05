// The OpenCode plugin module. OpenCode installs this package from its git address and resolves
// `exports["./server"]`; the module then registers one hook: before a shell tool runs, the commit
// guard decides whether the command is a staged commit and blocks it when the review does.
//
// Nothing is duplicated here: the guard, the review launcher and the rule that only `git commit`
// triggers a review all live in `scripts/hook-guard.mjs`, the same file the Codex hook and the
// vendored pre-commit hook use.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs the guard for one shell command and returns the parsed answer.
 *
 * @param {string} command
 * @returns {{ decision: 'allow'|'block', reason: string }}
 */
export function runGuard(command) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hook-guard.mjs'), '--opencode'], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return { decision: 'allow', reason: '' };
  let parsed = {};
  try {
    parsed = JSON.parse(String(result.stdout ?? '{}'));
  } catch {
    parsed = {};
  }
  const fallback = String(result.stderr ?? '').trim() || 'the review blocked this commit';
  return { decision: 'block', reason: parsed.reason ?? fallback };
}

/**
 * The hook OpenCode calls before a tool executes. A blocked decision throws, which is how an OpenCode
 * plugin stops a tool; anything else returns normally.
 *
 * @param {{ tool?: string, args?: Record<string, unknown> }} input
 */
export async function beforeTool(input) {
  const tool = String(input?.tool ?? '');
  if (tool !== 'bash' && tool !== 'shell') return;
  const command = typeof input?.args?.command === 'string' ? input.args.command : null;
  if (!command) return;
  const decision = runGuard(command);
  if (decision.decision === 'block') throw new Error(decision.reason);
}

export default {
  id: 'omp-reviewer-kit',
  async server() {
    return {
      'tool.execute.before': beforeTool,
    };
  },
};
