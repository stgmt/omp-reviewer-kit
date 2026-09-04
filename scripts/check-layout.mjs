import { access } from 'node:fs/promises';

const required = [
  'package.json',
  '.omp-plugin/marketplace.json',
  'skills/reality-first-review/SKILL.md',
  'agents/reviewer-kit.md',
  'templates/githooks/pre-commit',
  'scripts/run-review.mjs',
  'scripts/install-hook.ps1',
  'scripts/install-hook.sh',
];

for (const file of required) await access(file);
console.log(`layout ok: ${required.length} files`);
