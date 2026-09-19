import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginInstallerService } from './application/installer-service.mjs';
import { SlopPrompt } from './domain/slop-prompt.mjs';
import { parseReviewProgress } from './infra/omp-cli-reviewer-adapter.mjs';

const REVIEW_STATUS_KEY = 'reviewer-kit';
const COMMIT_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '--author', '--date', '--cleanup', '--trailer',
]);
const REVIEW_PROGRESS = {
  started: 10,
  probe: 25,
  reviewing: 50,
  working: 50,
  response: 80,
  result: 95,
  passed: 100,
  blocked: 100,
  error: 100,
};

function textFromToolValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromToolValue).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (value.skipped === true) return 'reviewer-kit SKIPPED: no staged changes';
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


function shellCommandSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let quote = '';
  let escaped = false;

  const pushWord = () => {
    if (word.length > 0) {
      words.push(word);
      word = '';
    }
  };
  const pushSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (const char of String(command ?? '')) {
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = '';
      } else {
        word += char;
      }
      continue;
    }
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '\n' || char === '\r') {
      pushSegment();
    } else if (/\s/.test(char)) {
      pushWord();
    } else if (char === ';' || char === '&' || char === '|') {
      pushSegment();
    } else {
      word += char;
    }
  }
  if (escaped) word += '\\';
  pushSegment();
  return segments;
}

function isShellAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word ?? '');
}

function isGitCommitCommand(command) {
  for (const words of shellCommandSegments(command)) {
    let index = 0;
    while (isShellAssignment(words[index])) index += 1;
    while (['sudo', 'command', 'exec', 'env'].includes(words[index]?.toLowerCase())) {
      index += 1;
      while (isShellAssignment(words[index])) index += 1;
    }
    if (!/^git(?:\.exe)?$/i.test(words[index] ?? '')) continue;

    index += 1;
    while (index < words.length) {
      const option = words[index];
      if (option === '--') {
        index += 1;
        break;
      }
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(option)) {
        index += 2;
        continue;
      }
      if (/^--(?:git-dir|work-tree|namespace|exec-path|config-env)=/.test(option)) {
        index += 1;
        continue;
      }
      if (/^--?[^\s]/.test(option)) {
        index += 1;
        continue;
      }
      break;
    }
    if (words[index]?.toLowerCase() === 'commit') {
      const commitArguments = words.slice(index + 1);
      for (let argumentIndex = 0; argumentIndex < commitArguments.length; argumentIndex += 1) {
        const argument = commitArguments[argumentIndex];
        if (argument === '--no-verify' || argument === '-n' || /^-[^-]*n[^-]*$/.test(argument)) return false;
        if (argument === '--') break;
        if (COMMIT_VALUE_OPTIONS.has(argument)) {
          argumentIndex += 1;
        }
      }
      return true;
    }
  }
  return false;
}

function renderReviewStatus(progress) {
  const percent = REVIEW_PROGRESS[progress.state] ?? 10;
  const filled = Math.round(percent / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return 'reviewer-kit: commit hook review [' + bar + '] ' + percent + '% · ' + progress.text;
}

function setReviewStatus(ctx, text) {
  ctx.ui?.setStatus?.(REVIEW_STATUS_KEY, text);
}

/**
 * Reads the persisted live/last review state written by the pre-commit runner.
 * This channel works even when Git does not stream hook stderr into OMP tool
 * events. Returns undefined when the file is absent or malformed.
 *
 * @param {string} repoRoot
 * @returns {Promise<object|undefined>}
 */
async function readLastRunState(repoRoot) {
  try {
    const raw = await readFile(
      path.join(repoRoot, 'audit-reports', 'commit-reviews', 'last-run.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatAgo(iso) {
  const ms = Date.now() - Date.parse(iso ?? '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

const LIVE_RUN_STATES = {
  started: 'started',
  probing: 'probe',
  executing: 'running project checks',
  reviewing: 'reviewing',
  working: 'working',
  response: 'response',
  passed: 'passed',
  blocked: 'blocked',
  failed: 'error',
  skipped: 'result',
};

function renderLiveRunStatus(run) {
  const parts = [String(run.state ?? 'running')];
  if (run.model) parts.push(run.model);
  if (run.pid) parts.push(`pid ${run.pid}`);
  if (Number.isFinite(run.elapsedMs)) parts.push(`${Math.round(run.elapsedMs / 1000)}s`);
  else if (Number.isFinite(run.durationMs)) parts.push(`${Math.round(run.durationMs / 1000)}s`);
  return renderReviewStatus({
    state: LIVE_RUN_STATES[run.state] ?? 'reviewing',
    text: parts.join(' · '),
  });
}

function finalReviewStatus(output, isError) {
  if (/reviewer-kit BLOCK:/i.test(output)) {
    return 'reviewer-kit: commit hook review [██████████] 100% · BLOCK · commit stopped; report saved';
  }
  if (/reviewer-kit INFRA_ERROR:/i.test(output)) {
    return 'reviewer-kit: commit hook review [██████████] 100% · INFRA_ERROR · commit stopped; infrastructure failure, not a verdict';
  }
  if (/reviewer-kit SKIPPED:/i.test(output)) {
    return 'reviewer-kit: commit hook review [██████████] 100% · SKIPPED · no staged changes; commit may continue';
  }
  if (/reviewer-kit PASS:/i.test(output)) {
    return 'reviewer-kit: commit hook review [██████████] 100% · PASS · commit may continue';
  }
  if (isError) {
    return 'reviewer-kit: commit hook review [██████████] 100% · error · commit stopped';
  }
  return 'reviewer-kit: commit hook review [██████████] 100% · finished; result not recognized';
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

  pi.on('tool_execution_start', async (event, ctx) => {
    if (!['bash', 'shell', 'terminal'].includes(String(event.toolName).toLowerCase())) return;
    const command = bashCommand(event.args);
    if (!isGitCommitCommand(command)) return;

    const generation = ++reviewGeneration;
    const active = { buffer: '', generation, poller: undefined };
    activeReviews.set(event.toolCallId, active);
    setReviewStatus(ctx, renderReviewStatus({
      state: 'started',
      text: 'Git commit hook started; staged change sent to review',
    }));

    // Poll the persisted live state: hook stderr does not reliably reach
    // partialResult, so last-run.json is the dependable status channel.
    const repoRoot = ctx.cwd ? installer.getRepoRoot(ctx.cwd) : null;
    if (repoRoot) {
      active.poller = setInterval(async () => {
        const run = await readLastRunState(repoRoot);
        if (run) setReviewStatus(ctx, renderLiveRunStatus(run));
      }, 2_000);
      active.poller.unref?.();
    }
  });

  pi.on('tool_execution_update', async (event, ctx) => {
    const active = activeReviews.get(event.toolCallId);
    if (!active) return;

    const text = textFromToolValue(event.partialResult);
    if (!text) return;
    active.buffer = (active.buffer + text).slice(-16_384);
    const progress = parseReviewProgress(active.buffer);
    if (progress) {
      setReviewStatus(ctx, renderReviewStatus(progress));
      return;
    }

    if (/Working\.\.\./i.test(text)) {
      setReviewStatus(ctx, renderReviewStatus({
        state: 'reviewing',
        text: 'OMP process is active; waiting for model output',
      }));
    }
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    const active = activeReviews.get(event.toolCallId);
    if (!active) return;
    activeReviews.delete(event.toolCallId);
    if (active.poller) clearInterval(active.poller);
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
        }

        if (info.lastRun) {
          const run = info.lastRun;
          const duration = Number.isFinite(run.durationMs)
            ? `${Math.round(run.durationMs / 1000)}s`
            : (Number.isFinite(run.elapsedMs) ? `${Math.round(run.elapsedMs / 1000)}s+` : null);
          const detail = [
            run.state ?? 'unknown',
            run.verdict ? `verdict ${run.verdict}` : null,
            run.model ? `model ${run.model}` : null,
            duration,
            run.updatedAt ?? run.startedAt ?? null,
          ].filter(Boolean).join(' · ');
          lines.push(`Last Run: ${detail}`);
          if (Array.isArray(run.modelsTried) && run.modelsTried.length > 0) {
            lines.push(`  models tried: ${run.modelsTried.join(' -> ')}`);
          }
          if (run.error) {
            lines.push(`  error: ${run.error}`);
          }
          if (run.reportPath) {
            lines.push(`  report: ${run.reportPath}`);
          }
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
    handler: async (args) => {
      const { target, focus } = parseSlopArgs(args);
      return new SlopPrompt({ target, focus }).toString();
    },
  });


  // =========================================================================
  // Lifecycle Events
  // =========================================================================

  pi.on('session_start', async (_event, ctx) => {
    try {
      const info = await installer.status(ctx.cwd);
      if (info.state === 'not-git' || !info.isGitRepo) {
        return;
      }

      const result = await installer.setup(ctx.cwd);
      if (ctx.ui?.setStatus) {
        if (result.success) {
          let text = 'reviewer-kit: active';
          const run = info.repoRoot ? await readLastRunState(info.repoRoot) : undefined;
          if (run?.verdict && run.verdict !== 'SKIPPED') {
            const ago = formatAgo(run.finishedAt ?? run.updatedAt);
            text += ` · last ${run.verdict}${ago ? ` ${ago}` : ''}`;
          }
          ctx.ui.setStatus('reviewer-kit', text);
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
