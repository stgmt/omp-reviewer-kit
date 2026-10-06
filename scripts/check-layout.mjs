import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// The Claude Code shell ships only these files; everything else (runner,
// installer, agents, tests) is deliberately absent so the plugin cache stays small.
const CLAUDE_PLUGIN_FILES = [
  '.claude-plugin/plugin.json',
  'commands/doctor.md',
  'commands/install-omp.md',
  'commands/review.md',
  'commands/setup.md',
  'hooks/hooks.json',
  'scripts/bridge.mjs',
];
const CLAUDE_PLUGIN_MAX_BYTES = 100 * 1024;

const required = [
  'package.json',
  '.omp-plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
  ...CLAUDE_PLUGIN_FILES.map((file) => `claude-plugin/${file}`),
  'src/domain/runner-version.mjs',
  'src/infra/vendored-kit-files.mjs',
  'src/infra/stage-transcript-stats.mjs',
  'src/domain/context-pack.mjs',
  'src/domain/scout-baseline.mjs',
  'src/domain/hunter-shards.mjs',
  'scripts/sync-targets.mjs',
  'src/infra/filesystem-verdict-cache-adapter.mjs',
  'src/infra/filesystem-round-store-adapter.mjs',
  'src/domain/review-round.mjs',
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

// The runner carries its own version marker; installers refuse to downgrade by it.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const runnerMarker = /^\/\/ omp-reviewer-kit runner v(\d+\.\d+\.\d+)\r?\n/.exec(distRunner);
if (!runnerMarker || runnerMarker[1] !== pkg.version) {
  throw new Error(`scripts/run-review.mjs must start with "// omp-reviewer-kit runner v${pkg.version}".`);
}

// The Claude shell: version-synchronized, exact file set, small payload.
const shellManifest = JSON.parse(await readFile('claude-plugin/.claude-plugin/plugin.json', 'utf8'));
const claudeCatalog = JSON.parse(await readFile('.claude-plugin/marketplace.json', 'utf8'));
if (shellManifest.version !== pkg.version || claudeCatalog.plugins[0].version !== pkg.version) {
  throw new Error('Claude plugin manifest and marketplace versions must equal package.json version.');
}
if (claudeCatalog.plugins[0].source !== './claude-plugin') {
  throw new Error('.claude-plugin/marketplace.json must point its source at ./claude-plugin.');
}
const shellFiles = [];
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else shellFiles.push(full);
  }
};
await walk('claude-plugin');
const shellRelative = shellFiles.map((file) => path.relative('claude-plugin', file).split(path.sep).join('/')).sort();
if (JSON.stringify(shellRelative) !== JSON.stringify([...CLAUDE_PLUGIN_FILES].sort())) {
  throw new Error(`claude-plugin/ must contain exactly: ${CLAUDE_PLUGIN_FILES.join(', ')} (found ${shellRelative.join(', ')}).`);
}
let shellBytes = 0;
for (const file of shellFiles) shellBytes += (await stat(file)).size;
if (shellBytes > CLAUDE_PLUGIN_MAX_BYTES) {
  throw new Error(`claude-plugin/ is ${shellBytes} bytes; the limit is ${CLAUDE_PLUGIN_MAX_BYTES}.`);
}

console.log(`layout ok: ${required.length} files verified and runner copies synchronized`);
