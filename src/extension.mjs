import { PluginInstallerService } from './application/installer-service.mjs';

/**
 * Native Oh My Pi Extension Entry Point.
 *
 * Implements OMP extension lifecycle:
 * - Subscribes to `session_start` for non-intrusive hook status detection.
 * - Registers `/reviewer-kit:setup` for in-session hook initialization.
 * - Registers `/reviewer-kit:status` for inspecting review gate state.
 * - Registers `/reviewer-kit:doctor` for running environment diagnostics.
 *
 * @param {import('@oh-my-pi/pi-coding-agent').ExtensionAPI} pi
 */
export default function initExtension(pi) {
  const installer = new PluginInstallerService();

  // =========================================================================
  // Slash Commands
  // =========================================================================

  pi.registerCommand('reviewer-kit:setup', {
    description: 'Install or repair the pre-commit review hook in the active project',
    handler: async (_args, ctx) => {
      try {
        const result = await installer.setup(ctx.cwd);
        ctx.ui.notify(result.message, 'info');
        if (ctx.ui.setStatus) {
          ctx.ui.setStatus('reviewer-kit', 'reviewer-kit: active');
        }
      } catch (err) {
        ctx.ui.notify(`reviewer-kit setup failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
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
          `Git core.hooksPath: ${info.hooksPathConfigured ? 'OK (.githooks)' : 'MISSING'}`,
          `Pre-commit Hook: ${info.hookFilePresent ? 'OK' : 'MISSING'}`,
          `Runner Script: ${info.runnerPresent ? 'OK' : 'MISSING'}`,
          `Status: ${info.isFullyActive ? 'ACTIVE (commits guarded)' : 'INACTIVE (run /reviewer-kit:setup)'}`,
        ];

        if (info.latestReview) {
          lines.push(`Latest Review: ${info.latestReview.verdict} (${info.latestReview.date})`);
        }

        ctx.ui.notify(lines.join('\n'), info.isFullyActive ? 'info' : 'warning');
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
        const lines = report.checks.map(c => `[${c.status}] ${c.name}: ${c.message}`);
        const overall = report.ok ? 'All critical checks passed.' : 'One or more checks failed.';
        ctx.ui.notify(`${lines.join('\n')}\n\n${overall}`, report.ok ? 'info' : 'error');
      } catch (err) {
        ctx.ui.notify(`reviewer-kit doctor failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });

  // =========================================================================
  // Lifecycle Events
  // =========================================================================

  pi.on('session_start', async (_event, ctx) => {
    try {
      const info = await installer.status(ctx.cwd);
      if (!info.isGitRepo) return;

      if (ctx.ui?.setStatus) {
        ctx.ui.setStatus(
          'reviewer-kit',
          info.isFullyActive ? 'reviewer-kit: active' : 'reviewer-kit: unconfigured'
        );
      }
    } catch {
      // Non-intrusive: silent on session_start errors
    }
  });
}
