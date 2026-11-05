// The file set the plugin cannot lose. The layout check and its test read the same list, so a file
// that disappears from the required set is caught by a failing test, not by inspection.

import { access } from 'node:fs/promises';
import path from 'node:path';

// The Claude Code shell ships only these files; everything else (runner, installer, agents, tests)
// is deliberately absent so the plugin cache stays small.
export const CLAUDE_PLUGIN_FILES = ['.claude-plugin/plugin.json','commands/doctor.md','commands/install-omp.md','commands/review.md','commands/setup.md','hooks/hooks.json','scripts/bridge.mjs'];

export const CLAUDE_PLUGIN_MAX_BYTES = 100 * 1024;

export const REQUIRED_FILES = [
  'src/infra/main-module.mjs',
  'opencode/plugin.mjs',
  'scripts/hook-guard.mjs',
  'scripts/host-install.mjs',
  'scripts/host-doctor.mjs',
  'scripts/sync-host-manifests.mjs',
  'src/domain/host-manifests.mjs',
  'src/domain/host-install-plan.mjs',
  '.codex-plugin/plugin.json',
  '.codex-plugin/hooks.json',
  '.agents/plugins/marketplace.json',

  'package.json',
  '.omp-plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
  ...CLAUDE_PLUGIN_FILES.map((file) => `claude-plugin/${file}`),
  // The native review: one staged snapshot, one native task, a verdict over its evidence.
  'src/native/native-host.mjs',
  'src/native/native-review.mjs',
  'src/native/snapshot.mjs',
  'src/native/assignment.mjs',
  'src/native/verdict.mjs',
  'src/native/task-engine.mjs',
  'src/native/fallback-evidence.mjs',
  'src/domain/file-class.mjs',
  'src/domain/diff-identity.mjs',
  'src/domain/prompt-token.mjs',
  'src/domain/suspicion-map.mjs',
  'src/infra/filesystem-report-store-adapter.mjs',
  // Run records: one observation file per review, outside every repository.
  'src/infra/layout-required.mjs',
  'src/domain/report-envelope.mjs',
  'src/domain/diff-budget.mjs',
  'src/domain/review-run-summary.mjs',
  'src/infra/atomic-json-file.mjs',
  'src/infra/retained-folder.mjs',
  'src/infra/registration-record.mjs',
  'src/infra/repo-identity.mjs',
  'src/infra/review-run-store.mjs',
  'src/native/review-telemetry.mjs',
  'scripts/review-runs.mjs',
  // Release preflight: the facts of a release that are knowable before the review runs, and the
  // certificate that lets a second preflight reuse one gate run.
  'scripts/release-preflight.mjs',
  'src/domain/mutation-certificate.mjs',
  'src/infra/mutation-certificate-store.mjs',
  // Contract reconciliation: a producer and its consumer are settled by calling them.
  'src/native/contract/find.mjs',
  'src/native/contract/analyze.mjs',
  'src/native/contract/probe.mjs',
  // Maintainability review: deterministic candidate file, one subagent stage, one measure script.
  'src/native/maintainability/config.mjs',
  'src/native/maintainability/extract.mjs',
  'src/native/maintainability/group.mjs',
  'src/native/maintainability/analyze.mjs',
  'scripts/measure-maintainability.mjs',
  'agents/review-maintainability.md',
  // The hook: installer, guard, shim and target registry.
  'src/domain/runner-version.mjs',
  'src/infra/vendored-kit-files.mjs',
  'src/domain/target-policy.mjs',
  'src/domain/hook-template.mjs',
  'src/domain/hook-shim.mjs',
  'src/domain/git-commit-command.mjs',
  'scripts/stamp-hook.mjs',
  'src/infra/target-registry.mjs',
  'scripts/sync-targets.mjs',
  '.specs/native-task-review/REQUIREMENTS.md',
  '.specs/native-task-review/ACCEPTANCE_CRITERIA.md',
  'skills/reality-first-review/SKILL.md',
  'skills/multi-stage-review/SKILL.md',
  'agents/reviewer-kit.md',
  'agents/review-context-scout.md',
  'agents/review-risk-hunter.md',
  'agents/review-finding-verifier.md',
  'templates/githooks/pre-commit',
  'templates/review-kit/run-review.mjs',
  'scripts/run-review.mjs',
  'scripts/run-mutation-tests.mjs',
  'scripts/mutation-runner.mjs',
  'scripts/mutation-test-reporter.mjs',
  'scripts/mutation-selectors.json',
  'scripts/setup-hook.mjs',
  'scripts/deliver.mjs',
  'scripts/install-hook.ps1',
  'scripts/install-hook.sh',
  'src/index.mjs',
  'src/extension.mjs',
  'src/application/installer-service.mjs',
  'AGENTS.md',
  'ROADMAP.md',
  'CHANGELOG.md',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'scripts/audit-range.mjs',
  'skills/range-audit/SKILL.md',
  'agents/review-range-auditor.md',
  'skills/slop/SKILL.md',
  'agents/slop.md',
  'agents/slop-scout.md',
  'agents/slop-verifier.md',
  'src/domain/slop-prompt.mjs',
  'src/domain/slop-report.mjs',
];

/**
 * Every required file must exist under `root`. The error names the first missing path, so a
 * removed file fails the check on itself instead of on the first read that follows it.
 *
 * @param {string} [root]
 * @param {string[]} [files]
 * @returns {Promise<void>}
 */
export async function assertRequiredFiles(root = process.cwd(), files = REQUIRED_FILES) {
  for (const file of files) {
    try {
      await access(path.resolve(root, file));
    } catch {
      throw new Error(`missing required file: ${file}`);
    }
  }
}
