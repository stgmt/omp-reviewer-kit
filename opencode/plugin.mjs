// The OpenCode plugin module. OpenCode installs this package from its git address and resolves
// `exports["./server"]`; it registers the read-only Git tool and the commit guard hook.
//
// Nothing is duplicated here: the guard, the review launcher and the rule that only `git commit`
// triggers a review all live in `scripts/hook-guard.mjs`, the same file the Codex hook and the
// vendored pre-commit hook use.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadOnlyGitTool } from './read-only-git.mjs';
import { createReviewKitTool } from './kit-tool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs the guard for one shell command and returns the parsed answer.
 *
 * @param {string} command
 * @param {string|undefined} directory
 * @returns {{ decision: 'allow'|'block', reason: string }}
 */
export function runGuard(command, directory) {
  const result = spawnSync('node', [path.join(ROOT, 'scripts', 'hook-guard.mjs'), '--opencode'], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    cwd: directory,
    windowsHide: true,
  });
  if (result.status === 0) return { decision: 'allow', reason: '' };
  let parsed = {};
  try {
    parsed = JSON.parse(String(result.stdout ?? '{}'));
  } catch {
    parsed = {};
  }
  const fallback = String(result.stderr ?? '').trim() || result.error?.message || 'the review blocked this commit';
  return { decision: 'block', reason: parsed.reason ?? fallback };
}

/**
 * The hook OpenCode calls before a tool executes. A blocked decision throws, which is how an OpenCode
 * plugin stops a tool; anything else returns normally.
 *
 * @param {{ tool?: string }} input
 * @param {{ args?: Record<string, unknown> }} output
 * @param {string|undefined} directory
 */
export async function beforeTool(input, output, directory) {
  const tool = String(input?.tool ?? '');
  if (tool !== 'bash' && tool !== 'shell') return;
  const command = typeof output?.args?.command === 'string' ? output.args.command : null;
  if (!command) return;
  const workdir = typeof output?.args?.workdir === 'string'
    ? path.resolve(directory ?? process.cwd(), output.args.workdir)
    : directory;
  const decision = runGuard(command, workdir);
  if (decision.decision === 'block') throw new Error(decision.reason);
}

export default {
  id: 'omp-reviewer-kit',
  async server({ directory } = {}) {
    return {
      tool: { review_git: createReadOnlyGitTool(), review_kit: createReviewKitTool() },
      'tool.execute.before': (input, output) => beforeTool(input, output, directory),
    };
  },
};
