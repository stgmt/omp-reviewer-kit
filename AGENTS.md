# Repository Guidelines

## Project Overview

`omp-reviewer-kit` is an OMP plugin for evidence-first review of staged Git changes. It combines a read-only `reviewer-kit` agent, the `reality-first-review` skill, a fail-closed pre-commit runner, and a native OMP extension module (`src/extension.mjs`). A commit proceeds only when OMP emits exactly one `REVIEW_RESULT=PASS`; every review is recorded under `audit-reports/commit-reviews/`.

## Architecture & Data Flow

1. **Standard Plugin Discovery**: When installed via `omp plugin install`, OMP automatically discovers the agent definition (`agents/reviewer-kit.md`), the review methodology skill (`skills/reality-first-review/SKILL.md`), and the extension (`src/extension.mjs`).
2. **In-Session Setup & Status**: The extension registers native slash commands:
   - `/reviewer-kit:setup`: configures the Git pre-commit hook in the active project (`core.hooksPath .githooks`).
   - `/reviewer-kit:status`: reports active repository hook status and latest review verdict.
   - `/reviewer-kit:doctor`: checks Node.js, Git, OMP CLI, and hook integrity.
   - `session_start` lifecycle hook: provides transparent status bar state (`reviewer-kit: active` / `unconfigured`).
3. **Pre-Commit Review Flow**:
   - `.githooks/pre-commit` resolves repository root and executes `.omp/review-kit/run-review.mjs` with Node.js.
   - The runner queries `GitPort` (`SubprocessGitAdapter`) for `git diff --cached --binary --no-ext-diff --`. Empty staged changes exit with code 0 immediately without invoking OMP.
   - `DiffIdentity` computes deterministic SHA-256 hash of the binary diff.
   - `ReviewPrompt` carrying the diff hash invokes `ReviewerPort` (`OmpCliReviewerAdapter`) headlessly via `omp -p --model @slow --no-session` (overridable via `OMP_REVIEW_KIT_OMP` with timeout protection).
   - OMP loads `reviewer-kit`, which loads `reality-first-review` and dynamically selects relevant project review skills.
   - Output is parsed into `ReviewVerdict`. Invariant: only an exact solitary `REVIEW_RESULT=PASS` yields approval; malformed markers, missing markers, multiple conflicting markers, or non-zero exits strictly yield `BLOCK`.
   - `ReviewReport` formats the markdown audit trail, which `ReportStorePort` (`FileSystemReportStoreAdapter`) writes to `audit-reports/commit-reviews/<timestamp>-<hash>.md`.
   - `ReviewWorkflowService` outputs verdict to stdout/stderr and sets exit code 0 on PASS or 1 on BLOCK.

`scripts/run-review.mjs` is the self-contained distributable runner; `.omp/review-kit/run-review.mjs` is the repository's self-hosted copy. `scripts/check-layout.mjs` enforces zero-drift equality between both files. `src/` provides modular OOP and DDD exports (`DiffIdentity`, `ReviewVerdict`, `ReviewPrompt`, `ReviewReport`, `ReviewExecutionResult`, `PluginInstallerService`, ports, adapters, and `ReviewWorkflowService`).

## Key Directories

- `src/`: domain models, ports, application services (`installer-service.mjs`, `review-workflow-service.mjs`), infrastructure adapters, and native extension entry point (`extension.mjs`).
- `agents/`: OMP agent definitions and tool restrictions (`agents/reviewer-kit.md`).
- `skills/`: reusable review methodology loaded by the agent (`skills/reality-first-review/SKILL.md`).
- `scripts/`: runner (`run-review.mjs`), integrity check (`check-layout.mjs`), and fallback Windows/POSIX installers (`install-hook.ps1`, `install-hook.sh`).
- `templates/githooks/`: pre-commit hook copied into target repositories.
- `.omp/review-kit/`: self-hosted runner copy used by this repository's pre-commit hook.
- `.omp-plugin/`: marketplace plugin catalog metadata.
- `tests/`: flat native Node.js test suites (`*.test.mjs`), including contract, BDD, extension, and real Git hook E2E suites.
- `.github/workflows/`: cross-platform CI automation (`ci.yml`).
- `audit-reports/commit-reviews/`: generated review evidence; immutable audit records.

## Development Commands

```sh
npm test                         # node --test tests/*.test.mjs
npm run check                    # node scripts/check-layout.mjs
node scripts/run-review.mjs      # review the current staged diff
```

Installation via standard OMP commands:

```bash
omp plugin install github:stgmt/omp-reviewer-kit
```

There is no build, lint, format, or typecheck command. Run both `npm test` and `npm run check` after modifying source, agents, skills, templates, or metadata.

## Code Conventions & Common Patterns

- Use native ESM in `.mjs` files: `import`/`export`, `node:` built-ins, semicolons, two-space indentation, and `camelCase` functions/variables.
- Zero external runtime dependencies: standard Node.js built-in modules only (`node:crypto`, `node:fs/promises`, `node:child_process`, `node:path`, `node:url`, `node:os`).
- Apply OOP and DDD principles:
  - Domain invariants live in Value Objects (`DiffIdentity`, `ReviewVerdict`) and Entities (`ReviewReport`).
  - Application orchestration lives in `ReviewWorkflowService` and `PluginInstallerService`.
  - External capabilities are decoupled behind ports (`GitPort`, `ReviewerPort`, `ReportStorePort`) and adapters.
- Preserve fail-closed behavior: only one exact standalone `REVIEW_RESULT=PASS` line permits a commit; any ambiguity or failure must return `BLOCK` (exit code 1).
- Staged change isolation: review strictly targets `git diff --cached --binary --no-ext-diff --` and ignores unstaged worktree changes.
- Read-only agent contract: `agents/reviewer-kit.md` must never contain mutation tools (`edit`, `write`) or instructions that stage, reset, commit, or edit files.
- OMP skill discovery is authoritative: do not add manual directory scans for `.omp/skills` or create secondary registries.
- BDD testing: write tests using `node:test` and `node:assert/strict` with Given / When / Then structure and assert observable outputs and side effects.

## Important Files

- `src/index.mjs`: primary module export and composition root (`createReviewWorkflowService`).
- `src/extension.mjs`: native OMP extension registering `/reviewer-kit:*` slash commands and `session_start` handler.
- `src/application/installer-service.mjs`: hook installation and health check diagnostics.
- `scripts/run-review.mjs`: self-contained pre-commit runner and backward-compatible `runReview` facade.
- `.omp/review-kit/run-review.mjs`: self-hosted runtime copy invoked by the local hook.
- `agents/reviewer-kit.md`: model, allowed tools, read-only contract, and skill loading.
- `skills/reality-first-review/SKILL.md`: 16 review rules, finding format, and skill-composition policy.
- `ROADMAP.md`: engineering direction across 5 development phases.
- `CHANGELOG.md`: release version history following Keep a Changelog.
- `.github/workflows/ci.yml`: GitHub Actions CI pipeline testing Ubuntu and Windows across Node 18, 20, and 22.
- `scripts/check-layout.mjs`: layout integrity gate and runner synchronization validator.
- `tests/bdd-scenarios.test.mjs`: executable BDD scenario suite.
- `tests/extension.test.mjs`: extension and installer service test suite.
- `tests/e2e-git-hook.test.mjs`: real Git pre-commit hook E2E integration suite.

## Runtime/Tooling Preferences

Use Node.js and npm scripts; this repository is not a Bun project. `package.json` specifies `"type": "module"` and `"engines": { "node": ">=18.0.0" }`. Zero npm dependencies and no lockfiles. Runtime review requires `git` and an `omp` executable in `PATH`, or configured via `OMP_REVIEW_KIT_OMP`.

## Testing & QA

Tests use the built-in Node.js test runner (`node:test`) and strict assertions (`node:assert/strict`). Test suites live directly under `tests/` named `*.test.mjs`. Coverage spans domain units, BDD scenarios, extension commands, and full Git pre-commit hook E2E runs. Before declaring work complete, run:

```sh
npm test
npm run check
```
