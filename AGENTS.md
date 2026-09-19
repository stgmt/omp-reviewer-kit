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
   - `session_start` lifecycle hook: provides transparent status bar state (`reviewer-kit: active` / `unconfigured`).
3. **Pre-Commit Multi-Stage Review Flow**:
   - `.githooks/pre-commit` resolves repository root and executes `.omp/review-kit/run-review.mjs` with Node.js.
   - The runner queries `GitPort` (`SubprocessGitAdapter`) for `git diff --cached --binary --no-ext-diff --`. Empty staged changes exit with code 0 immediately without invoking OMP.
   - `DiffIdentity` computes deterministic SHA-256 hash of the binary diff.
   - `ReviewPrompt` carrying the diff hash invokes `ReviewerPort` (`OmpCliReviewerAdapter`) headlessly via `omp -p --model @smol --no-session` (overridable via `OMP_REVIEW_KIT_OMP`; the plugin itself never kills the child on a timer; the only automatic kill is the quota-stall watchdog: a provider refusal in stderr or the child OMP log plus no stdout for `OMP_REVIEW_KIT_QUOTA_STALL_MS` (default 300000, `0` disables) kills the tree and advances the outer chain with a fresh attempt. `OMP_REVIEW_KIT_MAX_TIME` is an opt-in child-side bound via `omp --max-time` (default off)). Provider quota, rate-limit, authentication, and model-capacity failures trigger the deterministic fallback chain `@smol → @task`: each fallback candidate is probed first with a bounded no-tools request (`OMP_REVIEW_KIT_PROBE_TIMEOUT_MS`, 60,000ms default) before it receives a full review attempt. `OMP_REVIEW_KIT_FALLBACK_MODELS` overrides the candidate list; `OMP_REVIEW_KIT_MAX_FALLBACKS` caps attempts (default 3); `OMP_REVIEW_KIT_EFFORT` rewrites the `:effort` suffix of every resolved selector (defaults to `low`) (probes and attempts). There is no automatic `omp models --json` catalog probing — fallback is a role selector resolving to the user's configured fast model. Successful candidates receive the same model through `--model` and `--slow`; attempts never retry a real verdict or a timeout. If every model is unavailable the commit is BLOCKed with an actionable infrastructure-failure message identifying the models attempted and how to repoint `modelRoles.smol`/`modelRoles.task`.  Stall kills are flagged `stalledOnQuota` and retry the outer chain; max-time hits are flagged `timedOut` (exit-0-with-empty-stdout at ~the bound) and flow through the existing missing-marker path fail-closed.
   - The staged snapshot also carries the review inputs under `<snapshot>/.review/`: `diff.patch` (the complete staged diff, byte-exact from `DiffIdentity.bytes`) and `changed-files.txt` (the changed-file manifest parsed from `diff --git` headers). Agents read the diff from these files instead of running `git diff`/`git show`; a staged path under `.review/` fails loudly as a reserved-directory collision.
   - OMP launches `reviewer-kit` (orchestrator), which executes the 4-stage protocol strictly in sequence:
     1. **Stage 1 (Scout)**: Spawns `review-context-scout` (model `@smol`, riding the pinned reviewer model) to map diff scope, touched paths, callers via LSP/grep, invariants, tests, and the `coverage_map` of changed executable behaviors to their covering tests.
     2. **Stage 2 (Parallel Risk Hunters)**: Spawns batch `task` with two `review-risk-hunter` (model `@slow`) agents in parallel (`lane: "correctness"` and `lane: "security"`), generating candidate defects under strict anti-noise rules; the correctness lane also emits `coverage_gaps` for every `coverage_map` entry without a covering test, each carrying concrete required edge and mutation tests.
     3. **Stage 3 (Adversarial Verifier)**: Spawns `review-finding-verifier` (model `@slow`) acting as the author's defense lawyer, verifying upstream protections and reachability to confirm or reject candidates, and verifying each coverage gap is real (not already covered, changed executable behavior, reachable) into `confirmed_coverage_gaps`.
     4. **Stage 4 (Synthesis & Verdict)**: `reviewer-kit` synthesizes coverage, compiles confirmed findings, and emits the final report.
   - Output is parsed into `ReviewVerdict`. Invariant: only an exact solitary `REVIEW_RESULT=PASS` yields approval; any confirmed `P1`/`P2`, confirmed coverage gap (changed executable behavior without a covering test while a runnable test harness exists), missing stage, malformed marker, or non-zero exit strictly yields `BLOCK`. A coverage-only BLOCK emits a `coverage_required` envelope whose `coverage_items` name the concrete edge and mutation tests the committer must add.
   - `ReviewReport` formats the markdown audit trail, which `ReportStorePort` (`FileSystemReportStoreAdapter`) writes to `audit-reports/commit-reviews/<timestamp>-<hash>.md`.
   - `TelemetryPort` (`FileSystemTelemetryAdapter`) records the run trace to `audit-reports/commit-reviews/runs.jsonl` (append-only `review-run-event@1` events: `run_started`, `diff_collected`, `snapshot_materialized`, `review_attempt_started/finished` with child PID, `probe_started/finished`, `verdict_evaluated`, `report_written`, `run_finished`, `run_skipped`, `run_failed`) and maintains `audit-reports/commit-reviews/last-run.json` (`review-last-run@1`) as the live status channel, updated ~every 2s during active attempts. Telemetry failures are swallowed and never change the verdict; `OMP_REVIEW_KIT_TELEMETRY=0` disables it. The extension polls `last-run.json` while a `git commit` tool call is active and `/reviewer-kit:status` surfaces it via `installer.status().lastRun`.
   - `ReviewWorkflowService` outputs verdict to stdout/stderr and sets exit code 0 on PASS or 1 on BLOCK.

`scripts/run-review.mjs` is the self-contained distributable runner; `.omp/review-kit/run-review.mjs` is the repository's self-hosted copy. `scripts/check-layout.mjs` enforces zero-drift equality between both files. `src/` provides modular OOP and DDD exports (`DiffIdentity`, `ReviewVerdict`, `ReviewPrompt`, `ReviewReport`, `ReviewExecutionResult`, `PluginInstallerService`, ports, adapters, telemetry adapters, and `ReviewWorkflowService`).

`scripts/analyze-review-run.mjs` (`npm run analyze-review`) correlates `runs.jsonl` with OMP process logs (`~/.omp/logs/omp.<date>.<pid>.log`) by child PID — or by time window when `OMP_REVIEW_KIT_OMP` is a `.cmd` wrapper — and reports per-attempt timings, request counts, context growth, per-stage subagent timing, and provider-error classes. `.devin/skills/omp-review-incidents/SKILL.md` documents the incident-investigation playbook.

## Key Directories

- `src/`: domain models, ports, application services (`installer-service.mjs`, `review-workflow-service.mjs`), infrastructure adapters, and native extension entry point (`extension.mjs`).
- `agents/`: OMP agent definitions (`agents/reviewer-kit.md`, `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`).
- `skills/`: reusable review methodology and protocol (`skills/reality-first-review/SKILL.md`, `skills/multi-stage-review/SKILL.md`).
- `scripts/`: runner (`run-review.mjs`), mutation gate (`run-mutation-tests.mjs`), integrity check (`check-layout.mjs`), and fallback Windows/POSIX installers (`install-hook.ps1`, `install-hook.sh`).
- `templates/githooks/`: pre-commit hook copied into target repositories.
- `.omp/review-kit/`: self-hosted runner copy used by this repository's pre-commit hook.
- `.omp-plugin/`: marketplace plugin catalog metadata.
- `tests/`: flat native Node.js test suites (`*.test.mjs`), including contract, BDD, extension, marketplace, mutation, telemetry, and real Git hook E2E suites.
- `.devin/skills/`: repository skills, including `omp-review-incidents` (incident-investigation playbook).
- `.github/workflows/`: cross-platform CI automation (`ci.yml`).
- `audit-reports/`: architecture records (`audit-reports/multi-stage-review-architecture.md`), the observability domain spec (`audit-reports/review-observability-domain-spec.md`), and commit reviews plus run telemetry (`audit-reports/commit-reviews/`: `*.md` reports, `runs.jsonl`, `last-run.json`).

## Development Commands

```sh
npm test                         # node --test tests/*.test.mjs
npm run test:mutation            # node scripts/run-mutation-tests.mjs
npm run check                    # node scripts/check-layout.mjs
node scripts/run-review.mjs      # review the current staged diff
```

Opt-in live OMP verification (requires local OMP executable). Run with the spec reporter for streaming progress, and capture output to a file instead of piping through `tail` so assertion failures keep the full OMP stdout/stderr:
```sh
OMP_REVIEW_KIT_LIVE_E2E=1 node --test --test-reporter=spec tests/live-e2e-omp.test.mjs > live-e2e.log 2>&1
```
Live checks 3/4 drive real `omp -p --model @slow` directly via `runLiveOmp` and assert on the raw stdout; `runLiveOmp` kills the whole process tree on timeout and rejects with stdout/stderr tails. The matrix cases exercise the full pre-commit hook path (runner + adapter + report) through the real Git hook.

Fallback configuration (optional): `OMP_REVIEW_KIT_MODEL` selects the primary model (default `@smol`), `OMP_REVIEW_KIT_FALLBACK_MODELS` supplies a comma-separated fallback list (default `@task`), `OMP_REVIEW_KIT_MAX_FALLBACKS` caps retries, `OMP_REVIEW_KIT_PROBE_TIMEOUT_MS` sets the availability-probe timeout (60,000ms by default), and `OMP_REVIEW_KIT_EFFORT` rewrites the `:effort` suffix of resolved selectors (e.g. `low`, `medium`, `high`, `max`). `OMP_REVIEW_KIT_TELEMETRY=0` disables `runs.jsonl`/`last-run.json` writes. Full reviews are never automatically cancelled by this plugin. Note: `agentModelOverrides` in the user's `~/.omp/agent/config.yml` silently override agent frontmatter `model:` values and can defeat the intended fast chain.

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
- `src/infra/filesystem-telemetry-adapter.mjs`: `RunTelemetry` sink, `FileSystemTelemetryAdapter`, `NullTelemetryAdapter`, `safeRunTelemetry`, `formatProviderOutageError`.
- `scripts/run-mutation-tests.mjs`: dependency-free safety mutation test runner.
- `.omp/review-kit/run-review.mjs`: self-hosted runtime copy invoked by the local hook.
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

## Testing & QA

Tests use the built-in Node.js test runner (`node:test`) and strict assertions (`node:assert/strict`). Test suites live directly under `tests/` named `*.test.mjs`. Coverage spans domain units, BDD scenarios, extension commands, mutation testing, and full Git pre-commit hook E2E runs. Before declaring work complete, run:

```sh
npm test
npm run test:mutation
npm run check
```
