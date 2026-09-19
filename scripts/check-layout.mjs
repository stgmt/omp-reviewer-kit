import { access, readFile } from 'node:fs/promises';

const required = [
  'package.json',
  '.omp-plugin/marketplace.json',
  'skills/reality-first-review/SKILL.md',
  'skills/multi-stage-review/SKILL.md',
  'agents/reviewer-kit.md',
  'agents/review-context-scout.md',
  'agents/review-risk-hunter.md',
  'agents/review-finding-verifier.md',
  'templates/githooks/pre-commit',
  'scripts/run-review.mjs',
  'scripts/setup-hook.mjs',
  'scripts/install-hook.ps1',
  'scripts/install-hook.sh',
  'src/index.mjs',
  'src/domain/review-rejection-envelope.mjs',
  'src/extension.mjs',
  'src/application/installer-service.mjs',
  'AGENTS.md',
  'ROADMAP.md',
  'CHANGELOG.md',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'src/domain/suspicion-map.mjs',
  'src/domain/execution-evidence.mjs',
  'src/domain/reverted-snapshot.mjs',
  'src/infra/subprocess-execution-adapter.mjs',
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

for (const file of required) {
  await access(file);
}

// Assert runner synchronization between source and self-hosted copy
const distRunner = await readFile('scripts/run-review.mjs', 'utf8');
const localRunner = await readFile('.omp/review-kit/run-review.mjs', 'utf8');

if (distRunner !== localRunner) {
  throw new Error('Drift detected: scripts/run-review.mjs and .omp/review-kit/run-review.mjs must be identical.');
}

console.log(`layout ok: ${required.length} files verified and runner copies synchronized`);
