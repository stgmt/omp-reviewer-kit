// Offline investigation artifact for OMP 18.10.4, not a plugin/runtime dependency.
// OMP's TypeScript source requires Bun. No model requests, credentials or config writes.
// Run: bun audit-reports/native-task-role-repro-2026-10-18.mjs <OMP coding-agent src directory>
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'bun:test';

const source = process.argv[2];
assert.ok(source, 'Pass the source directory of the installed OMP 18.10.4');
const file = (relative) => path.resolve(source, relative).replaceAll('\\', '/');

// Only isolate unrelated settings/catalog dependencies; import the real native chain parser,
// effective-chain builder and candidate-selection function, rather than copying the algorithm.
mock.module(file('config/model-resolver.ts'), () => ({
  formatModelString: (model) => `${model.provider}/${model.id}`,
  formatModelStringWithRouting: (model) => `${model.provider}/${model.id}`,
  resolveConfiguredModelPatterns: (value) => [value],
  resolveModelRoleValue: (value) => value,
}));
mock.module(file('config/model-settings.ts'), () => ({ cfgModelRoles: {} }));
mock.module(file('config/model-roles.ts'), () => ({ getRoleInfo: () => undefined, isKindRole: () => false }));
mock.module(file('session/settings.ts'), () => ({ cfgRetryFallbackChains: {}, cfgRetryFallbackRevertPolicy: {} }));
mock.module('@oh-my-pi/pi-catalog/model-thinking', () => ({ clampThinkingLevelForModel: (_model, level) => level, getSupportedEfforts: () => [] }));
mock.module('@oh-my-pi/pi-catalog/models', () => ({ modelsAreEqual: (a, b) => a.provider === b.provider && a.id === b.id }));

const { findRetryFallbackCandidates } = await import(pathToFileURL(file('session/retry-fallback-chains.ts')).href);
const primary = 'opencode-go/longcat-2.5-preview-free:auto';
const currentModel = { provider: 'opencode-go', id: 'longcat-2.5-preview-free' };
const configuredChain = [
  'openai-codex/gpt-6-luna:xhigh',
  'openrouter/openrouter/free',
  'openai-codex/gpt-6-luna:medium',
  'opencode-go/longcat-2.5-preview-free',
  'anthropic/claude-haiku-5-5:medium',
  'opencode-go/cat-jam-free',
];
const role = 'subagent:native-task-repro';
const context = {
  chains: { [role]: configuredChain },
  getModelRole: () => primary,
  modelLookup: { find: () => undefined, hasProvider: () => true },
};
const candidatesFor = (suffix) => findRetryFallbackCandidates(
  context, role, `${currentModel.provider}/${currentModel.id}${suffix}`, currentModel,
).map((entry) => entry.raw);

const bare = candidatesFor('');
const medium = candidatesFor(':medium');
assert.deepEqual(bare, configuredChain.slice(4), 'Native OMP 18.10.4 reproduces the skipped Luna entries for the bare selector');
assert.deepEqual(medium, configuredChain, 'The same chain starts with Luna for a concrete thinking suffix');
console.log(JSON.stringify({
  nativeRole: role,
  primary,
  configuredChain,
  cases: [
    { currentSelector: `${currentModel.provider}/${currentModel.id}`, candidates: bare },
    { currentSelector: `${currentModel.provider}/${currentModel.id}:medium`, candidates: medium },
  ],
  note: 'Reproduces existing native behavior, not an acceptance test for a fix. No provider eligibility/auth checks or live model requests.',
}, null, 2));
