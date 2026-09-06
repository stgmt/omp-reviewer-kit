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
   - `ReviewPrompt` carrying the diff hash invokes `ReviewerPort` (`OmpCliReviewerAdapter`) headlessly via `omp -p --model @slow --no-session` (overridable via `OMP_REVIEW_KIT_OMP` with no timeout; full review processes are never cancelled by this plugin). Provider quota, rate-limit, authentication, and model-capacity failures trigger up to three fallback attempts selected from `OMP_REVIEW_KIT_FALLBACK_MODELS` or the installed `omp models --json` catalog; catalog discovery and each candidate availability probe are bounded at 60 seconds by default, and successful candidates receive the same model through `--model`, `--slow`, and `--smol`; fallback attempts use the same 600,000ms timeout by default and never retry a real verdict or timeout. If every probe fails, the staged change remains BLOCKed.
   - OMP launches `reviewer-kit` (orchestrator), which executes the 4-stage protocol strictly in sequence:
     1. **Stage 1 (Scout)**: Spawns `review-context-scout` (model `@task`) to map diff scope, touched paths, callers via LSP/grep, invariants, and tests.
     2. **Stage 2 (Parallel Risk Hunters)**: Spawns batch `task` with two `review-risk-hunter` (model `@slow`) agents in parallel (`lane: "correctness"` and `lane: "security"`), generating candidate defects under strict anti-noise rules.
     3. **Stage 3 (Adversarial Verifier)**: Spawns `review-finding-verifier` (model `@slow`) acting as the author's defense lawyer, verifying upstream protections and reachability to confirm or reject candidates.
     4. **Stage 4 (Synthesis & Verdict)**: `reviewer-kit` synthesizes coverage, compiles confirmed findings, and emits the final report.
   - Output is parsed into `ReviewVerdict`. Invariant: only an exact solitary `REVIEW_RESULT=PASS` yields approval; any confirmed `P1`/`P2`, missing stage, malformed marker, or non-zero exit strictly yields `BLOCK`.
   - `ReviewReport` formats the markdown audit trail, which `ReportStorePort` (`FileSystemReportStoreAdapter`) writes to `audit-reports/commit-reviews/<timestamp>-<hash>.md`.
   - `ReviewWorkflowService` outputs verdict to stdout/stderr and sets exit code 0 on PASS or 1 on BLOCK.

`scripts/run-review.mjs` is the self-contained distributable runner; `.omp/review-kit/run-review.mjs` is the repository's self-hosted copy. `scripts/check-layout.mjs` enforces zero-drift equality between both files. `src/` provides modular OOP and DDD exports (`DiffIdentity`, `ReviewVerdict`, `ReviewPrompt`, `ReviewReport`, `ReviewExecutionResult`, `PluginInstallerService`, ports, adapters, and `ReviewWorkflowService`).

## Key Directories

- `src/`: domain models, ports, application services (`installer-service.mjs`, `review-workflow-service.mjs`), infrastructure adapters, and native extension entry point (`extension.mjs`).
- `agents/`: OMP agent definitions (`agents/reviewer-kit.md`, `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`).
- `skills/`: reusable review methodology and protocol (`skills/reality-first-review/SKILL.md`, `skills/multi-stage-review/SKILL.md`).
- `scripts/`: runner (`run-review.mjs`), mutation gate (`run-mutation-tests.mjs`), integrity check (`check-layout.mjs`), and fallback Windows/POSIX installers (`install-hook.ps1`, `install-hook.sh`).
- `templates/githooks/`: pre-commit hook copied into target repositories.
- `.omp/review-kit/`: self-hosted runner copy used by this repository's pre-commit hook.
- `.omp-plugin/`: marketplace plugin catalog metadata.
- `tests/`: flat native Node.js test suites (`*.test.mjs`), including contract, BDD, extension, marketplace, mutation, and real Git hook E2E suites.
- `.github/workflows/`: cross-platform CI automation (`ci.yml`).
- `audit-reports/`: architecture records (`audit-reports/multi-stage-review-architecture.md`) and immutable commit reviews (`audit-reports/commit-reviews/`).

## Development Commands

```sh
npm test                         # node --test tests/*.test.mjs
npm run test:mutation            # node scripts/run-mutation-tests.mjs
npm run check                    # node scripts/check-layout.mjs
node scripts/run-review.mjs      # review the current staged diff
```

Opt-in live OMP verification (requires local OMP executable):
```sh
OMP_REVIEW_KIT_LIVE_E2E=1 node --test tests/live-e2e-omp.test.mjs
```

Fallback configuration (optional): `OMP_REVIEW_KIT_MODEL` selects the primary model, `OMP_REVIEW_KIT_FALLBACK_MODELS` supplies a comma-separated fallback list, `OMP_REVIEW_KIT_MAX_FALLBACKS` caps retries, and `OMP_REVIEW_KIT_PROBE_TIMEOUT_MS` sets the availability-probe timeout (60,000ms by default). Full reviews are never automatically cancelled by this plugin.

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
