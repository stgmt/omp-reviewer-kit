# Repository Guidelines

## Project Overview

`omp-reviewer-kit` is an OMP plugin and Git pre-commit hook for evidence-first review of staged changes. The review runs on OMP's native `TaskTool`: a Bun host calls the pinned OMP library once per stage (scout, one hunter per lane, the maintainability stage, the verifier) and once for synthesis (`agent: reviewer-kit`). The host decides what runs and what is reused from the journal; OMP owns every model. A commit proceeds only when the host exits 0 (`review: PASS`). The reviewer's Markdown must also end with exactly one solitary `REVIEW_RESULT=PASS` line; anything else is BLOCK (fail-closed). Every review writes a report outside the repository, under `~/Documents/omp-reviewer-kit/`.

## Binding requirement: model ownership

- `.specs/native-task-review/REQUIREMENTS.md` is binding. `ACCEPTANCE_CRITERIA.md` lists the test matrix; `STATUS.md` records what is verified and what is not. Read them before changing the review entry point.
- The review enters the native `TaskTool` once per stage, and once more with `agent: reviewer-kit` for synthesis. Models, roles, effort, agent overrides, credentials and fallback belong to OMP and the owner's `~/.omp/agent/config.yml`.
- Do not add a model dispatcher, a model preflight, a task-to-default chain overlay, a `--model` pin, a provider walk, or a whole-review model retry. Do not edit `~/.omp/agent/config.yml`.
- Legacy CLI behavior (`omp -p --model @task`) is not compliance and must not return as a fallback.
- The OMP fork is removed. The approved option 2 is implemented as a kit host (`src/native/task-engine.mjs`) that calls the pinned library's exported `TaskTool`, with no OMP source patch. `STATUS.md` states what that does and does not establish.

## Architecture & Data Flow

1. **Plugin discovery**: `package.json` (`omp.extensions` → `src/extension.mjs`), agents `agents/*.md`, skills `skills/*/SKILL.md`. The Claude Code shell is `claude-plugin/` (manifest, `hooks/hooks.json` with the SessionStart hook and the Bash PreToolUse commit guard, commands `setup`, `review`, `doctor`, `install-omp`, and `scripts/bridge.mjs`).
2. **Extension** (`src/extension.mjs`): commands `reviewer-kit:setup`, `reviewer-kit:status`, `reviewer-kit:doctor` and `slop`; a `session_start` handler (sets up and heals the hook, status bar); a `tool_call` handler that runs the commit guard before `git commit`.
3. **Installer** (`src/application/installer-service.mjs`, `PluginInstallerService`): installs and checks the hook, the target registry (`src/infra/target-registry.mjs`, `src/domain/target-policy.mjs`), and the hook guard. Hook ownership uses the marker in `src/domain/hook-template.mjs`; the runner version rule is `src/domain/runner-version.mjs`; the hook shim is `src/domain/hook-shim.mjs`; commit detection is `src/domain/git-commit-command.mjs`.
   - Hook guard: `core.hooksPath` pointing at git's default hooks directory is a repairable stray value. A shim in `<git common dir>/hooks/pre-commit` runs the checkout's own `.githooks/pre-commit`. `guardCommit` checks which hook git would run before a commit, and `assessHook` reports the effective hook. Foreign hooks are never overwritten.
4. **Hook ownership has no release version.** `src/domain/hook-template.mjs` writes `hook-format v1` and a digest of the hook body; the release version lives in the plugin and the marketplaces. A release that does not change the hook leaves every installed hook byte-identical, so delivery never rewrites a repository. `scripts/deliver.mjs` is the one update command: it upgrades the OMP marketplace entry and the Claude plugin and verifies that the shipped hook carries no release version.

5. **Hook chain**: `templates/githooks/pre-commit` → `.omp/review-kit/run-review.mjs` (thin stub, byte-identical to `templates/review-kit/run-review.mjs`, which runs the installed plugin's `scripts/run-review.mjs`) → `scripts/run-review.mjs` (Node launcher: checks Bun and the pinned library in the kit root, then runs `bun src/native/native-host.mjs <repo>`) → the native host.
5. **Native host** (`src/native/native-host.mjs`, Bun):
   - `readStagedChange` (`src/native/snapshot.mjs`) reads `git diff --cached --binary --no-ext-diff`. Vendored kit files are exempt only when they are byte-identical to the installed plugin's templates.
   - `materializeStagedSnapshot` exports the index with `git checkout-index` into a temporary directory and writes `.review/diff.patch`, `.review/changed-files.txt` and `.review/file-classes.json`. It returns null when nothing is left to review, and the host prints `review: SKIPPED (no staged changes)`.
   - `buildAssignment` (`src/native/assignment.mjs`) builds the staged inputs every stage reads; `src/native/stage-tasks.mjs` composes one task text per stage, and `src/native/stage-pipeline.mjs` runs the plan in order, reusing journaled stages.
   - `createStageRunner` (`src/native/task-engine.mjs`) loads the pinned OMP library, creates one `TaskTool` session whose extension root is the kit, and runs one native task per stage. The only settings overlay is the structural `task.structured: true`.
   - The synthesizer completes with native `yield` containing one Markdown string; `reviewerYield` decodes it once.
   - `evaluateReview` (`src/native/verdict.mjs`) makes the verdict. `saveReport` writes the report through `src/infra/filesystem-report-store-adapter.mjs`.
**Mutation certificate.** `src/domain/mutation-certificate.mjs` holds the pure rules; `src/infra/mutation-certificate-store.mjs` writes one `<digest>.json` under `<home>/.omp/review-kit-mutation` (`OMP_REVIEW_KIT_MUTATION_CERT_DIR`) through `src/infra/atomic-json-file.mjs`, the same atomic writer the run records use. It exists so one gate run proves the catalog once per byte state instead of once per attempt.

**Review journal.** `src/domain/review-journal.mjs` holds the pure rules: the key of one review, the stage plan, and whether a stored entry may be reused. The key is `sha256(repoIdentity, treeOid, diffHash, kitVersion, agentsDigest, configFingerprint)`, where `treeOid` is `git write-tree` of the index: a staged ignored file changes the tree, so junk cannot hide behind an older verdict, and a working-tree edit that is not staged changes nothing. `src/infra/review-journal-store.mjs` writes one directory per key under `<home>/.omp/review-kit-journal` (`OMP_REVIEW_KIT_JOURNAL_DIR`): `journal.json` with the finished verdict and the report text, and `stages/<stage-id>.json` with the structured result of each finished stage. Every write is atomic and fail-open; a journal that cannot be stored costs reuse, never a verdict. `OMP_REVIEW_KIT_JOURNAL=off` disables reuse. A finished verdict for the same key answers the next review without calling a model; a review killed by the caller's timeout continues from the first stage without a valid entry. The journal never decides a verdict by itself.

**Run record.** `src/native/review-telemetry.mjs` carries OMP's own numbers into one record per run: `src/infra/review-run-store.mjs` writes it atomically under `<home>/.omp/review-kit-runs` (`OMP_REVIEW_KIT_RUNS_DIR`), `src/domain/review-run-summary.mjs` holds the pure schema, duration and count rules, and `scripts/review-runs.mjs` reads it (`--last`, `--all`, `--repo`, `--run`, `--json`, `--follow`). The record is an observation of the review: it never carries the report, a prompt, a file body or a finding's text, it is written after the verdict, every write is fail-open, and no `Date.now` of it can reach `verdict.mjs` or the exit code. `task-engine.stageEvidence` keeps the per-stage `durationMs`/`tokens`/`requests`/`contextTokens` OMP reports and `progressEvents` turns `details.progress` into live stage lines (`OMP_REVIEW_KIT_PROGRESS=0` silences them). Retention: newest 200 and 30 days, never the newest record and never a live run; a record of another schema is ignored, never migrated.

6. **Verdict invariant** (`src/native/verdict.mjs`): PASS requires all of the following. The reviewer result is a single completed, non-aborted native task with exit 0 and a valid yield. The Markdown has exactly one solitary `REVIEW_RESULT=PASS` line, and it is the last non-empty line. Every mandatory stage completed: the scout (at least one), a hunter for each planned lane, and the verifier for the `full` profile. No verifier-confirmed finding remains, and no blocking coverage gap remains when the scout reports a runnable test harness. A gap blocks only when it is `severity: "blocking"` with a non-empty `impact`, its file class is not `test`, its per-entry `test_harness` is not `absent`, and the scout reports `test_harness: present`; advisory gaps, `test`-class files and per-item harness-absent gaps never block. Anything else is BLOCK.
7. **Agents**: `reviewer-kit` is the synthesizer: it spawns nothing, holds no `task` tool, and writes the report from the stage results the host supplies. The specialists `review-context-scout`, `review-risk-hunter`, `review-maintainability` and `review-finding-verifier` declare `model: "@task"` and have read-only tools (`read, grep, glob, lsp, bash`).
8. **Outside the gate**: `/slop` (`src/domain/slop-prompt.mjs`, `src/domain/slop-report.mjs`, `agents/slop*.md`) and the range audit (`scripts/audit-range.mjs`, `agents/review-range-auditor.md`) do not run through the native host. The `slop` agents and `review-range-auditor` declare no model. `audit-range.mjs --llm` still launches `omp -p --model ${OMP_REVIEW_KIT_MODEL ?? '@slow'}`, which is a kit-side model pin. It is a known follow-up, not part of the review gate.
9. **Scope of the release**: 0.22.0 removed the verdict cache, delta rounds, context pack, hunter shards, batch gate, run telemetry and records, progress commands, superseded-run stop, pre-review check execution, the rejection envelope, and all model-chain settings. Reports are the only audit trail.

**Contract stage.** `src/native/contract/` settles a producer/consumer pair by calling it, before the model sees the diff. `find.mjs` pairs an exported `write*/serialize*/encode*/toJSON*` with an exported `read*/parse*/decode*/fromJSON*/validate*` in the same changed module and derives the probe arguments from the AST: parameters without a default are filled in, parameters with a default are left to the writer, so the writer's real output is what the reader is judged against. `probe.mjs` runs in a child process on the staged snapshot, calls the writer, feeds the record to the reader and reports the thrown error; `analyze.mjs` writes `.review/contract.json` (`contract@1`) with `status` (`ok`/`contract-violated`/`partial`/`no-pairs`/`failed`/`off`), one entry per pair, unparsed files and unproven work. The verdict blocks on `contract-violated` under policy `block` (`OMP_REVIEW_KIT_CONTRACT`; `off`/`advisory`, default `advisory`), and always on `failed`. A pair is probed only when the writer's required parameters have a domain the name grounds (`id|name|key|…` strings, numeric suffixes, `is*/has*/enabled/…` booleans), when the reader takes the record alone, and when both functions name the same record family (`writeUser`↔`readUser`); everything else is `unproven`. `partial`, `no-pairs` and unparsed modules never block and never read as success; the assignment states which of the two happened.

**Maintainability stage.** `src/native/maintainability/` builds the deterministic candidate file before the native task. `extract.mjs` parses JS/TS through `@babel/parser` and Python through stdlib `ast` in one child interpreter; `group.mjs` keeps maximal parameter groups above the support threshold and excludes `test`-class files, generated paths and oversized signatures; `analyze.mjs` writes `.review/maintainability.json` (`maintainability@1`) inside the snapshot with `status`, `coverage`, `scan`, `unparsedFiles`, `failures` and `groups`. Candidates start in the changed paths, support counts the whole snapshot. Limits are `maxFileBytes` (512 KB), `maxScanFiles` (4 000), `maxScanMs` (5 000 ms) and `maxGroups` (200, the worst case a diff inside the 40-path budget can produce); an exhausted scan sets `truncated` and `supportComplete: false`, and groups beyond the ceiling are counted in `droppedGroups` and make `coverage` `partial` instead of pretending completeness. The agent decides **every** delivered group: a candidate ceiling in the agent would leave the mandatory stage incomplete and block a commit with no finding. `OMP_REVIEW_KIT_MAINTAINABILITY` (`off`/`advisory`/`block`, default `block`) decides only whether the verdict may use the stage's answer. A file the kit cannot parse is `unparsed` and never blocks the commit by itself. `agents/review-maintainability.md` reads the candidates and answers `decision`, `stated_cost`, `priority` and `forwarding_only`; `evaluateReview` blocks only when all four agree, and those items never enter `confirmed_findings` or `confirmed_coverage_gaps`. A group is exempt when its occurrences are one shared module, the consumers that import it, and its contract test (`classifyContractCentralization` in `src/domain/maintainability-centralization.mjs`, applied by group id in `evaluateReview`): that is the shape of one definition with users, not a duplicated design. A consumer whose source cannot be read keeps the group blocking, because the exemption is proven, never assumed. `scripts/measure-maintainability.mjs` reproduces the measurement table of the specification.

**Reuse hints stage.** `src/native/reuse/` answers, deterministically and before the native task, the question a limited context cannot: does this change re-implement code the repository already has. `shape.mjs` turns source into a shape — identifiers become `I`, numbers `N`, strings `S`, keywords and operators stay — and into 5-token shingles; `scan.mjs` collects every function or method with a range, its shape and the calls it names, JS/TS through `@babel/parser` and Python through `ast` in one child interpreter, answering unchanged bytes from a content-addressed cache (`~/.omp/review-kit-cache/reuse`, `OMP_REVIEW_KIT_REUSE_CACHE_DIR`); `index.mjs` narrows pairs with an inverted shingle index, drops shingles common to a tenth of the units as boilerplate, and compares only the distinctive rest, so a renamed copy still matches and a memory of `try/catch` does not. Test-class paths are skipped: a fixture that repeats production code is a property of the suite. `analyze.mjs` writes `.review/reuse.json` (`reuse@1`) and `report.mjs` renders at most 12 hint lines into the assignment. The stage is additive by construction: it adds an input to the review and never removes one, it never enters `evaluateReview`, and it can neither block nor pass a commit. `OMP_REVIEW_KIT_REUSE` (`off`/`advisory`, default `advisory`) is the only switch. A truncated or failed scan is stated as such in the assignment and in `### Notes`; the assignment never claims that no duplicate exists. `scripts/measure-reuse-index.mjs` reproduces the measurement table (synthetic renamed/reformatted copies, the pairs this repository produces, cold and warm scan cost).

`scripts/release-preflight.mjs` is the release check that runs before any review: version sources and the dated changelog heading, every mutant anchor matching its target exactly once, selector staleness by hash, the layout check and the suite. It refuses a recalibration while the diff is not frozen, because a review that is still changing the diff invalidates every selector it would prove. `scripts/run-review.mjs` is the distributable launcher installed with the plugin. `templates/review-kit/run-review.mjs` is the stub every repository vendors; it is never edited, and `scripts/check-layout.mjs` enforces that the vendored copy is byte-identical, and the required-file list it checks lives in `src/infra/layout-required.mjs`. `src/index.mjs` exports the native review functions and the installer.

## Key Directories

- `src/native/`: the native review (`native-host.mjs`, `native-review.mjs`, `task-engine.mjs`, `snapshot.mjs`, `assignment.mjs`, `verdict.mjs`).
- `src/application/`: `installer-service.mjs`.
- `src/domain/`: value and policy modules (`diff-identity.mjs`, `file-class.mjs`, `hook-template.mjs`, `hook-shim.mjs`, `git-commit-command.mjs`, `runner-version.mjs`, `target-policy.mjs`, `suspicion-map.mjs`, `prompt-token.mjs`, `slop-*.mjs`).
- `src/infra/`: `repo-identity.mjs` (the one repository identity: real path, folded per platform), `registration-record.mjs` (the persisted session registration, one writer and one reader), `review-run-store.mjs`, `filesystem-report-store-adapter.mjs`, `target-registry.mjs`, `vendored-kit-files.mjs`, `process-tree.mjs`.
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

- **When the gate runs:** once per release, on the frozen diff, after the review's `REVIEW_RESULT=PASS`. A review round that still has open findings is not a reason to recalibrate: the diff is about to change, and every edit to a deciding test, a mutant target or the catalog invalidates the proof. The preflight refuses `--recalibrate` (the flag is implicit: recalibration always requires it) while an unstaged change or an untracked file is present: the staged release is the diff under review, but a half-applied finding is not. The reports folder and the gate's own selector catalog never count as pending.
- **A passed run is stored, not repeated.** `scripts/release-preflight.mjs` writes a certificate (`~/.omp/review-kit-mutation/<digest>.json`, `OMP_REVIEW_KIT_MUTATION_CERT_DIR` overrides) keyed by the content hash of the whole working tree plus the gate fingerprint, and scoped to the Node version and platform the proof was measured on. A second preflight on the same bytes answers in milliseconds with `mutation certificate - N/N mutants proved …` and runs nothing. The certificate is evidence only: it can skip a repeat run, never change a verdict, and a failed write is fail-open.
- **CI does not run the gate.** GitHub Actions cannot see a local certificate, so a CI run would re-run the whole catalog for nothing; the gate is local-only (`npm run test:mutation` and the preflight).

- Removing a temporary tree always retries (`removeTree`, `REMOVE_OPTIONS`). A plain `rm` with `recursive` on a tree is a defect, not a flake.
- Every proof is persisted at once (`onProven`). A run that dies keeps what it proved.
- Infrastructure errors (timeout, crash, cleanup failure, zero selected tests, a red suite on the pristine tree) are never kills. Fix the cause and rerun; do not rerun blindly.
- After editing a mutant's target file, check that each `original` still matches exactly once before a long run.
- After editing a deciding test or a mutant, the selector is stale. Run `--calibrate-stale`; do not carry an old green result over to changed bytes.
- Verify on an export of the index: stage the paths first, because `checkout-index` reads the index, not the working tree.
- Run the gate in the background with a log file. Measure the time from the log; do not promise a duration.
- Never commit `audit-reports/mutation-result*`.

CI runs Node 22 and 24 on Ubuntu and Windows (Bun 1.4.1, `bun install --frozen-lockfile`); it does not run the mutation gate. Node 18 and 20 are not in CI and are not verified for this release.

Releases follow `.claude/skills/release-and-deliver/SKILL.md`. Read it before any release step.
