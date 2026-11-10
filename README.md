# omp-reviewer-kit

[![review-kit](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fstgmt%2Fomp-reviewer-kit%2Fmain%2Faudit-reports%2Freview-badge.json)](audit-reports/review-badge.full.json)

Native Oh My Pi plugin for multi-stage, evidence-first code review of staged Git changes.

**Requirements:** Git; Bun 1.4.1 (the review runs on Bun); Node.js 22 or 24 (CI tests both); and the pinned OMP library `@oh-my-pi/pi-coding-agent` 18.12.5. If the library is not already installed alongside the plugin, the launcher prepares its locked dependencies automatically as described below. The review uses your own OMP configuration. The kit does not choose models.

## Names

- GitHub and plugin: `omp-reviewer-kit`
- Orchestrator agent: `reviewer-kit`
- Specialist agents: `review-context-scout`, `review-risk-hunter`, `review-finding-verifier`
- Review skills: `reality-first-review`, `multi-stage-review`
- OMP extension: `src/extension.mjs`

## What It Does

`omp-reviewer-kit` provides a fail-closed Git pre-commit hook. The review runs four stages, one native OMP task per stage, driven by the kit host: the host decides what runs, what is reused from the journal, and in which order. OMP still resolves every model.

```
Staged Diff (git diff --cached --binary --no-ext-diff --)
                    │
                    ▼
[Stage 1: Context Scout] (review-context-scout)
  - Maps blast radius, touched files, callers/consumers via LSP/grep, invariants, and tests.
  - Produces structured context and a coverage map. It does not emit findings.
                    │
                    ▼
[Stage 2: Risk Hunting] (review-risk-hunter, one per lane)
  - Profile `full`: correctness lane by default; add the security lane with OMP_REVIEW_KIT_LANES=correctness,security.
  - Profile `spec-docs`: content-risk lane only (secrets in text, doc-vs-code contradictions, dead links/steps).
  - Strict anti-noise rules: no comments, formatting, naming, or ungrounded advice.
                    │
                    ▼
[Stage 3: Adversarial Verification] (review-finding-verifier)
  - Defense attorney: assumes the author is correct until repository evidence disproves it.
  - Checks upstream protections, caller constraints and reachability; confirms or rejects each candidate.
                    │
                    ▼
[Stage 4: Synthesis] (reviewer-kit)
  - Reads the stage results the host supplies; writes coverage, confirmed findings and rejected summaries.
  - Ends the report with the verdict marker. It spawns nothing and re-runs nothing.
```

The hook lets the commit proceed only when the native host exits 0 and prints `review: PASS`. The reviewer's report must also end with exactly one solitary `REVIEW_RESULT=PASS` line. Any confirmed finding, a blocking coverage gap when the scout reports a runnable test harness, a missing or failed stage, an aborted task, a malformed marker, or an infrastructure error blocks the commit (exit 1). The review has no wall-clock cap.

A coverage gap blocks only when it carries `severity: "blocking"` with a concrete reachable `impact`, its file class is not `test`, its per-entry `test_harness` is `present`, and the scout reports a runnable harness. Advisory gaps, `test`-class files, harness-mismatched items and impact-free gaps are recorded under `### Notes` and never block. The verdict applies this filter deterministically from the staged file-class manifest, not only from the prompt.

### Review Profiles & Risk Lanes

- **`full` profile** (the diff contains executable code or tests): the complete 4-stage pipeline with test coverage mapping. Stage 2 runs the `correctness` lane by default; `OMP_REVIEW_KIT_LANES=correctness,security` adds the security lane.
- **`spec-docs` profile** (only documentation, specifications, agent or skill prompts, or configuration): a reduced review focused on the `content-risk` lane.
- `OMP_REVIEW_KIT_LANES` is a comma-separated allowlist over `correctness`, `security` and `content-risk`. An unknown token fails the review closed.

### Journal: reuse and resume

Every review is journaled under `<home>/.omp/review-kit-journal/<key>/` (`OMP_REVIEW_KIT_JOURNAL_DIR` overrides). The key is the repository identity, the index tree (`git write-tree`), the diff hash, the kit version, a digest of `agents/*.md`, and the stage configuration. A staged ignored file changes the tree, so junk cannot hide behind an older verdict.

- A finished verdict for the same key answers the next review in milliseconds: the model is not called and the stored report is reused.
- Each finished stage is written the moment it exists. A review killed by the caller's timeout continues from the first stage without a valid entry instead of starting over; the hook log says `review: stage <id> reused (journal)`.
- `OMP_REVIEW_KIT_JOURNAL=off` disables both. The journal never decides a verdict by itself: it replays what a review of these exact bytes already decided.

## Standard Installation (Recommended)

Install the plugin using the official Oh My Pi plugin manager:

### Option A: From GitHub directly

```bash
omp plugin install github:stgmt/omp-reviewer-kit
```

### Option B: Via OMP Marketplace

```bash
# Add the marketplace
omp plugin marketplace add stgmt/omp-reviewer-kit

# Install in project scope
omp plugin install omp-reviewer-kit@omp-reviewer-kit --scope project

# Or install globally in user scope
omp plugin install omp-reviewer-kit@omp-reviewer-kit --scope user
```

### Locked review dependencies

When the pinned OMP library is not already available, the first review uses Bun to install the plugin's locked dependencies into `~/.omp/review-kit-runtime/`, outside the reviewed repository. Installation scripts are disabled. Registry access is needed for the first installation; subsequent reviews reuse the completed cache without network access. If preparation fails, the review blocks instead of allowing the commit.

Developers working on a checkout can instead run `bun install --frozen-lockfile` in that checkout. `/omp-reviewer-kit:doctor` in Claude Code checks Bun and the library next to the plugin. If it cannot verify the library there, it warns rather than claiming the hoisted installation or runtime cache is ready; the review itself verifies or prepares the runtime.

### OpenCode

The OpenCode installer registers the GitHub release matching the installer's version and installs the OpenCode-specific agents, skills, and commands into the user configuration directory. Each release has a distinct cache key, so an upgrade cannot silently reuse the previous package. Use a published release checkout:

```sh
git clone https://github.com/stgmt/omp-reviewer-kit.git
node omp-reviewer-kit/scripts/host-install.mjs --host opencode --apply
```

Restart OpenCode after installation. `/review` invokes the same staged-change review used by the commit hook; `/setup` installs the hook in the current repository. `/doctor` checks the installation. `/audit-range` and `/slop` are read-only diagnostics, not commit gates. The review agents cannot run a shell or edit files; their bounded `review_git` tool reads the index and Git history.

The installer refuses to replace user-owned or edited files. A conflict is reported before the plugin configuration is changed; resolve the named paths and retry. To remove the installation without deleting edited files, run `node omp-reviewer-kit/scripts/host-install.mjs --host opencode --remove --apply`.

## Configuring the Hook via OMP Slash Commands

Once installed, manage the review hook inside your OMP session:

- `/reviewer-kit:setup`: configures the pre-commit review hook in the active Git repository (`core.hooksPath .githooks`).
- `/reviewer-kit:status`: shows the hook configuration, the effective hook that git runs, and runner integrity.
- `/reviewer-kit:doctor`: checks Node.js, Git, Bun, the OMP CLI and library versions, and hook integrity. It also lists registered repositories whose commits would go unreviewed.
- `/slop`: runs the standalone slop audit. It is not part of the commit gate.

The plugin also observes `session_start`: opening any Git repository in OMP installs the review hook in the background (manual `/reviewer-kit:setup` remains as fallback) and updates the OMP status bar (`reviewer-kit: active` or `reviewer-kit: unconfigured`).

### Coexisting with an existing `.githooks/pre-commit`

The installer never overwrites a foreign hook. If your repository already ships a `.githooks/pre-commit`, adopt the review stage by adding one bare invocation line to that hook:

```sh
"$hook_dir/pre-commit.d/00-omp-reviewer-kit.chain"
```

The line must invoke exactly that entry name, with no arguments, no `&&`/`;` chaining, and no other `*.chain` basename. A hook that enumerates the directory (`for h in "$hook_dir/pre-commit.d"/*.chain; do "$h"; done`) is also adopted, since it picks up the entry once deployed.

When `session_start` or `/reviewer-kit:setup` sees either shape, it deploys the owned chain entry `.githooks/pre-commit.d/00-omp-reviewer-kit.chain` (which runs the review runner) and repairs it on drift. The foreign hook file stays byte-identical. A foreign hook that calls a different entry name, or has no chain marker at all, still reports `conflict` and is left untouched.

## Standalone / CI Installation (Fallback)

For CI environments or machines without an interactive OMP shell, standalone scripts remain available:

```powershell
pwsh ./scripts/install-hook.ps1 -Repository E:/repos/your-project
```

Or on POSIX systems:

```sh
./scripts/install-hook.sh /path/to/your-project
```

## Reports

Every review writes an immutable report outside the repository, in your Documents folder:

```text
~/Documents/omp-reviewer-kit/<repository folder name>/<timestamp>-<diff-hash>.md
```

The repository folder name is the directory name plus a 12-character hash of the absolute path, so checkouts that share a directory name never share a folder. `OMP_REVIEW_KIT_REPORTS_DIR` moves the root. The host prints the path on its own line as `review: report <path>`.

The report starts with `# reviewer-kit review: PASS` or `# reviewer-kit review: BLOCK` and records:

- The staged diff hash and the review timestamp
- Review coverage, the confirmed findings, the required test coverage, and the unproven or rejected candidates with their defense
- Notes and the verified-OK items
- The machine-readable verdict marker (`REVIEW_RESULT=PASS` or `REVIEW_RESULT=BLOCK`)

## How the Review Runs

The Node launcher (`scripts/run-review.mjs`) checks that Bun and the pinned library are present, then starts the Bun host (`src/native/native-host.mjs`) on the staged repository. The host:

1. Exports the staged index into a temporary snapshot and writes the review inputs (`.review/diff.patch`, `.review/changed-files.txt`, `.review/file-classes.json`). Agents read the diff from there, never through `git diff`.
2. Calls OMP's native `TaskTool` once with `agent: reviewer-kit` and the assignment (profile, lanes, changed paths, snapshot directory). OMP resolves the agent, its `task` model role, the owner's overrides, credentials, effort, eligibility and fallback.
3. Accepts the review only when the reviewer task completed successfully, yielded one Markdown report, and every mandatory stage completed. The mandatory stages are the scout, a hunter per lane, and the verifier for the `full` profile.
4. Writes the report and exits 0 for PASS or 1 for BLOCK. A missing or ambiguous native result is BLOCK.

The kit adds no model call of its own: no preflight, no dispatcher, no re-emit, no whole-review retry. The reviewer's `yield` is the only way the report leaves the agent.

## Claude Code Plugin and Target Sync

The Claude Code plugin is a thin shell over the OMP plugin (the review always runs on OMP): `/plugin marketplace add stgmt/omp-reviewer-kit`, `/plugin install omp-reviewer-kit`, then `/omp-reviewer-kit:install-omp` (checks what is installed, shows the plan, and installs OMP and the OMP plugin only after your confirmation), `/omp-reviewer-kit:setup` for the current repository, and `/omp-reviewer-kit:review` before committing. `/omp-reviewer-kit:doctor` diagnoses the setup. Exit codes of `/review`: 0 PASS, 1 BLOCK or review failure, 2 when OMP or the OMP plugin is missing. Installing the OMP plugin does not install the Claude plugin; removing the Claude plugin does not remove a repository's hook.

A repository has exactly one git hook and one vendored runner (`.omp/review-kit/run-review.mjs`). The vendored runner is a thin stub: the same few lines in every repository, never edited. It finds the installed OMP plugin (`OMP_REVIEW_KIT_PLUGIN_DIR`, else `~/.omp/plugins/node_modules/omp-reviewer-kit`), runs that plugin's `scripts/run-review.mjs` with the same arguments, and forwards the exit code. Without a plugin it fails closed with `reviewer-kit INFRA_ERROR`. The review algorithm therefore lives only in the installed plugin, so a plugin update changes every repository's review without touching a repository file. The hook and the stub are written only by the OMP plugin's installer, and an installed runner whose version marker is newer than the installer's is never replaced. To roll a new runner out to several repositories, run `node scripts/sync-targets.mjs` (dry run) or with `--apply`, then commit each repository through its own hook.

When the staged `.omp/review-kit/run-review.mjs` is byte-identical (line endings aside) to the plugin's `templates/review-kit/run-review.mjs`, or the staged `.githooks/pre-commit` to the plugin's `templates/githooks/pre-commit`, the review leaves that file out of the reviewed diff. A commit whose only staged changes are such files is skipped (`review: SKIPPED (no staged changes)`). A hand-edited copy, a runner that still holds an older algorithm, or any doubt (no installed plugin, unreadable blob) keeps the file in review.

**Hook ownership.** The hook template's second line carries a marker, `# omp-reviewer-kit hook v<version> body-sha256:<digest>`, whose digest covers every other line. A hook whose body still matches its marker is the kit's own, whatever release wrote it, so a plugin update replaces an older kit hook without anyone listing past versions. A hook whose body was edited under an unchanged marker is a conflict and is left alone. A hook from a newer release is never downgraded. Maintainers run `node scripts/stamp-hook.mjs` after every edit of `templates/githooks/pre-commit`; `npm run check` fails until the marker matches the body and the package version. In the kit repository itself the hook runs `scripts/run-review.mjs` directly.

**Automatic propagation.** Setting up the hook remembers the repository as a small file in `~/.omp/review-kit-targets.json.d/`, next to the owner-edited `~/.omp/review-kit-targets.json` (`OMP_REVIEW_KIT_TARGETS` overrides the path; both are read, so a hand-written list of repositories works too). Whenever a session starts, in OMP or in Claude Code, every registered repository whose hook or runner is stale is repaired, so a plugin update reaches all of them. Repositories without the hook, with a foreign hook, or with a newer runner are left alone. `tp-*` and the release checkout are never registered. `OMP_REVIEW_KIT_AUTO_SYNC=0` switches the automatic repair off. Repairing rewrites only the two vendored files; a repository that tracks them commits the change through its own hook.

**Commits that skip the review.** `.githooks` protects a checkout only while git runs it, and another tool can silently point `core.hooksPath` somewhere else. Claude Code Agent Teams writes `<repo>/.git/hooks` into the shared config when it creates a worktree, after which `git commit` runs no review at all. The kit defends against that in four ways:

- A `core.hooksPath` that names git's own default hooks directory, while that directory holds no real hook, is treated as a stray value rather than another tool's choice. Setup, the session start and `sync-targets --apply` put `.githooks` back (in `config.worktree` when the value lives there). Real hooks in that directory, or another hook system such as `.husky`, stay a conflict and are never rewritten.
- Setup stores a small shim in `<git common dir>/hooks/pre-commit` that runs the checkout's own `.githooks/pre-commit`, so even a stray value still reaches the review. The shim never replaces another tool's hook, is not written through a symlinked hooks directory, and its marker versions the shim format, not the release.
- Before an agent runs `git commit` (OMP extension `tool_call`, Claude Code PreToolUse hook on Bash), the guard checks which hook git would run. If it is the kit's, nothing happens. If not, it repairs the checkout and says so, or refuses the commit with the reason and the one-line fix. `OMP_REVIEW_KIT_AUTO_SYNC=0` turns the repair off (the guard then only refuses); `OMP_REVIEW_KIT_GUARD=0` turns the guard off. Only repositories that carry the kit's own `.githooks/pre-commit` are guarded.
- `/reviewer-kit:status` prints the effective hook, `/reviewer-kit:doctor` fails when commits here are not reviewed and lists registered repositories that would commit unreviewed, `sync-targets` marks them `NOT-REVIEWED`, and a Claude Code session start warns.

## Models

OMP owns model choice. Configure the `task` role, its fallbacks, and any `task.agentModelOverrides` in `~/.omp/agent/config.yml`. The kit does not read those settings to plan a route, does not pin a model, and does not copy `task` into another role. Its own review agents declare `model: "@task"`, so they use whatever the `task` role resolves to. Note that `agentModelOverrides` silently override an agent's `model:` frontmatter. Provider retry, cooldown and fallback are OMP's; the kit does not add a retry layer.

## Run Records and Live Progress

A review writes one machine-readable record per run outside every repository: `<home>/.omp/review-kit-runs/<runId>.json` (`OMP_REVIEW_KIT_RUNS_DIR` overrides the folder). The record carries the start and finish time, the wall-clock duration, the phases (snapshot, native task, verdict, report), the settled verdict and one entry per stage with its duration, tokens, requests, resolved model and the counts of what it reported. It never carries the reviewer's report, a prompt, a file body or a finding's text, and nothing in it can change a verdict or an exit code: a record that cannot be written is reported once and ignored.

The hook prints the same observation as it happens. `review: run <id> started` comes first, a `review: stage <agent> … <status> (<duration>, <tokens> tok, <requests> req)` line follows every finished stage, and `review: run <id> <state> <duration>` closes the review. `OMP_REVIEW_KIT_PROGRESS=0` silences the live stage lines, so CI logs stay small; the start and summary lines remain.

```sh
node scripts/review-runs.mjs                 # the last 10 runs of this machine
node scripts/review-runs.mjs --all --json
node scripts/review-runs.mjs --repo . --last
node scripts/review-runs.mjs --run <runId>   # one record in full
node scripts/review-runs.mjs --follow <runId>  # watch a running review until it settles
```

The command is read-only: it never writes a record, never stops a review and exits 1 when nothing matches. Inside OMP, `/reviewer-kit:runs` lists the runs of the current repository, and `/reviewer-kit:status` adds the last run's verdict and duration. Records are pruned on the next run: the newest 200 and anything from the last 30 days stay, a run that is still alive is never deleted, and a record of another schema is ignored rather than migrated.

## Removed in 0.22.0

The native rewrite removed the earlier pipeline and its settings. Do not expect these:

- The model dispatcher, the model preflight, the `task`-to-`default` chain overlay and its reader, the model re-emit, and provider-driven whole-review reruns.
- `OMP_REVIEW_KIT_MODEL`, `OMP_REVIEW_KIT_FALLBACK_MODELS`, `OMP_REVIEW_KIT_MAX_FALLBACKS`, `OMP_REVIEW_KIT_TASK_CHAIN`, `OMP_REVIEW_KIT_PREFLIGHT_TIMEOUT_MS`, `OMP_REVIEW_KIT_REEMIT`, `OMP_REVIEW_KIT_EFFORT`, `OMP_REVIEW_KIT_MAX_TIME` and the other model and chain settings (`audit-range --llm` is the one exception; see below).
- The verdict cache, delta rounds, the context pack, hunter shards, scout baseline and the scout scope planner, the batch gate and its retries, the rejection envelope, the superseded-run stop, and pre-review check execution (`OMP_REVIEW_KIT_EXECUTE`, `OMP_REVIEW_KIT_RED_PROOF`). The old run telemetry and its progress commands went with the pipeline; the native review now keeps its own much smaller record (see Run Records and Live Progress).
- `OMP_REVIEW_KIT_CACHE`, `OMP_REVIEW_KIT_ROUNDS`, `OMP_REVIEW_KIT_SHARD_BYTES`, `OMP_REVIEW_KIT_SCOUT_MAX_FILES`, `OMP_REVIEW_KIT_SCOUT_MAX_BYTES`, `OMP_REVIEW_KIT_TELEMETRY`, `OMP_REVIEW_KIT_SKILLS` and the others that configured them.

Node 18 and 20 are no longer in CI, because the suite now loads the Bun library.

## Environment

| Variable | Effect |
|---|---|
| `OMP_REVIEW_KIT_BUN` | Explicit Bun executable used by the launcher. Otherwise it searches `PATH`, then on Windows tries `%USERPROFILE%\.bun\bin\bun.exe` if Bun is not found. |
| `OMP_REVIEW_KIT_JOURNAL` | `off` disables verdict reuse and stage resume; any other value keeps the default `read-write`. |
| `OMP_REVIEW_KIT_JOURNAL_DIR` | Where journals live (default `<home>/.omp/review-kit-journal`). |
| `OMP_REVIEW_KIT_OMP` | The OMP executable used by the installer and the Claude shell (default `omp`). |
| `OMP_REVIEW_KIT_PLUGIN_DIR` | The installed plugin directory the vendored stub runs. |
| `OMP_REVIEW_KIT_PLUGIN_SPEC` | The plugin specifier the Claude shell installs (default `github:stgmt/omp-reviewer-kit#v<version>`). |
| `OMP_REVIEW_KIT_REPORTS_DIR` | The report root (default `~/Documents/omp-reviewer-kit`). |
| `OMP_REVIEW_KIT_RUNS_DIR` | The run-record root (default `~/.omp/review-kit-runs`). |
| `OMP_REVIEW_KIT_PROGRESS=0` | Silences the live stage lines of the hook; the start and summary lines stay. |
| `OMP_REVIEW_KIT_LANES` | The risk-lane allowlist for stage 2 (see Review Profiles). |
| `OMP_REVIEW_KIT_TARGETS` | The owner-edited target registry file. |
| `OMP_REVIEW_KIT_AUTO_SYNC=0` | Turns off the automatic repair of registered repositories. |
| `OMP_REVIEW_KIT_GUARD=0` | Turns off the commit-time hook guard. |

## Commit-Range Audit CLI

Audit an entire commit range for stealth test weakening, deleted assertions, vacuous checks and neuroslop:

```sh
node scripts/audit-range.mjs <base>..<head>
node scripts/audit-range.mjs <base>..<head> --json
node scripts/audit-range.mjs <base>..<head> --out report.md
node scripts/audit-range.mjs <base>..<head> --llm
```

The CLI runs a deterministic pass across each commit using `SuspicionMap`, aggregates net assert deltas and deleted test files, and optionally invokes the native `review-range-auditor` agent (`--llm`) to adversarially challenge the change history under `skill://range-audit`. The `--llm` run passes no model flag and runs on OMP's default role; the review gate's child runs on the `@task` role.

## Development & Testing

```sh
bun install --frozen-lockfile   # the pinned OMP library
npm test                        # node:test suites under tests/
npm run test:mutation           # the safety mutation gate (every curated mutant must be killed)
npm run check                   # layout integrity and runner drift
```

### Mutation gate execution

The development mutation gate requires Node 22 or newer. It uses four asynchronous workers by default (`OMP_MUTATION_WORKERS` overrides the count for diagnostics). Each worker owns one reusable project copy; the runner restores and verifies every file, mode and path before reuse. Timing-sensitive and process-tree suites run exclusively after the parallel jobs drain.

`scripts/mutation-selectors.json` maps every curated mutant to a calibrated deciding test. An ordinary run verifies its green baseline and then requires an assertion failure from the selected test. A timeout, a process, import or reporter failure, a missing test, or an incomplete catalog blocks the gate rather than counting as a kill. `node scripts/run-mutation-tests.mjs --calibrate-stale` recalibrates only the mutants whose selector no longer fits, keeps proven selectors when part of a run fails, and then runs the ordinary gate over every mutant. Its exit code is always the verdict of the full gate.

### Contract reconciliation

Before any model reads the diff, the review settles the producer/consumer pairs the changed modules contain: an exported `write*/serialize*/encode*/toJSON*` function is called with the arguments its own signature requires (parameters with defaults are left to the writer), and the record it produces is handed to the exported `read*/parse*/decode*/fromJSON*/validate*` function in a child process. A reader that throws on that record blocks the commit and names the file, both functions, the thrown error and the record. Everything else is reported as unproven: `no-pairs` when the diff holds no such pair, `partial` when a pair could not be called (an unknown parameter domain, a reader that needs context, an unparsable module, a path beyond the scan budget), `failed` when the probe itself broke. `OMP_REVIEW_KIT_CONTRACT=off|advisory|block` — default `advisory`: the throw is always reported, and blocking is opted into.

### Delivering an update

One command moves every host to the current release: `node scripts/deliver.mjs`. It upgrades the OMP marketplace entry, updates the Claude Code plugin, and reports whether the shipped hook still names only the hook *format*.

Repositories are not part of it on purpose. Their `.githooks/pre-commit` carries `hook-format v1` and the digest of its own body — never the release version — so a new release leaves the file byte-identical and no repository is rewritten. The review itself always runs from the installed plugin, which is what the release actually replaces. `scripts/sync-targets.mjs` therefore writes a hook once, for a repository that has none or one from before formats existed, and has nothing to do afterwards.

### When the gate runs

The gate proves the catalog for one state of the bytes, so it runs once per release, on the frozen diff, after the review passed — `node scripts/release-preflight.mjs --require-frozen --recalibrate`. A review round with open findings is not a reason to recalibrate: the diff is about to change.

A passed run stores a certificate in `<home>/.omp/review-kit-mutation/<digest>.json` (`OMP_REVIEW_KIT_MUTATION_CERT_DIR` overrides), keyed by a content hash of the whole working tree plus the gate fingerprint (targets, deciding tests, catalog and the curated definitions), and scoped to the Node version and platform it was measured on. A second preflight on the same bytes prints `mutation certificate - N/N mutants proved …` and runs nothing; any edit anywhere changes the digest and the gate runs again. The certificate only ever skips a repeat run: it cannot turn a failure into a pass, and a failed write leaves the next preflight to run the gate.

The gate is local-only. GitHub Actions does not run it, because a runner cannot see the local certificate and would repeat the whole catalog.

### Live check

The live case of the hook suite runs a real `git commit` through the installed hook with the owner's OMP configuration and spends model budget. It is opt-in:

```sh
OMP_REVIEW_KIT_LIVE_E2E=1 node --test --test-reporter=spec tests/e2e-native-hook.test.mjs > live-e2e.log 2>&1
```
