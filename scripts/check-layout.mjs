import { access, readFile } from 'node:fs/promises';

const required = [
  'package.json',
  '.omp-plugin/marketplace.json',
  'skills/reality-first-review/SKILL.md',
  'agents/reviewer-kit.md',
  'templates/githooks/pre-commit',
  'scripts/run-review.mjs',
  'scripts/install-hook.ps1',
  'scripts/install-hook.sh',
  'src/index.mjs',
  'src/extension.mjs',
  'src/application/installer-service.mjs',
  'AGENTS.md',
  'ROADMAP.md',
  'CHANGELOG.md',
  '.github/workflows/ci.yml',
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
