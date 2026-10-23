# Repository Guidelines

## Project Overview

`omp-reviewer-kit` is an OMP plugin and Git pre-commit hook for evidence-first review of staged changes. Since 0.22.0 the review runs on OMP's native `TaskTool`: a Bun host calls the pinned OMP library directly with `agent: reviewer-kit`, and the orchestrator runs three read-only specialists through native `task`. A commit proceeds only when the host exits 0 (`review: PASS`). The reviewer's Markdown must also end with exactly one solitary `REVIEW_RESULT=PASS` line; anything else is BLOCK (fail-closed). Every review writes a report outside the repository, under `~/Documents/omp-reviewer-kit/`.

## Binding requirement: model ownership

- `.specs/native-task-review/REQUIREMENTS.md` is binding. `ACCEPTANCE_CRITERIA.md` lists the test matrix; `STATUS.md` records what is verified and what is not. Read them before changing the review entry point.
- The review enters the native `TaskTool` with `agent: reviewer-kit`. Models, roles, effort, agent overrides, credentials and fallback belong to OMP and the owner's `~/.omp/agent/config.yml`.
- Do not add a model dispatcher, a model preflight, a task-to-default chain overlay, a `--model` pin, a provider walk, or a whole-review model retry. Do not edit `~/.omp/agent/config.yml`.
- Legacy CLI behavior (`omp -p --model @task`) is not compliance and must not return as a fallback.
- The OMP fork is removed. The approved option 2 is implemented as a kit host (`src/native/task-engine.mjs`) that calls the pinned library's exported `TaskTool`, with no OMP source patch. `STATUS.md` states what that does and does not establish.

## Architecture & Data Flow

1. **Plugin discovery**: `package.json` (`omp.extensions` → `src/extension.mjs`), agents `agents/*.md`, skills `skills/*/SKILL.md`. The Claude Code shell is `claude-plugin/` (manifest, `hooks/hooks.json` with the SessionStart hook and the Bash PreToolUse commit guard, commands `setup`, `review`, `doctor`, `install-omp`, and `scripts/bridge.mjs`).
2. **Extension** (`src/extension.mjs`): commands `reviewer-kit:setup`, `reviewer-kit:status`, `reviewer-kit:doctor` and `slop`; a `session_start` handler (sets up and heals the hook, status bar); a `tool_call` handler that runs the commit guard before `git commit`.
3. **Installer** (`src/application/installer-service.mjs`, `PluginInstallerService`): installs and checks the hook, the target registry (`src/infra/target-registry.mjs`, `src/domain/target-policy.mjs`), and the hook guard. Hook ownership uses the marker in `src/domain/hook-template.mjs`; the runner version rule is `src/domain/runner-version.mjs`; the hook shim is `src/domain/hook-shim.mjs`; commit detection is `src/domain/git-commit-command.mjs`.
   - Hook guard: `core.hooksPath` pointing at git's default hooks directory is a repairable stray value. A shim in `<git common dir>/hooks/pre-commit` runs the checkout's own `.githooks/pre-commit`. `guardCommit` checks which hook git would run before a commit, and `assessHook` reports the effective hook. Foreign hooks are never overwritten.
4. **Hook chain**: `templates/githooks/pre-commit` → `.omp/review-kit/run-review.mjs` (thin stub, byte-identical to `templates/review-kit/run-review.mjs`, which runs the installed plugin's `scripts/run-review.mjs`) → `scripts/run-review.mjs` (Node launcher: checks Bun and the pinned library in the kit root, then runs `bun src/native/native-host.mjs <repo>`) → the native host.
5. **Native host** (`src/native/native-host.mjs`, Bun):
   - `readStagedChange` (`src/native/snapshot.mjs`) reads `git diff --cached --binary --no-ext-diff`. Vendored kit files are exempt only when they are byte-identical to the installed plugin's templates.
   - `materializeStagedSnapshot` exports the index with `git checkout-index` into a temporary directory and writes `.review/diff.patch`, `.review/changed-files.txt` and `.review/file-classes.json`. It returns null when nothing is left to review, and the host prints `review: SKIPPED (no staged changes)`.
   - `buildAssignment` (`src/native/assignment.mjs`) builds the reviewer task text. `runNativeReview` (`src/native/native-review.mjs`) runs it.
   - `runReviewerTask` (`src/native/task-engine.mjs`) loads the pinned OMP library, creates a `TaskTool` session whose extension root is the kit, and calls `execute` with `agent: 'reviewer-kit'`. The only settings overlay is the structural `task.structured: true`.
   - The reviewer completes with native `yield` containing one Markdown string. `decodeReport` decodes it once.
   - `evaluateReview` (`src/native/verdict.mjs`) makes the verdict. `saveReport` writes the report through `src/infra/filesystem-report-store-adapter.mjs`.
6. **Verdict invariant** (`src/native/verdict.mjs`): PASS requires all of the following. The reviewer result is a single completed, non-aborted native task with exit 0 and a valid yield. The Markdown has exactly one solitary `REVIEW_RESULT=PASS` line, and it is the last non-empty line. Every mandatory stage completed: the scout (at least one), a hunter for each planned lane, and the verifier for the `full` profile. No verifier-confirmed finding remains, and no confirmed coverage gap remains when the scout reports a runnable test harness. Anything else is BLOCK.
7. **Agents**: `reviewer-kit` (orchestrator; `spawns: review-context-scout, review-risk-hunter, review-finding-verifier`), with `model: "@task"`. The specialists `review-context-scout`, `review-risk-hunter` and `review-finding-verifier` also declare `model: "@task"` and have read-only tools (`read, grep, glob, lsp, bash`). `reviewer-kit` also has `task`, restricted by its `spawns` list.
8. **Outside the gate**: `/slop` (`src/domain/slop-prompt.mjs`, `src/domain/slop-report.mjs`, `agents/slop*.md`) and the range audit (`scripts/audit-range.mjs`, `agents/review-range-auditor.md`) do not run through the native host. The `slop` agents and `review-range-auditor` declare no model. `audit-range.mjs --llm` still launches `omp -p --model ${OMP_REVIEW_KIT_MODEL ?? '@slow'}`, which is a kit-side model pin. It is a known follow-up, not part of the review gate.
9. **Scope of the release**: 0.22.0 removed the verdict cache, delta rounds, context pack, hunter shards, batch gate, run telemetry and records, progress commands, superseded-run stop, pre-review check execution, the rejection envelope, and all model-chain settings. Reports are the only audit trail.

`scripts/run-review.mjs` is the distributable launcher installed with the plugin. `templates/review-kit/run-review.mjs` is the stub every repository vendors; it is never edited, and `scripts/check-layout.mjs` enforces that the vendored copy is byte-identical. `src/index.mjs` exports the native review functions and the installer.

## Key Directories

- `src/native/`: the native review (`native-host.mjs`, `native-review.mjs`, `task-engine.mjs`, `snapshot.mjs`, `assignment.mjs`, `verdict.mjs`).
- `src/application/`: `installer-service.mjs`.
- `src/domain/`: value and policy modules (`diff-identity.mjs`, `file-class.mjs`, `hook-template.mjs`, `hook-shim.mjs`, `git-commit-command.mjs`, `runner-version.mjs`, `target-policy.mjs`, `suspicion-map.mjs`, `prompt-token.mjs`, `slop-*.mjs`).
- `src/infra/`: `filesystem-report-store-adapter.mjs`, `target-registry.mjs`, `vendored-kit-files.mjs`, `process-tree.mjs`.
- `src/extension.mjs`: the OMP extension.
- `agents/`, `skills/`: agent and skill definitions loaded by OMP.
- `scripts/`: launcher, hook stamp, sync and setup helpers, `check-layout.mjs`, `run-tests.mjs`, the mutation gate (`run-mutation-tests.mjs`, `mutation-runner.mjs`, `mutation-selectors.json`, `mutation-test-reporter.mjs`), and `audit-range.mjs`.
- `templates/`: `githooks/pre-commit` and `review-kit/run-review.mjs`.
- `claude-plugin/`: the Claude Code shell (see Architecture).
- `tests/`: flat `node:test` suites (`*.test.mjs`).
- `.specs/native-task-review/`: requirements, acceptance criteria, the variants document (`PLAN.md`), the status record (`STATUS.md`), and `MUTATION_RETIREMENT.json`.
- `audit-reports/`: architecture notes and historical incident reports. Run records are not kept in the repository.

## Development Commands

```sh
bun install --frozen-lockfile    # the pinned OMP library (@oh-my-pi/pi-coding-agent 18.12.5)
npm test                         # node scripts/run-tests.mjs
npm run test:mutation            # node scripts/run-mutation-tests.mjs
npm run check                    # node scripts/check-layout.mjs
node scripts/run-review.mjs      # review the current staged diff
```

Opt-in live check (spends money through the owner's OMP configuration; never run it by default):

```sh
OMP_REVIEW_KIT_LIVE_E2E=1 node --test --test-reporter=spec tests/e2e-native-hook.test.mjs > live-e2e.log 2>&1
```

The live case runs a real `git commit` through the installed hook and asserts `review: PASS`. The offline cases of that suite use real git and the real hook, with no mocks.

There is no build, lint, format or typecheck command. Run `npm test`, `npm run test:mutation` and `npm run check` after changing source, agents, skills, templates or metadata.

## Code Conventions & Common Patterns

- Native ESM `.mjs`: `import`/`export`, `node:` built-ins, semicolons, two-space indentation, `camelCase`.
- Runtime dependencies: exactly one, `@oh-my-pi/pi-coding-agent`, pinned to `18.12.5` in `package.json`, with `bun.lock`. The host runs under Bun 1.4.1; the launcher, hook and installer run under Node. Do not add other dependencies without an explicit decision.
- Fail-closed: only an exact solitary `REVIEW_RESULT=PASS` line with every mandatory stage completed permits a commit. Ambiguity, missing stages, aborted or malformed tasks and infrastructure errors are BLOCK.
- Review inputs: `git diff --cached --binary --no-ext-diff` only. Unstaged worktree changes are ignored.
- Tool permissions: none of the four review agents may edit, stage, reset, checkout or commit. Specialists have read-only tools only.
- OMP skill discovery is authoritative: do not add manual scans for `.omp/skills`.
- Tests: `node:test` with `node:assert/strict`, Given / When / Then. The hook tests use real git and the real hook. The verdict and yield unit tests use constructed native results; those are not acceptance evidence for the native path.

## Important Files

- `src/native/native-host.mjs`: the host entry point.
- `src/native/task-engine.mjs`: the native `TaskTool` call and yield handling.
- `src/native/verdict.mjs`: the verdict invariant.
- `src/application/installer-service.mjs`: hook installation, guard and health.
- `src/extension.mjs`: OMP commands and lifecycle handlers.
- `scripts/run-review.mjs`: the Node launcher.
- `templates/githooks/pre-commit`: the hook template (stamped with `scripts/stamp-hook.mjs`).
- `templates/review-kit/run-review.mjs`: the vendored stub.
- `agents/reviewer-kit.md`: orchestrator and final verdict synthesis.
- `skills/multi-stage-review/SKILL.md`, `skills/reality-first-review/SKILL.md`: review protocol and methodology.
- `.specs/native-task-review/REQUIREMENTS.md`, `STATUS.md`: binding requirement and verification record.
- `scripts/run-mutation-tests.mjs`, `scripts/mutation-selectors.json`: mutation catalog and selectors.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`: CI and the release workflow.
- `CHANGELOG.md`, `ROADMAP.md`: release history and direction.

## Testing & QA

Before changing or running the mutation gate, follow `.claude/skills/mutation-fast-default/SKILL.md`. The gate uses four asynchronous workers (`OMP_MUTATION_WORKERS`, 1–16; this workstation runs 8), reusable worker trees verified before each reuse, and selectors calibrated in `scripts/mutation-selectors.json`. Every curated mutant must be killed by a deciding assertion of its test file. Missing or stale selectors, zero selected tests, timeouts, crashes and infrastructure errors block the gate. On `--calibrate-stale`, a recorded selector is first re-proved with focused runs (same proof class as the ordinary gate); the full-suite reference only runs when the recorded names no longer decide. After adding or changing mutants or deciding tests, run `node scripts/run-mutation-tests.mjs --calibrate-stale`; its exit code is the verdict of the whole catalog.

Mutant work rules (the full standard is in the skill; these are the ones that cost hours before):

- Removing a temporary tree always retries (`removeTree`, `REMOVE_OPTIONS`). A plain `rm` with `recursive` on a tree is a defect, not a flake.
- Every proof is persisted at once (`onProven`). A run that dies keeps what it proved.
- Infrastructure errors (timeout, crash, cleanup failure, zero selected tests, a red suite on the pristine tree) are never kills. Fix the cause and rerun; do not rerun blindly.
- After editing a mutant's target file, check that each `original` still matches exactly once before a long run.
- After editing a deciding test or a mutant, the selector is stale. Run `--calibrate-stale`; do not carry an old green result over to changed bytes.
- Verify on an export of the index: stage the paths first, because `checkout-index` reads the index, not the working tree.
- Run the gate in the background with a log file. Measure the time from the log; do not promise a duration.
- Never commit `audit-reports/mutation-result*`.

CI runs Node 22 and 24 on Ubuntu and Windows (Bun 1.4.1, `bun install --frozen-lockfile`), plus the mutation gate on Ubuntu. Node 18 and 20 are not in CI and are not verified for this release.

Releases follow `.claude/skills/release-and-deliver/SKILL.md`. Read it before any release step.
