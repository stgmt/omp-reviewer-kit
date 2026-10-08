# Repository Guidelines

## Project Overview

`omp-reviewer-kit` is an OMP plugin for evidence-first review of staged Git changes. It coordinates a native 4-stage hierarchy: an orchestrator agent (`reviewer-kit`), specialist subagents (`review-context-scout`, `review-risk-hunter`, `review-finding-verifier`), review skills (`reality-first-review`, `multi-stage-review`), a fail-closed pre-commit runner, and an OMP extension module (`src/extension.mjs`). A commit proceeds only when OMP emits exactly one `REVIEW_RESULT=PASS`; every review is recorded under `audit-reports/commit-reviews/`.

## Architecture & Data Flow

1. **Standard Plugin Discovery**: When installed via `omp plugin install`, OMP automatically discovers:
   - Agent definitions: `agents/reviewer-kit.md`, `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`.
   - Review skills: `skills/reality-first-review/SKILL.md`, `skills/multi-stage-review/SKILL.md`.
   - Native extension: `src/extension.mjs`.
2. **In-Session Setup & Status**: The extension registers native slash commands:
   - `/reviewer-kit:setup`: configures the Git pre-commit hook in the active project (`core.hooksPath .githooks`).
   - `/reviewer-kit:status`: reports active repository hook status and latest review verdict.
   - `/reviewer-kit:doctor`: checks Node.js, Git, OMP CLI, and hook integrity.
   - `session_start` lifecycle hook: provides transparent status bar state (`reviewer-kit: active` / `unconfigured`), registers the repository in the target registry (`FileTargetRegistry`: one file per repository in `<registry file>.d/` so concurrent sessions never rewrite shared state, plus the owner-edited `~/.omp/review-kit-targets.json` or `OMP_REVIEW_KIT_TARGETS` that is only read; `src/domain/target-policy.mjs` keeps `tp-*` and the release checkout out, `PluginInstallerService.registerTarget`) and heals every other registered repository whose hook or runner is stale (`healTargets`, state `stale` only, never a downgrade, copy-only, time-budgeted, `OMP_REVIEW_KIT_AUTO_SYNC=0` disables). The Claude Code SessionStart hook calls `refreshAtSessionStart` from the installed plugin for the same effect and repairs the current repository instead of only reporting it. `/reviewer-kit:doctor` reports stale registered repositories.
3. **Pre-Commit Multi-Stage Review Flow**:
   - `.githooks/pre-commit` resolves repository root and executes `.omp/review-kit/run-review.mjs` with Node.js, the thin stub that runs the installed plugin's `scripts/run-review.mjs`. In the kit repository (`package.json` name `omp-reviewer-kit`) it executes `scripts/run-review.mjs` directly, so the stub under `.omp/review-kit/` is never run there.
   - Hook ownership: line 2 of `templates/githooks/pre-commit` is `# omp-reviewer-kit hook v<version> body-sha256:<digest>`, the digest covering every other line (`src/domain/hook-template.mjs`). A hook whose marker matches its body is the kit's own from any release, so an update replaces it without a version list; an edited body under an unchanged marker is a conflict; a hook from a newer release is never downgraded. Hooks written before markers existed are recognised only through the frozen `LEGACY_HOOK_DIGESTS` in `src/application/installer-service.mjs`; never add to that list. Run `node scripts/stamp-hook.mjs` after every edit of the template: `scripts/check-layout.mjs` (and `npm run check`) fails while the marker does not match the body or the package version.
   - The runner queries `GitPort` (`SubprocessGitAdapter`) for `git diff --cached --binary --no-ext-diff --`. Empty staged changes exit with code 0 immediately without invoking OMP.
   - `DiffIdentity` computes deterministic SHA-256 hash of the binary diff.
   - Before any snapshot or reviewer call, `VerdictCachePort` (`FileSystemVerdictCacheAdapter`, `audit-reports/commit-reviews/verdict-cache.jsonl`) is consulted by (`git write-tree` index tree, diff hash): an identical earlier PASS whose report still exists inside the repository with the same hash and `result: PASS` (max 14 days) short-circuits to PASS (`verdict_cache_hit`). BLOCK is never cached; `OMP_REVIEW_KIT_CACHE=0` disables it. A BLOCK whose envelope is missing or malformed gets one verbatim re-emit that is accepted only if it is again a BLOCK with a valid non-failure envelope.
   - Vendored kit files: `SubprocessGitAdapter` (given `vendoredFiles`, the runner passes `loadCanonicalVendoredFiles` from `src/infra/vendored-kit-files.mjs`) drops the staged `.omp/review-kit/run-review.mjs` and `.githooks/pre-commit` from the review diff via `:(exclude,literal)` pathspecs only when their staged bytes equal (CRLF-normalised) the installed OMP plugin's `templates/review-kit/run-review.mjs` (the stub) / `templates/githooks/pre-commit`; no installed plugin, a loader failure, or different bytes keeps them in review. A diff left empty is skipped.
   - Review speed (0.18.0): the runner writes a deterministic scout context pack (`src/domain/context-pack.mjs`; changed files, changed symbols with references across the snapshot, test-file mapping) to `reviewer-kit-report-ctx-<run>-<pid>.md` in the temp dir (outside the snapshot, removed with the run) and names it in the prompt; the adapter reads the scout's result artifact into a `ScoutBaseline` (`src/domain/scout-baseline.mjs`) that the round record carries so the next round's scout keeps unchanged `coverage_map` entries; diffs above `OMP_REVIEW_KIT_SHARD_BYTES` (default 40000, `0` off, `OMP_REVIEW_KIT_MAX_SHARDS` default 3) get a `HUNTER SHARDS` block (`src/domain/hunter-shards.mjs`, source files grouped with their tests) so the correctness hunter runs per shard in parallel; each attempt records `stage_stats` from `src/infra/stage-transcript-stats.mjs`; the kit repository has no runner mirror: its `.omp/review-kit/run-review.mjs` is the stub, which the vendored-file exemption leaves out of the diff as in any repository.
   - Delta rounds: `RoundStorePort` (`FileSystemRoundStoreAdapter`, `audit-reports/commit-reviews/last-block.json`) keeps the last BLOCK with confirmed findings or coverage gaps (findings plus diff text, 12h TTL). The next review of a different diff gets a `PREVIOUS ROUND` prompt block (`ReviewRound`): previous findings, the files with lines added since, and round rules (verifier decides fixed/still-present for each previous finding; new P2 only inside the delta; new P1 anywhere). PASS clears it, review_failure leaves it; `OMP_REVIEW_KIT_ROUNDS=0` disables it.
   - `ReviewPrompt` carrying the diff hash invokes `ReviewerPort` (`OmpCliReviewerAdapter`) headlessly via `omp -p --session-dir <per-attempt temp dir>` (the task tool persists each task's full result as a session artifact; the runner reads it back via `recoverTaskReport` when the dispatcher stdout lacks a verdict marker or carries an `execution_failure` envelope, telemetry `report_artifact_recovered`; the per-run report path is also exported as `OMP_REVIEW_KIT_REPORT_PATH` for project guards, see README) with no model flags: OMP resolves the user's own default role and `retry.fallbackChains` (the path is overridable via `OMP_REVIEW_KIT_OMP`). A short model-less preflight call (`OMP_REVIEW_KIT_PREFLIGHT_TIMEOUT_MS`, default 90,000ms) runs first; if OMP cannot reach a model the commit is BLOCKed within seconds with an infrastructure-failure message pointing at the OMP configuration. The plugin never kills the review child on a timer; `OMP_REVIEW_KIT_MAX_TIME` is an opt-in child-side bound via `omp --max-time` (default off), and a hard child crash (Windows `0xC0000409`/`-1`) with no output is re-run once. Max-time hits are flagged `timedOut` (exit-0-with-empty-stdout at ~the bound) and flow through the existing missing-marker path fail-closed.
   - The staged snapshot also carries the review inputs under `<snapshot>/.review/`: `diff.patch` (the complete staged diff, byte-exact from `DiffIdentity.bytes`) and `changed-files.txt` (the changed-file manifest parsed from `diff --git` headers). Agents read the diff from these files instead of running `git diff`/`git show`; a staged path under `.review/` fails loudly as a reserved-directory collision.
   - OMP launches `reviewer-kit` (orchestrator), which executes the 4-stage protocol strictly in sequence:
     1. **Stage 1 (Scout)**: Spawns `review-context-scout` (inherits the OMP default model role) to map diff scope, touched paths, callers via LSP/grep, invariants, tests, and the `coverage_map` of changed executable behaviors to their covering tests.
     2. **Stage 2 (Parallel Risk Hunters)**: Spawns batch `task` with one `review-risk-hunter` (inherits the OMP default model role) agent per lane named by `OMP_REVIEW_KIT_LANES` (default `correctness` only for `full`, `content-risk` for `spec-docs`; `OMP_REVIEW_KIT_LANES=correctness,security` restores the security lane), generating candidate defects under strict anti-noise rules; the correctness lane also emits `coverage_gaps` for every `coverage_map` entry without a covering test, each carrying concrete required edge and mutation tests.
     3. **Stage 3 (Adversarial Verifier)**: Spawns `review-finding-verifier` (inherits the OMP default model role) acting as the author's defense lawyer, verifying upstream protections and reachability to confirm or reject candidates, and verifying each coverage gap is real (not already covered, changed executable behavior, reachable) into `confirmed_coverage_gaps`.
     4. **Stage 4 (Synthesis & Verdict)**: `reviewer-kit` synthesizes coverage, compiles confirmed findings, and emits the final report.
   - Output is parsed into `ReviewVerdict`. Invariant: only an exact solitary `REVIEW_RESULT=PASS` yields approval; any confirmed `P1`/`P2`, confirmed coverage gap (changed executable behavior without a covering test while a runnable test harness exists), missing stage, malformed marker, or non-zero exit strictly yields `BLOCK`. A coverage-only BLOCK emits a `coverage_required` envelope whose `coverage_items` name the concrete edge and mutation tests the committer must add.
   - `ReviewReport` formats the markdown audit trail, which `ReportStorePort` (`FileSystemReportStoreAdapter`) writes to `audit-reports/commit-reviews/<timestamp>-<hash>.md`.
   - `TelemetryPort` (`FileSystemTelemetryAdapter`) records the run trace to `audit-reports/commit-reviews/runs.jsonl` (append-only `review-run-event@1` events: `run_started`, `diff_collected`, `snapshot_materialized`, `review_attempt_started/finished` with child PID, `preflight_started/finished`, `verdict_evaluated`, `report_written`, `run_finished`, `run_skipped`, `run_failed`) and maintains `audit-reports/commit-reviews/last-run.json` (`review-last-run@1`) as the live status channel, updated ~every 2s during active attempts. Telemetry failures are swallowed and never change the verdict; `OMP_REVIEW_KIT_TELEMETRY=0` disables it. Each run also writes one record, `~/.omp/review-kit-runs/<runId>.json` (`review-run-record@1`; `OMP_REVIEW_KIT_RUNS_DIR` overrides the directory), holding its state, stage, PIDs, timestamps, diff hash, excluded vendored paths, `parentSha`, verdict, report path and session tag (`OMP_REVIEW_KIT_RUN_TAG`). `scripts/review-progress.mjs` reads these records, and `--commit` matches a commit to its run through `parentSha` and the diff hash. When a new run starts, records older than seven days that are finished or whose runner is dead are pruned. `countOtherLiveRuns` counts the live runs of the same repository (runner alive, not finished), and `ReviewWorkflowService.#announceRun` prints the run id, the follow command and that count on stderr once a non-empty diff starts a review. The extension polls `last-run.json` while a `git commit` tool call is active and `/reviewer-kit:status` surfaces it via `installer.status().lastRun`.
   - `ReviewWorkflowService` outputs verdict to stdout/stderr and sets exit code 0 on PASS or 1 on BLOCK.

`scripts/run-review.mjs` is the algorithm: the self-contained distributable runner, installed with the plugin. `templates/review-kit/run-review.mjs` is the thin stub that every repository vendors as `.omp/review-kit/run-review.mjs`; it runs the installed plugin's `scripts/run-review.mjs` with the same arguments and forwards the exit code. `scripts/check-layout.mjs` enforces that the vendored copy in this repository is byte-identical to the stub and that the algorithm carries its version marker. `src/` provides modular OOP and DDD exports (`DiffIdentity`, `ReviewVerdict`, `ReviewPrompt`, `ReviewReport`, `ReviewExecutionResult`, `PluginInstallerService`, ports, adapters, telemetry adapters, and `ReviewWorkflowService`).

`scripts/analyze-review-run.mjs` (`npm run analyze-review`) correlates `runs.jsonl` with OMP process logs (`~/.omp/logs/omp.<date>.<pid>.log`) by child PID — or by time window when `OMP_REVIEW_KIT_OMP` is a `.cmd` wrapper — and reports per-attempt timings, request counts, context growth, per-stage subagent timing (dispatch `Configured subagent …` → finish `subagent launch timing`; `Session exit recorded` is deferred cleanup, not stage duration), per-agent model/thinking/message spans from `%TEMP%/omp-task-*` transcripts, and provider-error classes. `.devin/skills/omp-review-incidents/SKILL.md` documents the incident-investigation playbook.

## Key Directories

- `src/`: domain models, ports, application services (`installer-service.mjs`, `review-workflow-service.mjs`), infrastructure adapters, and native extension entry point (`extension.mjs`).
- `agents/`: OMP agent definitions (`agents/reviewer-kit.md`, `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`).
- `skills/`: reusable review methodology and protocol (`skills/reality-first-review/SKILL.md`, `skills/multi-stage-review/SKILL.md`).
- `scripts/`: runner (`run-review.mjs`), mutation gate (`run-mutation-tests.mjs`), integrity check (`check-layout.mjs`), and fallback Windows/POSIX installers (`install-hook.ps1`, `install-hook.sh`).
- `templates/githooks/`: pre-commit hook copied into target repositories (stamped with its marker by `scripts/stamp-hook.mjs`).
- `templates/review-kit/`: the thin runner stub, vendored into every repository as `.omp/review-kit/run-review.mjs`. It is never edited.
- `.omp/review-kit/`: this repository's vendored copy of the stub, which its pre-commit hook invokes.
- `.omp-plugin/`: marketplace plugin catalog metadata.
- `claude-plugin/`: the Claude Code shell (manifest, SessionStart hook, four commands, `scripts/bridge.mjs`); `.claude-plugin/marketplace.json` points at it. Its only skill is `skills/review-progress/SKILL.md`, a usage note for the read-only reader `scripts/review-progress.mjs` (shipped in the OMP plugin and reached through `scripts/bridge.mjs progress`); it contains no runner, installer, or agents. `npm run check` enforces the exact file set and a size cap. Invariant: the git hook and `.omp/review-kit/run-review.mjs` are written only by `PluginInstallerService` (reached through the OMP plugin), and a runner with a newer `// omp-reviewer-kit runner vX.Y.Z` marker is never overwritten.
- `tests/`: flat native Node.js test suites (`*.test.mjs`), including contract, BDD, extension, marketplace, mutation, telemetry, and real Git hook E2E suites.
- `.devin/skills/`: repository skills, including `omp-review-incidents` (incident-investigation playbook).
- `.github/workflows/`: cross-platform CI automation (`ci.yml`).
- `audit-reports/`: architecture records (`audit-reports/multi-stage-review-architecture.md`), the observability domain spec (`audit-reports/review-observability-domain-spec.md`), and commit reviews plus run telemetry (`audit-reports/commit-reviews/`: `*.md` reports, `runs.jsonl`, `last-run.json`; the per-run records live outside the repository in `~/.omp/review-kit-runs/`).

## Development Commands

```sh
npm test                         # node scripts/run-tests.mjs (node --test tests/*.test.mjs, run records in a temp directory)
npm run test:mutation            # node scripts/run-mutation-tests.mjs
npm run check                    # node scripts/check-layout.mjs
node scripts/run-review.mjs      # review the current staged diff
```

Opt-in live OMP verification (requires local OMP executable). Run with the spec reporter for streaming progress, and capture output to a file instead of piping through `tail` so assertion failures keep the full OMP stdout/stderr:
```sh
OMP_REVIEW_KIT_LIVE_E2E=1 node --test --test-reporter=spec tests/live-e2e-omp.test.mjs > live-e2e.log 2>&1
```
Live checks 3/4 drive real `omp -p --model @slow` directly via `runLiveOmp` and assert on the raw stdout; `runLiveOmp` kills the whole process tree on timeout and rejects with stdout/stderr tails. The matrix cases exercise the full pre-commit hook path (runner + adapter + report) through the real Git hook.

Risk-lane configuration (optional): `OMP_REVIEW_KIT_LANES` is a comma-separated allowlist over `correctness|security|content-risk`; unset defaults to `correctness` only (`full` profile) / `content-risk` (`spec-docs`), `correctness,security` restores the classic two-lane stage 2, unknown tokens fail closed.

Model configuration: none. `OMP_REVIEW_KIT_MODEL`, `OMP_REVIEW_KIT_FALLBACK_MODELS`, `OMP_REVIEW_KIT_MAX_FALLBACKS`, `OMP_REVIEW_KIT_PROBE_TIMEOUT_MS`, `OMP_REVIEW_KIT_QUOTA_STALL_MS`, and `OMP_REVIEW_KIT_EFFORT` were removed in 0.14.0; models, roles, and fallbacks are configured only in OMP. `OMP_REVIEW_KIT_PREFLIGHT_TIMEOUT_MS` bounds the health call, `OMP_REVIEW_KIT_TELEMETRY=0` disables `runs.jsonl`, `last-run.json` and the per-run records. `OMP_REVIEW_KIT_RUNS_DIR` moves the per-run records, `OMP_REVIEW_KIT_RUN_TAG` tags a run with its Claude Code session, and `OMP_REVIEW_KIT_QUIET_MS` (default 600000) sets the silence after which a running review is shown as quiet; quiet reviews are reported and never stopped. Full reviews are never automatically cancelled by this plugin. `OMP_REVIEW_KIT_SKILLS` controls the skill catalog the review child lists via `omp --skills`: the plugin skills (`multi-stage-review`, `reality-first-review`, `range-audit`, `slop`) are always included so the orchestrator's autoloaded protocol skills resolve, the default extras are `*reviewer-kit*,*review-kit*`, a comma-separated list replaces the extras, `all` (any case, anywhere in the list) restores the full catalog, and an invalid list falls back to the default extras; the catalog is resent with every request of every stage, so a large autolearn skill store otherwise dominates request size. Note: `agentModelOverrides` in the user's `~/.omp/agent/config.yml` silently override agent frontmatter `model:` values and can defeat the intended fast chain.

Installation via standard OMP commands:

```bash
omp plugin install github:stgmt/omp-reviewer-kit
```

There is no build, lint, format, or typecheck command. Run `npm test`, `npm run test:mutation`, and `npm run check` after modifying source, agents, skills, templates, or metadata.

## Code Conventions & Common Patterns

- Use native ESM in `.mjs` files: `import`/`export`, `node:` built-ins, semicolons, two-space indentation, and `camelCase` functions/variables.
- Zero external runtime dependencies: standard Node.js built-in modules only (`node:crypto`, `node:fs/promises`, `node:child_process`, `node:path`, `node:url`, `node:os`).
- Apply OOP and DDD principles:
  - Domain invariants live in Value Objects (`DiffIdentity`, `ReviewVerdict`) and Entities (`ReviewReport`).
  - Application orchestration lives in `ReviewWorkflowService` and `PluginInstallerService`.
  - External capabilities are decoupled behind ports (`GitPort`, `ReviewerPort`, `ReportStorePort`) and adapters.
- Preserve fail-closed behavior: only one exact standalone `REVIEW_RESULT=PASS` line permits a commit; any ambiguity or failure must return `BLOCK` (exit code 1).
- Staged change isolation: review strictly targets `git diff --cached --binary --no-ext-diff --` and ignores unstaged worktree changes.
- Tool Permissions & Mutation Prohibitions:
  - None of the four review agents (`reviewer-kit`, `review-context-scout`, `review-risk-hunter`, `review-finding-verifier`) contain repository mutation tools (`edit`, `write`) or instructions that stage, reset, commit, checkout, or edit files.
  - OMP Tool Classification Note: The orchestrator `reviewer-kit` declares `task` in its tool list to spawn subagents. In `@oh-my-pi/pi-coding-agent` 17.3.7, `task` is classified as a general tool rather than an internal read-only tool because subagents can theoretically run any agent. However, `reviewer-kit` strictly restricts spawning via its frontmatter `spawns: review-context-scout, review-risk-hunter, review-finding-verifier` allowlist, and all three specialist subagents have only read-only inspection tools (`read, grep, glob, lsp, bash`) with no `task` or mutation capabilities.
- OMP skill discovery is authoritative: do not add manual directory scans for `.omp/skills` or create secondary registries.
- BDD testing: write tests using `node:test` and `node:assert/strict` with Given / When / Then structure and assert observable outputs and side effects.

## Important Files

- `src/index.mjs`: primary module export and composition root (`createReviewWorkflowService`).
- `src/extension.mjs`: native OMP extension registering `/reviewer-kit:*` slash commands and `session_start` handler.
- `src/application/installer-service.mjs`: hook installation and health check diagnostics.
- `scripts/run-review.mjs`: self-contained pre-commit runner and backward-compatible `runReview` facade.
- `scripts/analyze-review-run.mjs`: correlates `runs.jsonl` telemetry with OMP process logs by PID or time window (`npm run analyze-review`).
- `src/infra/review-run-records.mjs`: reads the per-run records and classifies runs as `active`, `quiet`, `orphaned` or `done`.
- `scripts/review-progress.mjs`: read-only progress CLI over the per-run records (`--mine`, `--all`, `--run`, `--follow`, `--commit`, `--json`).
- `src/infra/filesystem-telemetry-adapter.mjs`: `RunTelemetry` sink, `FileSystemTelemetryAdapter`, `NullTelemetryAdapter`, `safeRunTelemetry`, `formatProviderOutageError`.
- `scripts/run-mutation-tests.mjs`: dependency-free safety mutation test runner.
- `.omp/review-kit/run-review.mjs`: this repository's copy of the thin stub (identical to `templates/review-kit/run-review.mjs`).
- `agents/reviewer-kit.md`: orchestrator agent, spawns allowlist, and final verdict synthesis.
- `agents/review-context-scout.md`: context discovery specialist.
- `agents/review-risk-hunter.md`: correctness and security candidate defect specialist.
- `agents/review-finding-verifier.md`: adversarial defense and finding validation specialist.
- `skills/reality-first-review/SKILL.md`: 16 review rules, finding format, and skill-composition policy.
- `skills/multi-stage-review/SKILL.md`: multi-stage protocol, schemas, anti-noise rules, and report format.
- `ROADMAP.md`: engineering direction across development phases.
- `CHANGELOG.md`: release version history following Keep a Changelog.
- `.github/workflows/ci.yml`: GitHub Actions CI pipeline testing Ubuntu and Windows across Node 18, 20, and 22 plus mutation testing.
- `scripts/check-layout.mjs`: layout integrity gate and runner synchronization validator.
- `tests/bdd-scenarios.test.mjs`: executable BDD scenario suite.
- `tests/extension.test.mjs`: extension and installer service test suite.
- `tests/e2e-git-hook.test.mjs`: real Git pre-commit hook E2E integration suite.

## Runtime/Tooling Preferences

Use Node.js and npm scripts; this repository is not a Bun project. `package.json` specifies `"type": "module"` and `"engines": { "node": ">=18.0.0" }`. Zero npm dependencies and no lockfiles. Runtime review requires `git` and an `omp` executable in `PATH`, or configured via `OMP_REVIEW_KIT_OMP`.

Releases and deliveries (tag, release workflow, plugin reinstall, registry heal, tokenplan) follow the repository skill `.claude/skills/release-and-deliver/SKILL.md`. Read it before any release step.

## Testing & QA

Tests use the built-in Node.js test runner (`node:test`) and strict assertions (`node:assert/strict`). Test suites live directly under `tests/` named `*.test.mjs`. Coverage spans domain units, BDD scenarios, extension commands, mutation testing, and full Git pre-commit hook E2E runs. Before declaring work complete, run:

```sh
npm test
npm run test:mutation
npm run check
```
