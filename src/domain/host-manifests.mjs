// One source of truth for every host manifest. `package.json` holds the version; this module turns
// it into the files Claude Code, Codex and OMP read, so a release bump is written in one place and a
// generated file that disagrees with it is a defect, not a different opinion.
//
// Every shape here is copied from what the host actually reads:
// - Claude Code: `.claude-plugin/marketplace.json` (name, owner, plugins[]) and
//   `.claude-plugin/plugin.json` (name required).
// - Codex: `.agents/plugins/marketplace.json` (name, plugins[]) and `.codex-plugin/plugin.json`
//   (name required, skills/mcpServers/hooks/interface optional).
// - OMP: `.omp-plugin/marketplace.json` and `package.json`'s `omp` block.

export const DESCRIPTION = 'Evidence-first multi-stage review system and Git pre-commit hook for OMP, Claude Code, Codex and OpenCode.';

const OWNER = Object.freeze({ name: 'stgmt', url: 'https://github.com/stgmt' });
const HOMEPAGE = 'https://github.com/stgmt/omp-reviewer-kit';

/**
 * @param {string} version
 * @returns {object} the OMP catalogue
 */
export function buildOmpMarketplace(version) {
  return {
    name: 'omp-reviewer-kit',
    owner: { name: OWNER.name },
    plugins: [{
      name: 'omp-reviewer-kit',
      description: DESCRIPTION,
      source: './',
      category: 'development',
      homepage: HOMEPAGE,
      version,
    }],
  };
}

/**
 * The Claude catalogue keeps one entry: the Claude shell, which carries the commands, agents, skills
 * and hooks Claude Code loads.
 *
 * @param {string} version
 * @returns {object}
 */
export function buildClaudeMarketplace(version) {
  return {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: 'omp-reviewer-kit',
    owner: OWNER,
    plugins: [{
      name: 'omp-reviewer-kit',
      description: DESCRIPTION,
      source: './claude-plugin',
      category: 'development',
      homepage: HOMEPAGE,
      version,
    }],
  };
}

/**
 * The Claude plugin manifest inside the shell.
 *
 * @param {string} version
 * @returns {object}
 */
export function buildClaudePluginManifest(version) {
  return {
    name: 'omp-reviewer-kit',
    version,
    description: DESCRIPTION,
    author: OWNER,
    homepage: HOMEPAGE,
    repository: `${HOMEPAGE}.git`,
    license: 'MIT',
    keywords: ['review', 'quality', 'git-hooks', 'agents', 'skills'],
    // The kit's own agents are OMP-format and carry OMP frontmatter; Claude Code must not load them.
    // The shell ships its own Claude agents under claude-plugin/agents instead.
    agents: [],
  };
}

/**
 * The Codex plugin manifest at the repository root. Codex reads `skills/` from here and the hooks
 * file, and its `interface` block is what the CLI shows in a listing.
 *
 * @param {string} version
 * @returns {object}
 */
export function buildCodexPluginManifest(version) {
  return {
    name: 'omp-reviewer-kit',
    version,
    description: DESCRIPTION,
    skills: './skills',
    hooks: './.codex-plugin/hooks.json',
    interface: {
      display_name: 'OMP Reviewer Kit',
      short_description: 'Evidence-first review and a commit guard',
      developer_name: OWNER.name,
      category: 'development',
      website_url: HOMEPAGE,
    },
  };
}

/**
 * The native Codex catalogue. It points at the repository root, because that is where `skills/` and
 * `.codex-plugin/plugin.json` live; the Claude shell is a different plugin and stays in its own
 * catalogue.
 *
 * @param {string} version
 * @returns {object}
 */
export function buildCodexMarketplace(version) {
  return {
    name: 'omp-reviewer-kit',
    interface: { displayName: 'OMP Reviewer Kit' },
    plugins: [{
      name: 'omp-reviewer-kit',
      source: { source: 'url', url: './' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Development',
      version,
    }],
  };
}

/**
 * The Codex hooks file: one PreToolUse handler on the shell tool, delegating to the same guard the
 * vendored hook runs. The handler receives the tool payload on stdin and answers with the documented
 * deny contract, so a blocked commit is reported by Codex itself.
 *
 * @returns {object}
 */
export function buildCodexHooks() {
  return {
    description: 'Blocks a git commit until the review passes.',
    hooks: {
      PreToolUse: [{
        matcher: '^Bash$',
        hooks: [{
          type: 'command',
          // The guard must answer in Codex's contract, not the default one: without the flag a blocked
          // review would be reported in a shape Codex does not read.
          command: 'node "${PLUGIN_ROOT}/scripts/hook-guard.mjs" --codex',
          timeout: 3600,
          statusMessage: 'reviewing the staged change',
        }],
      }],
    },
  };
}

/**
 * Every generated file with its content, as one map. The generator writes this map and the check
 * compares it, so the two can never disagree about which files are generated.
 *
 * @param {{ version: string }} input
 * @returns {Array<{ path: string, content: string }>}
 */
export function generatedHostFiles({ version }) {
  return [
    { path: '.omp-plugin/marketplace.json', content: json(buildOmpMarketplace(version)) },
    { path: '.claude-plugin/marketplace.json', content: json(buildClaudeMarketplace(version)) },
    { path: 'claude-plugin/.claude-plugin/plugin.json', content: json(buildClaudePluginManifest(version)) },
    { path: '.codex-plugin/plugin.json', content: json(buildCodexPluginManifest(version)) },
    { path: '.agents/plugins/marketplace.json', content: json(buildCodexMarketplace(version)) },
    { path: '.codex-plugin/hooks.json', content: json(buildCodexHooks()) },
  ];
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
