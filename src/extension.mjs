import { PluginInstallerService } from './application/installer-service.mjs';
import { isGitCommitCommand } from './domain/git-commit-command.mjs';
import { SlopPrompt } from './domain/slop-prompt.mjs';

const REVIEW_STATUS_KEY = 'reviewer-kit';

function textFromToolValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromToolValue).join('\n');
  if (!value || typeof value !== 'object') return '';
  return [value.text, value.output, value.content, value.result]
    .map(textFromToolValue)
    .filter(Boolean)
    .join('\n');
}

function bashCommand(args) {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  return typeof args.command === 'string' ? args.command : '';
}

/**
 * Parses /slop command arguments into { target, focus }.
 * Accepts a string ("src/x --focus=architecture") or an args array.
 * `--focus=X` / `--focus X` set the focus; remaining tokens form the target.
 */
function parseSlopArgs(args) {
  const tokens = Array.isArray(args)
    ? args.map(String)
    : String(args ?? '').split(/\s+/).filter(Boolean);
  let focus = '';
  const rest = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--focus') {
      // Consume the flag even without a value: a trailing '--focus' yields
      // empty focus, never positional target text.
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        focus = tokens[i + 1];
        i += 1;
      }
    } else if (token.startsWith('--focus=')) {
      focus = token.slice('--focus='.length);
    } else {
      rest.push(token);
    }
  }
  return { target: rest.join(' '), focus };
}

function setReviewStatus(ctx, text) {
  ctx.ui?.setStatus?.(REVIEW_STATUS_KEY, text);
}

/**
 * The native host prints `review: PASS` or `review: BLOCK (reason)` as the last verdict line.
 *
 * @param {string} output
 * @param {boolean} isError
 * @returns {string}
 */
function finalReviewStatus(output, isError) {
  // BLOCK is checked first: a stale PASS line never outranks a BLOCK verdict in the same output.
  if (/^review: BLOCK/m.test(output)) return 'reviewer-kit: native review · BLOCK · commit stopped; report saved';
  if (/^review: PASS$/m.test(output)) return 'reviewer-kit: native review · PASS · commit may continue';
  if (/^review: SKIPPED \(no staged changes\)$/m.test(output)) return 'reviewer-kit: native review · SKIPPED · no staged changes; commit may continue';
  if (isError) return 'reviewer-kit: native review · error · commit stopped';
  return 'reviewer-kit: native review · finished; result not recognized';
}


/**
 * Native Oh My Pi Extension Entry Point.
 *
 * Implements OMP extension lifecycle:
 * - Subscribes to `session_start` for non-intrusive automatic hook setup in Git repositories.
 * - Registers `/reviewer-kit:setup` for explicit hook initialization.
 * - Registers `/reviewer-kit:status` for inspecting review gate state.
 * - Registers `/reviewer-kit:doctor` for running environment diagnostics.
 *
 * @param {import('@oh-my-pi/pi-coding-agent').ExtensionAPI} pi
 */
export default function initExtension(pi) {
  const installer = new PluginInstallerService();

  const activeReviews = new Map();
  const finalStatusTimers = new Map();
  let reviewGeneration = 0;

  // A commit must run the review hook. When git would run another hook (a stray core.hooksPath), the
  // guard repairs the checkout and lets the commit go on, or refuses it with the reason.
  pi.on('tool_call', async (event, ctx) => {
    if (!['bash', 'shell', 'terminal'].includes(String(event.toolName).toLowerCase())) return undefined;
    if (!isGitCommitCommand(bashCommand(event.input ?? event.args))) return undefined;
    const guard = await installer.guardCommit(ctx.cwd);
    if (guard.action === 'block') return { block: true, reason: guard.message };
    if (guard.repaired && guard.message) ctx.ui?.notify?.(guard.message, 'warning');
    return undefined;
  });

  pi.on('tool_execution_start', async (event, ctx) => {
    if (!['bash', 'shell', 'terminal'].includes(String(event.toolName).toLowerCase())) return;
    if (!isGitCommitCommand(bashCommand(event.args))) return;

    const generation = ++reviewGeneration;
    activeReviews.set(event.toolCallId, { generation });
    setReviewStatus(ctx, 'reviewer-kit: native review running for the commit');
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    const active = activeReviews.get(event.toolCallId);
    if (!active) return;
    activeReviews.delete(event.toolCallId);
    const previousTimer = finalStatusTimers.get(event.toolCallId);
    if (previousTimer) clearTimeout(previousTimer);

    setReviewStatus(ctx, finalReviewStatus(textFromToolValue(event.result), event.isError));
    const generation = active.generation;
    const timer = setTimeout(() => {
      finalStatusTimers.delete(event.toolCallId);
      if (reviewGeneration !== generation) return;
      setReviewStatus(ctx, 'reviewer-kit: active');
    }, 8_000);
    timer.unref?.();
    finalStatusTimers.set(event.toolCallId, timer);
  });

  // =========================================================================
  // Slash Commands
  // =========================================================================

  pi.registerCommand('reviewer-kit:setup', {
    description: 'Install or repair the pre-commit review hook in the active project',
    handler: async (_args, ctx) => {
      try {
        const result = await installer.setup(ctx.cwd);
        if (result.success) {
          ctx.ui.notify(result.message, 'info');
          if (ctx.ui?.setStatus) {
            ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: active');
          }
        } else if (result.state === 'conflict') {
          ctx.ui.notify(`reviewer-kit setup conflict: ${result.message}`, 'warning');
          if (ctx.ui?.setStatus) {
            ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: conflict');
          }
        } else if (result.state === 'skipped') {
          ctx.ui.notify(result.message, 'warning');
        }
      } catch (err) {
        ctx.ui.notify(`reviewer-kit setup failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        if (ctx.ui?.setStatus) {
          ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: error');
        }
      }
    },
  });

  pi.registerCommand('reviewer-kit:status', {
    description: 'Display pre-commit review hook status in the active project',
    handler: async (_args, ctx) => {
      try {
        const info = await installer.status(ctx.cwd);
        if (!info.isGitRepo) {
          ctx.ui.notify('reviewer-kit: active directory is not a Git repository.', 'warning');
          return;
        }

        const lines = [
          `Repository: ${info.repoRoot}`,
          `Git core.hooksPath: ${info.configuredHooksPath ?? 'unset'}${info.hooksPathConfigured ? ' (OK)' : ''}`,
          `Pre-commit Hook: ${info.hookFilePresent ? (info.hookOwned ? 'OK (owned)' : info.hookChained ? (info.chainedHookPresent && info.chainedHookCurrent ? 'OK (chained)' : 'CHAINED (entry ' + (info.chainedHookPresent ? 'stale' : 'missing') + ')') : 'CONFLICT (unowned)') : 'MISSING'}`,
          `Runner Script: ${info.runnerPresent ? (info.runnerCurrent ? 'OK (current)' : 'STALE') : 'MISSING'}`,
        ];

        if (info.effectiveHook?.kitExpected) {
          lines.push(`Effective Hook: ${info.effectiveHook.effective ? `OK (git runs ${info.effectiveHook.hookPath}, ${info.effectiveHook.kind})` : `NOT REVIEWED (git runs ${info.effectiveHook.hookPath}: ${info.effectiveHook.kind})`}`);
        }

        if (info.conflictReason) {
          lines.push(`Conflict: ${info.conflictReason}`);
        }

        let overallStatus;
        let notifyLevel;
        if (info.state === 'active') {
          overallStatus = 'ACTIVE (commits guarded)';
          notifyLevel = 'info';
        } else if (info.state === 'conflict') {
          overallStatus = 'CONFLICT (manual resolution required)';
          notifyLevel = 'warning';
        } else {
          overallStatus = 'INACTIVE';
          notifyLevel = 'warning';
        }
        lines.push(`Status: ${overallStatus}`);

        if (info.latestReview) {
          lines.push(`Latest Review: ${info.latestReview.verdict} (${info.latestReview.date})`);
          lines.push(`Report: ${info.latestReview.path}`);
        }

        ctx.ui.notify(lines.join('\n'), notifyLevel);
      } catch (err) {
        ctx.ui.notify(`reviewer-kit status check failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });

  pi.registerCommand('reviewer-kit:doctor', {
    description: 'Run diagnostics on OMP Review Kit environment and setup',
    handler: async (_args, ctx) => {
      try {
        const report = await installer.doctor(ctx.cwd);
        const lines = report.checks.map((c) => `[${c.status}] ${c.name}: ${c.message}`);
        const overall = report.ok ? 'All critical checks passed.' : 'One or more checks failed.';
        ctx.ui.notify(`${lines.join('\n')}\n\n${overall}`, report.ok ? 'info' : 'error');
      } catch (err) {
        ctx.ui.notify(`reviewer-kit doctor failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
  pi.registerCommand('slop', {
    description: 'Run the adversarial 2-in-1 slop audit (parasitic architecture, spec slop, dead checks) on a target',
    handler: async (args, ctx) => {
      const { target, focus } = parseSlopArgs(args);
      const prompt = new SlopPrompt({ target, focus }).toString();
      // pi.sendUserMessage is fire-and-forget in the ExtensionAPI contract
      // (returns void, wraps session.sendUserMessage asynchronously). The turn
      // starts on the next microtask/tick; calling waitForIdle() synchronously
      // at 0ms would see an empty #runningPrompt and resolve immediately, causing
      // print-mode callers to dispose() before the model begins streaming.
      // Wait for the turn to acquire the streaming state, then block until idle.
      pi.sendUserMessage(prompt);
      if (ctx?.isIdle && ctx?.waitForIdle) {
        const start = Date.now();
        while (ctx.isIdle() && Date.now() - start < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await ctx.waitForIdle();
      }
    },
  });


  // =========================================================================
  // Lifecycle Events
  // =========================================================================

  // A new plugin release must reach every repository that already runs the hook, not only
  // the one this session happens to be in.
  const healOtherRepositories = (exceptRoot) => installer.healTargets({ exceptRoot }).then(() => undefined, () => undefined);

  pi.on('session_start', async (_event, ctx) => {
    try {
      const info = await installer.status(ctx.cwd);
      if (info.state === 'not-git' || !info.isGitRepo) {
        await healOtherRepositories(null);
        return;
      }

      const result = await installer.setup(ctx.cwd);
      if (result.success) await installer.registerTarget(info.repoRoot);
      await healOtherRepositories(info.repoRoot);
      if (ctx.ui?.setStatus) {
        if (result.success) {
          ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: active');
        } else if (result.state === 'conflict') {
          ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: conflict');
        }
      }
    } catch (err) {
      if (pi.logger?.warn) {
        pi.logger.warn(`[reviewer-kit] auto-setup failed for ${ctx.cwd}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (ctx.ui?.setStatus) {
        ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: error');
      }
    }
  });
}
