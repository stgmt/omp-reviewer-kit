# SPEC — One package, four hosts: install, update, migrate, uninstall

Status: draft for review. Scope: only how the kit is installed, updated, migrated between install
modes, verified and removed on Claude Code, Codex CLI, OMP and OpenCode. Nothing here is invented:
every host claim cites the installed CLI, a release-tagged source file, or that host's official
documentation.

## 1. Purpose

Today the repository ships one OMP plugin, one Claude Code plugin under `claude-plugin/`, and a
vendored pre-commit pair that consumer repositories commit. Delivery is per-host and manual, the
version is written in several files, and there is no defined answer to "what exactly does an
uninstall leave behind". This specification makes the kit **one package that installs directly from
GitHub on all four hosts, updates by a version bump, migrates between install modes without leaving
two copies, and uninstalls completely.**

Non-goals: review behaviour, agent prompts, the mutation gate, CI topology.

## 2. Terms

- **Host** — Claude Code, Codex CLI, OMP, OpenCode.
- **Package** — this repository as published at `github.com/stgmt/omp-reviewer-kit`.
- **Install mode** — how a host materialised the package: a marketplace clone plus a plugin cache
  directory, an npm-style package directory, or files copied into a config directory.
- **Blast radius** — every file, directory and config key a host touches on install, update,
  migration or uninstall.

## 3. What exists today (verified on this machine)

| Artifact | Path | Read by |
|---|---|---|
| OMP manifest | `package.json` → `omp.extensions`, `omp.version` | OMP |
| OMP marketplace catalog | `.omp-plugin/marketplace.json` | OMP (the string `omp-plugin/marketplace.json` is present in the installed binary) |
| Claude manifest | `claude-plugin/.claude-plugin/plugin.json` | Claude Code |
| Claude marketplace catalog | `.claude-plugin/marketplace.json` | Claude Code; also a fallback path for Codex and OMP |
| Claude shell | `claude-plugin/hooks/hooks.json`, `claude-plugin/commands/`, `claude-plugin/scripts/bridge.mjs` | Claude Code |
| Codex | nothing | — |
| OpenCode | nothing | — |
| Vendored pair | `.omp/review-kit/run-review.mjs`, `.githooks/pre-commit` | every consumer repository |

Observed install state before this work:

- OMP: `omp plugin list --json` reports the package in its **npm** array with
  `path = ~/.omp/plugins/node_modules/omp-reviewer-kit`, installed by
  `omp plugin install github:stgmt/omp-reviewer-kit`. The marketplace named `omp-reviewer-kit` points
  at a **local path** (`omp plugin marketplace list` prints
  `omp-reviewer-kit  E:\repos\omp-reviewer-kit`). The marketplace form
  (`omp plugin install omp-reviewer-kit@omp-reviewer-kit --dry-run`) fails with
  `Runtime package name "omp-reviewer-kit" conflicts with installed package "omp-reviewer-kit"`.
- Claude Code 2.1.219: marketplace `omp-reviewer-kit` from `stgmt/omp-reviewer-kit`, plugin cache at
  `~/.claude/plugins/cache/omp-reviewer-kit/omp-reviewer-kit/0.26.4`, state in
  `~/.claude/settings.json` (`enabledPlugins`, `extraKnownMarketplaces`).
- Codex CLI 0.144.6: no marketplace for this repository.
- OpenCode 1.19.3: no plugin entry for this repository.

## 4. Host capability facts

Verified facts about the installed versions, not a plan.

### 4.1 Claude Code 2.1.219

| Fact | Evidence |
|---|---|
| Marketplace manifest is `.claude-plugin/marketplace.json` at the marketplace root; required keys `name`, `owner`, `plugins` | `https://code.claude.com/docs/en/plugins/marketplace-reference` |
| Plugin manifest `.claude-plugin/plugin.json` is **optional**; `name` is its only required key | `https://code.claude.com/docs/en/plugins/manifest-reference` |
| Add from GitHub: `claude plugin marketplace add <owner/repo>` (also `owner/repo#ref`, `owner/repo@ref`); flags `--scope`, `--sparse` | `claude plugin marketplace add --help` on this box |
| Install: `claude plugin install <plugin>@<marketplace> [--scope user\|project\|local] [--config key=value]` | CLI help on this box |
| Update: `claude plugin update <plugin>@<marketplace>`; the new version loads next session or on `/reload-plugins` | docs `/plugins/cli-reference` |
| Catalog refresh alone: `claude plugin marketplace update [name]`, leaves installed plugins at their version | docs `/plugins/install#update-plugins-now` |
| Uninstall: `claude plugin uninstall <plugin> [--keep-data] [--prune] [-y]`; aliases `remove`, `rm` | CLI help on this box |
| Removing a marketplace from its last scope **also uninstalls every plugin from it** and deletes the cache | docs `/plugins/cli-reference#plugin-marketplace-remove` |
| State: `user` → `~/.claude/settings.json`, `project` → `.claude/settings.json`, `local` → `.claude/settings.local.json` | docs `/plugins/install#choose-an-install-scope` |
| Disk: `~/.claude/plugins/{cache/<marketplace>/<plugin>/<version>, data/<id>, marketplaces/<name>}`, `installed_plugins.json`, `known_marketplaces.json` | docs `/plugins/loading`; observed on this box |
| Version resolution: manifest `version` → marketplace entry `version` → 12-char commit SHA for github/url sources; a pinned version means a bump is required to ship anything | docs `/plugins/loading#how-claude-code-computes-the-version`, `/plugins/manifest-reference#version` |
| A plugin may ship skills, commands, agents, `hooks/hooks.json`, and an MCP server (`.mcp.json` or manifest `mcpServers`) | docs `/plugins/components` |
| Background auto-update is off for third-party marketplaces unless `autoUpdate` is set | docs `/plugins/install#keep-plugins-updated` |
| `claude plugin validate <path> [--strict]` validates a plugin or marketplace manifest | CLI help on this box |

### 4.2 Codex CLI 0.144.6

| Fact | Evidence |
|---|---|
| Marketplace manifest search order at the marketplace root: `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, `.claude-plugin/marketplace.json` | `codex-rs/core-plugins/src/marketplace.rs` @ `rust-v0.144.6` |
| Plugin manifest search order: `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json` | `codex-rs/utils/plugins/src/plugin_namespace.rs` @ `rust-v0.144.6` |
| `plugin.json` keys: `name` (required), `version`, `description`, `keywords`, `skills`, `mcpServers`, `apps`, `hooks`, `interface`; path fields take a string or array, must start with `./` and stay inside the plugin root | `codex-rs/core-plugins/src/manifest.rs` @ `rust-v0.144.6` |
| Commands: `codex plugin marketplace add <owner/repo> [--ref] [--sparse]`, `marketplace list\|upgrade [--marketplace-name]\|remove`, `codex plugin add <plugin>@<marketplace>`, `codex plugin list [--available] [--json]`, `codex plugin remove <plugin>@<marketplace>` | `codex-rs/cli/src/marketplace_cmd.rs`, `codex-rs/cli/src/plugin_cmd.rs` @ `rust-v0.144.6`; `codex plugin --help` on this box |
| Config written: `[marketplaces.<name>] {source_type, source, ref, sparse_paths, last_updated, last_revision}` and `[plugins."<name>@<marketplace>"] enabled = true` in `~/.codex/config.toml` | `marketplace_add.rs`, `marketplace_upgrade_tests.rs`; live `~/.codex/config.toml` |
| Snapshot: `~/.codex/.tmp/marketplaces/<name>` with `.codex-marketplace-install.json` pinning the revision | `core-plugins/src/installed_marketplaces.rs`; live directory |
| Plugin cache: `~/.codex/plugins/cache/<marketplace>/<plugin>/<version\|local>/`; older version dirs are pruned on install | `core-plugins/src/store.rs`; live directories |
| Update path: `codex plugin marketplace upgrade` moves the snapshot; re-running `codex plugin add` reinstalls the plugin. There is **no** `codex plugin update` | `plugin_cmd.rs` help text; `marketplace_upgrade.rs` |
| No plugin slash commands exist; Claude-style `commands/` migrate to skills only through `.codex-plugin/migrated-command-skills` | `tui/src/bottom_pane/slash_commands.rs`, `utils/plugins/src/lib.rs` |
| Hooks supported (`PreToolUse`, `SessionStart`, …) with `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA` in the environment | `hooks/src/engine/discovery.rs`, `config/src/hooks_tests.rs` |
| Per-plugin version pinning does not exist; the selector is `name@marketplace` only | `plugin_cmd.rs` (`PluginSelection::from_plugin_id`) |
| **Verified on this repository**: with no `.agents/plugins/marketplace.json` present, Codex read `.claude-plugin/marketplace.json` and resolved the plugin from it | probe: `CODEX_HOME=<temp> codex plugin marketplace add E:/repos/omp-reviewer-kit` → `Added marketplace`; `codex plugin list --json --available` → `pluginId omp-reviewer-kit@omp-reviewer-kit, version 0.26.4, source.path = E:\\repos\\omp-reviewer-kit\\claude-plugin` |
| `codex plugin list` requires `--json` together with `--available` | probe error: `the following required arguments were not provided: --json` |

### 4.3 OMP 18.14.1

| Fact | Evidence |
|---|---|
| Install from GitHub: `omp plugin install github:<owner>/<repo>`; `--dry-run` supported | `omp plugin install github:stgmt/omp-reviewer-kit --dry-run` → `[dry-run] Would install …` |
| Marketplaces: `omp plugin marketplace add/list/remove`; a source may be `owner/repo`, a full URL, or a **local path** | `omp plugin marketplace list` on this box |
| Catalog paths looked up in a repository include `omp-plugin/marketplace.json` and `.claude-plugin/marketplace.json` | strings present in the installed `omp.exe` |
| Update: `omp plugin upgrade [--dry-run]` (`All marketplace plugins are up to date`); `install --force` re-installs the GitHub form | CLI help on this box |
| State: `~/.omp/plugins/installed_plugins.json` (schema v2: `scope`, `installPath`, `version`, timestamps), `~/.omp/plugins/omp-plugins.lock.json` (`version`, `enabled`, `enabledFeatures`), `~/.omp/plugins/project_registries.json` | files on this box |
| Disk: npm form in `~/.omp/plugins/node_modules/<name>`; marketplace form in `~/.omp/plugins/cache/plugins/<marketplace>___<plugin>___<version>` | `installed_plugins.json`, `omp plugin list --json` |
| One name cannot exist in both modes: the marketplace install refuses while the npm package is installed | error quoted in §3 |
| A plugin may ship `omp.extensions`, `agents/`, `skills/`, and hooks through its extension | `package.json` `omp` block; `src/extension.mjs` |

### 4.4 OpenCode 1.19.3

| Fact | Evidence |
|---|---|
| Plugins are declared in the `plugin` array of `opencode.json`/`opencode.jsonc` (`string` or `[string, options]`) | `packages/plugin/src/index.ts` @ `v1.19.3`; `https://opencode.ai/docs/plugins` |
| Accepted specs: npm names, `pkg@range\|tag\|alias`, `pkg@git+https://…`, local file paths, local directories with `package.json` or an index file | `packages/opencode/src/plugin/shared.ts` @ `v1.19.3` |
| Only command: `opencode plugin <module> [-g] [-f]` (alias `opencode plug`); installs into `<cache>/packages/<spec>/node_modules/<pkg>` and patches the config array (JSONC-preserving, file lock) | `packages/opencode/src/cli/cmd/plug.ts`, `plugin/install.ts` @ `v1.19.3` |
| **No** update command, **no** per-plugin uninstall, **no** plugin list, **no** marketplace or registry | command list @ `v1.19.3`; `https://opencode.ai/docs/ecosystem` |
| A bare npm name is rewritten to `name@latest`, the cache dir is keyed by that spec, so `latest` is pinned at first install; changing it requires `--force` | `shared.ts`, `install.ts`, `packages/core/src/npm.ts` @ `v1.19.3` |
| Plugin module contract: exported function(s) `(input, options) => Promise<Hooks>`, or a `default` object `{ id?, server }` | `packages/plugin/src/index.ts` @ `v1.19.3` |
| Agents, commands, skills and MCP are separate discovery: `{agent,agents}/**/*.md`, `{command,commands}/**/*.md`, `{skill,skills}/**/SKILL.md` per config directory, plus the `mcp` config key | `config/agent.ts`, `config/command.ts`, `skill/index.ts` @ `v1.19.3`; host docs `/agents`, `/commands`, `/skills`, `/mcp-servers` |
| An npm-installed plugin **cannot** ship agents/commands/skills: discovery never looks inside `<cache>/packages/<spec>/node_modules` | `config/paths.ts` vs the four discovery globs @ `v1.19.3` |
| `opencode uninstall` removes the CLI itself, not a plugin | `opencode uninstall --help` |
| A package without `exports["./server"]`, `main`, `exports["./tui"]` or `oc-themes` is **refused** at install time | probe: `opencode plugin "omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git" -g` → `Plugin package ready` then `No plugin targets found` / `does not expose plugin entrypoints in package.json` |
| With `exports: {"./server": "./plugin.mjs"}` the same install succeeds and writes the spec into the `plugin` array | probe against a local package with that export: `Installed <path>`, config `{"plugin":["<path>"]}` |

## 5. Design

### 5.1 One source of truth

`package.json` keeps `version` and `omp.version`. Every other version field and every host manifest is
**generated** from it by `scripts/sync-host-manifests.mjs`:

| Generated file | Host | Content |
|---|---|---|
| `.omp-plugin/marketplace.json` | OMP | name, owner, entry `source: "./"`, `version` |
| `.claude-plugin/marketplace.json` | Claude Code, Codex (fallback), OMP (fallback) | one entry for the Claude shell (`source: "./claude-plugin"`), one for the package root (`source: "./"`) |
| `claude-plugin/.claude-plugin/plugin.json` | Claude Code | `name`, `version`, `description` |
| `.codex-plugin/plugin.json` | Codex | `name`, `version`, `skills`, `hooks`, `interface` |
| `.agents/plugins/marketplace.json` | Codex (native form) | name, `plugins[]` with `source: {"source":"url","url":"./"}` |
| `opencode/plugin.mjs` | OpenCode | a plugin module exporting the kit's hooks through `default { id, server }` |
| `package.json` → `exports["./server"]` | OpenCode | the entry OpenCode resolves; without it an install from GitHub is refused (§4.4) |

The generator is idempotent, runs inside `npm run check`, and the release preflight fails when a
generated file disagrees with `package.json` — the rule the runner marker already follows.

### 5.2 What each host receives

| Component | Claude Code | Codex | OMP | OpenCode |
|---|---|---|---|---|
| Review agents (`agents/*.md`) | `agents/` | — (skills only) | `agents/` through the plugin | copied into `~/.config/opencode/agents/` by the installer |
| Skills (`skills/*/SKILL.md`) | `skills/` | `skills/` | `skills/` | copied into `~/.config/opencode/skills/` |
| Slash commands (`commands/*.md`) | `commands/` | generated `.codex-plugin/migrated-command-skills` | extension commands | copied into `~/.config/opencode/commands/` |
| Commit guard | `hooks/hooks.json` | `hooks` in `.codex-plugin/plugin.json` | extension `tool_call` handler | plugin hook `tool.execute.before` |
| MCP server | `.mcp.json` | `mcpServers` | extension | `mcp` config key written by the installer |
| Vendored pair in consumer repositories | — | — | `.githooks/pre-commit` + `.omp/review-kit/run-review.mjs` | — |

The commit guard runs through exactly one mechanism per host. The OpenCode module is thin: it exports
`tool.execute.before` and calls the same `scripts/run-review.mjs` launcher, so nothing is duplicated.

### 5.3 Install, update, verify, uninstall

**Claude Code**

```sh
claude plugin marketplace add stgmt/omp-reviewer-kit
claude plugin install omp-reviewer-kit@omp-reviewer-kit --scope user
claude plugin details omp-reviewer-kit@omp-reviewer-kit
claude plugin marketplace update omp-reviewer-kit   # after a release
claude plugin update omp-reviewer-kit@omp-reviewer-kit
claude plugin uninstall omp-reviewer-kit@omp-reviewer-kit --prune -y
claude plugin marketplace remove omp-reviewer-kit
```

**Codex**

```sh
codex plugin marketplace add stgmt/omp-reviewer-kit --ref main
codex plugin add omp-reviewer-kit@omp-reviewer-kit
codex plugin list --json
codex plugin marketplace upgrade --marketplace-name omp-reviewer-kit   # after a release
codex plugin add omp-reviewer-kit@omp-reviewer-kit                     # after a release
codex plugin remove omp-reviewer-kit@omp-reviewer-kit
codex plugin marketplace remove omp-reviewer-kit
```

**OMP**

```sh
omp plugin marketplace add stgmt/omp-reviewer-kit
omp plugin install omp-reviewer-kit@omp-reviewer-kit --scope user
omp plugin list --json
omp plugin upgrade                                    # after a release
omp plugin uninstall omp-reviewer-kit --scope user
omp plugin marketplace remove omp-reviewer-kit
```

The npm form (`omp plugin install github:stgmt/omp-reviewer-kit`) becomes the **legacy** mode; §6
migrates away from it and it is not documented as an install path.

**OpenCode** — no marketplace exists, so the installer does the work:

```sh
node scripts/host-install.mjs --host opencode --apply
opencode plugin "omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git" -g   # subject to Q1
opencode debug paths && opencode debug skill
node scripts/host-install.mjs --host opencode --apply --force    # after a release
node scripts/host-install.mjs --host opencode --remove
```

## 6. Migration

Target state: every host installs from `github.com/stgmt/omp-reviewer-kit` through its own mechanism;
no install points at a local checkout; one name exists in one mode per host.

| From | To | Steps | Guard |
|---|---|---|---|
| OMP npm form (`node_modules/omp-reviewer-kit`) | OMP marketplace form | `omp plugin uninstall omp-reviewer-kit --scope user` → `omp plugin marketplace add stgmt/omp-reviewer-kit` → `omp plugin install omp-reviewer-kit@omp-reviewer-kit` | the marketplace install fails while the npm package exists (observed), so the order is mandatory |
| OMP marketplace on a **local path** | marketplace on the repository | `omp plugin marketplace remove omp-reviewer-kit` → `omp plugin marketplace add stgmt/omp-reviewer-kit` | removing a local-path entry deletes no files; the checkout stays untouched |
| Claude Code (already correct) | unchanged | none | `claude plugin list` shows one version |
| Codex (absent) | marketplace form | §5.3 — note the verified fact that the current catalog entry points at `./claude-plugin`, so Codex installs the Claude shell; when the shell gains skills the entry may point at `./` instead, which this spec records as a decision to take with the Codex install | `codex plugin list --json --available` shows one entry with the expected `source.path` |
| OpenCode (absent) | plugin entry plus copied components | §5.3 | `opencode debug skill` lists the kit's skills |
| Consumer repositories with the vendored pair | unchanged | the pair is committed, not installed; `sync-targets --apply` keeps it current | `bridge.mjs doctor` reports every registered repository current |

Migration is idempotent: every step run twice changes nothing, and the installer refuses to proceed
when two install modes for one name exist, printing both paths.

## 7. Blast radius

| Host | Install writes | Update rewrites | Uninstall removes |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` (`enabledPlugins`, `extraKnownMarketplaces`), `~/.claude/plugins/marketplaces/omp-reviewer-kit`, `~/.claude/plugins/cache/omp-reviewer-kit/omp-reviewer-kit/<version>`, `installed_plugins.json`, `known_marketplaces.json` | marketplace clone and a new cache version dir; the old dir gets `.orphaned_at` and is swept after 14 days | settings entries, cache dir, data dir unless `--keep-data`, registry rows; removing the marketplace also deletes the clone |
| Codex | `~/.codex/config.toml` (`[marketplaces.*]`, `[plugins."…"]`), `~/.codex/.tmp/marketplaces/omp-reviewer-kit` + `.codex-marketplace-install.json`, `~/.codex/plugins/cache/omp-reviewer-kit/omp-reviewer-kit/<version>` | snapshot swap through staging, cache dir for the new version, older versions pruned by the store | config sections, snapshot dir, cache dir |
| OMP | `~/.omp/plugins/installed_plugins.json`, `omp-plugins.lock.json`, `~/.omp/plugins/cache/plugins/omp-reviewer-kit___omp-reviewer-kit___<version>` | new cache dir, lock version, registry timestamps | lock entry, registry entry, cache dir; `node_modules/omp-reviewer-kit` for the legacy form |
| OpenCode | `~/.config/opencode/opencode.json` (`plugin` array), `~/.cache/opencode/packages/<spec>/node_modules/omp-reviewer-kit`, copied components under `~/.config/opencode/` | new `packages/<spec>` dir for the new pin, rewritten copies | plugin array entry, package dir, copied components listed in `~/.config/opencode/.omp-reviewer-kit-manifest.json` |
| Consumer repositories | `.githooks/pre-commit` shim, `.omp/review-kit/run-review.mjs` | the pair when the kit is newer | nothing automatic: the pair is committed by the repository owner; removal is a documented manual step |
| Kit state | `~/.omp/review-kit-runs`, `~/.omp/review-kit-mutation`, `~/.omp/review-kit-cache/reuse`, `~/Documents/omp-reviewer-kit` | — | untouched by a host uninstall; the kit's new `--purge` flag deletes them |

The kit must never write outside these paths. `scripts/host-doctor.mjs` prints this table with the
resolved absolute paths for the current machine, so a removal can be verified line by line.

## 8. Failure modes and rollback

| Failure | Detection | Response |
|---|---|---|
| Two install modes for one name (OMP) | `omp plugin list --json` shows the name in both the npm and the marketplace arrays | installer refuses, prints both paths; §6 removes the conflict |
| Marketplace entry points at a local checkout | `omp plugin marketplace list` shows a path instead of `owner/repo` | migration row 2 |
| Version bump not picked up | `host-doctor` compares the installed version against `package.json` and the GitHub tag | prints the exact update command for that host |
| Interrupted install left a partial cache dir | the host's own list command reports a damaged plugin | re-run the host's install command; never delete cache dirs by hand |
| OpenCode entry present but module missing | `opencode debug paths` plus a session log line `Plugin … skipped` | installer re-copies and re-adds the entry |
| Uninstall leaves a broken commit hook in a consumer repository | `bridge.mjs doctor` reports the repository missing or stale | re-run `sync-targets --apply`; removing the kit from a repository is the owner's commit |

Rollback for a release: the previous version stays in the host cache until pruned or swept, so
re-pinning the marketplace entry and reinstalling returns to it. The kit never deletes a cache
directory.

## 9. Acceptance criteria

1. `node scripts/sync-host-manifests.mjs --check` exits 0, every generated manifest carries the
   `package.json` version, and a changed `package.json` without regeneration fails the release
   preflight.
2. On a clean profile each host installs from GitHub only — no step reads a local checkout.
3. Each host reports exactly one installed version, equal to the released tag.
4. A real commit in a scratch repository is blocked and then allowed on all four hosts through their
   own hook mechanisms.
5. Update: bump, regenerate, release, then run only the documented update command per host; the new
   version appears without deleting a cache directory.
6. Migration: a machine in today's state (OMP npm form plus a local-path marketplace) reaches the
   target state by §6 with no duplicate name and no local path.
7. Uninstall: after the documented commands `host-doctor` reports nothing for that host, and no path
   from §7 remains — proven by listing the paths before and after.
8. Idempotence: every install, migration and uninstall command run twice; the second run changes
   nothing and exits 0.
9. Kit state survives a host uninstall unless `--purge` is passed.

## 10. Open questions, each with the test that settles it

| # | Question | Test |
|---|---|---|
| **Q1 — ANSWERED** | Yes for the spec syntax, no for this package today: the git spec is fetched, then refused because `package.json` exposes no OpenCode entrypoint. Adding `exports["./server"]` makes the same command install and patch the config. | §4.4 probes |
| Q2 | Does `claude plugin update` refresh the marketplace by itself on 2.1.219? | bump, publish, run only `claude plugin update`; the version either moves or the two-step is required |
| Q3 | Does an unpinned OpenCode `latest` ever refresh? | publish a newer version, restart with `--print-logs`, inspect the cached `package.json` |
| Q4 | Can an OpenCode plugin inject `agents`/`skills` through the `config` hook early enough for discovery? | plugin sets `config.skills.paths`; then `opencode debug skill` |
| **Q5 — ANSWERED** | Yes: Codex read this repository's `.claude-plugin/marketplace.json` with no native manifest present and resolved the plugin from it. | §4.2 probe |
| Q6 | Does OMP read `.claude-plugin/marketplace.json` when `.omp-plugin/marketplace.json` is absent? | same method with `omp plugin marketplace add` |

Each answer becomes a line in §4 before the feature is called done; an unanswered question stays here
and its host is documented as **unverified**, never assumed.

## 11. Out of scope

- Publishing to npm for OpenCode: the owner requires GitHub installs. npm is a fallback only if Q1
  fails, and then this spec records why.
- Windows installer or MSI packaging.
- Auto-update daemons: each host's own update command is the answer; the kit adds only `host-doctor`.
