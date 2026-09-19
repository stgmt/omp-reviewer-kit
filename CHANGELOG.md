# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.12.0] - 2026-09-19

### Added
- **Coverage-required gate**: changed executable behavior without a covering test now blocks the commit via a new `coverage_required` envelope kind (`review-rejection-envelope@1`) carrying `coverage_items` — each gap names the concrete tests the committer must add: at least one `edge` test per new boundary/default/error path and at least one `mutation` test naming the staged-lines mutant it kills. The scout emits `coverage_map` + `test_harness`, the correctness hunter emits `coverage_gaps`, the verifier confirms `confirmed_coverage_gaps`, and the orchestrator reports them under `### Required test coverage`. Gaps never block when the repository has no runnable test harness (recorded under `### Notes`); confirmed findings take precedence over coverage items when both exist.
- **Native `/slop` adversarial audit**: the slop 2-in-1 audit (parasitic architecture, spec slop, dead checks) is now a first-class review-kit command instead of a user-saved dynamic-workflows script. Three declared agents — `slop` orchestrator (`@slow`, spawns allowlist) → `slop-scout` candidate discovery (`@smol`) → `slop-verifier` adversarial challenge (`@slow`, Anti-Noise Gate + "can it turn red" + grounding filters) — run on the native task tool with `autoloadSkills: [slop]`; `SlopPrompt` builds the `/slop` dispatcher prompt and `SlopReport` renders the `VERDICT:` report in the skill://slop Part V format. Fail-closed: a failed scout/verifier stage emits `VERDICT: ERROR`, never `CLEAN`. Removes the omp-dynamic-workflows dependency and its `thinking.ts` disk-load failure mode.

## [0.11.6] - 2026-09-18

### Fixed
- **O(N) git spawns per commit**: `getSnapshot` ran one `git cat-file` child per tracked file (~20-45ms each — minutes on large indexes, pushing users to `--no-verify`). Now a single `git cat-file --batch` stream reads every blob; `defaultRunner` accepts an optional stdin buffer.
- **Forged verdict markers**: `ReviewVerdict.fromOutput` accepted a `REVIEW_RESULT=PASS` line anywhere in output, and staged content is quoted verbatim into the reviewer report — a planted marker could pass the gate. The marker must now be the last non-empty line; non-terminal markers degrade to `missing_verdict_marker` (fail closed). Envelope pairing uses `lastIndexOf` for the BLOCK line. Prompt and agent contracts updated to require the terminal marker.
- **Provider-refusal retry after marker+stderr noise**: `isModelProviderFailure` now keys on marker *presence* (not verdict validity) before consulting refusal text, so a BLOCK followed by trailing stderr noise is still verdict-shaped and never retried; a `review_failure` envelope with refusal text still retries.

## [0.11.5] - 2026-09-18

### Fixed
- **Quota-stall watchdog never armed after first stdout**: `armQuotaStall` refused to arm once any stdout existed, so a mid-run provider refusal (detected via the child OMP log poller) after any banner left the commit hook hanging forever. The guard is removed; the stall timer is cleared by each stdout chunk, so arming while stdout flows is harmless.
- **Provider-refusal BLOCK never retried**: `isModelProviderFailure` returned `false` on any verdict marker before checking for a provider refusal, so a dispatch failure wrapped in a synthetic `review_failure` BLOCK was treated as a completed review and never fell back. Now a `review_failure` envelope carrying refusal text retries; a `confirmed_findings` BLOCK quoting refusal text still counts as a real verdict.
- **CRLF verdict lines rejected**: `REVIEW_RESULT=(PASS|BLOCK)$` did not match `\r\n` endings, so a reviewer printing CRLF produced `missing_verdict_marker` instead of a verdict.
- **`getHeadFile` swallowed real git errors**: every `cat-file` failure returned `null` ("new file"), silently dropping files from the red-proof reverted snapshot. Only absent-blob errors return `null` now; other failures propagate and skip the reverted run.
- **Signal-killed test commands reported exit 0**: `exitCode ?? (timedOut ? 1 : 0)` mapped a signal death to success. Now `exitCode ?? 1`.
- **Timed-out executions unmarked in the prompt**: staged/reverted evidence lines now carry ` (timed out)` so the reviewer does not read a killed run as a clean pass/fail.
- **Staged executable bit lost in snapshots**: `materialize` now `chmod 0o755`s files staged with mode `100755` (POSIX; no-op on Windows), so test commands that exec staged scripts behave like the real index.
- **Snapshot dirs leaked on SIGINT/SIGTERM**: the signal guard exited before the `finally` cleanup ran. It now accepts a `cleanup` callback raced with the telemetry timeout; the workflow service registers live snapshot dirs for removal.

## [0.11.4] - 2026-09-18

### Fixed
- **Diff path extraction rewritten**: paths now come from each block's `rename from/to`, `copy from/to`, and `---`/`+++` lines (single-path, unambiguous), with the `diff --git` header as last resort for mode-only blocks. The previous header split corrupted paths containing spaces or the literal ` b/` substring.

## [0.11.3] - 2026-09-18

### Fixed
- **Space-containing paths in diff headers**: `diff --git a/<old> b/<new>` headers are now split on the first ` b/` boundary instead of whitespace tokens, so staged paths with spaces no longer corrupt `changed-files.txt`, the dispatcher path list, and the red-proof reverted snapshot.
- **Quota-stall log poller disabled by any stdout**: the poller skipped every tick once the child printed anything, so a mid-run provider 429 (logged only to the child OMP log) after a banner left the commit hook hanging forever. The poller now stays live and only defers while stdout was seen within the last `quotaStallMs` window.
- **`OMP_REVIEW_KIT_EXECUTE_TIMEOUT_MS` parsing**: `Number(...) || 600000` mapped `0`/invalid to the 10-minute default and let negatives arm an unbounded run. Now uses `configuredInteger(..., 0)`: `0` disables, negatives/invalid fall back to 600000.

## [0.11.2] - 2026-09-18

### Fixed
- **Truncated task report recovery**: when the reviewer-kit task result is truncated and its `agent://` URI is unreadable (headless `omp -p` sessions have no artifacts directory), the dispatcher now reads the durable copy the orchestrator writes to `<snapshot>/.review/report.md` before yielding, instead of emitting a review_failure BLOCK on a completed review.

## [0.11.1] - 2026-09-18

### Fixed
- **Chained hook root resolution**: the deployed `.githooks/pre-commit.d/00-omp-reviewer-kit.chain` resolved the repo root as `$hook_dir/..` (= `.githooks`), so `node $root/.omp/review-kit/run-review.mjs` failed with MODULE_NOT_FOUND and fail-closed blocked every commit on adopted repos. Now resolves `$hook_dir/../..`. Covered by a functional test that executes the deployed chain script under a real POSIX shell.

## [0.11.0] - 2026-09-18

### Added
- **Chained pre-commit hook adoption**: when `.githooks/pre-commit` is a foreign hook that invokes the owned entry `.githooks/pre-commit.d/00-omp-reviewer-kit.chain` (literal call or `for`-loop over `pre-commit.d/*`), the installer no longer reports a conflict. It deploys the owned chain entry (execs the review runner) and repairs it on drift, leaving the foreign hook byte-identical. Foreign hooks calling a different entry name or lacking the marker still fail closed as `conflict`. Status reports `hookChained`/`chainedHookPresent`/`chainedHookCurrent`/`chainedHookExecutable` and the status command shows `OK (chained)` only when the entry is present and current.
- **Quota-stall watchdog with outer-chain retry**: when a provider refusal appears in child stderr or the child OMP log tail and no stdout follows within `OMP_REVIEW_KIT_QUOTA_STALL_MS` (default 300000, `0` disables), the runner kills the tree and the attempt classifies as provider failure, so the outer chain starts a fresh session on the next model. stdout progress cancels the watchdog; probes and re-emit passes never arm it. Mid-run 429s (which OMP logs but does not print) are caught via the pid-keyed log tail; the stall marker alone classifies even when accumulated output carries no refusal text.
- **Opt-in child-side review bound via `omp --max-time`**: `OMP_REVIEW_KIT_MAX_TIME` (default off) is forwarded to every full review attempt as a backstop for non-quota stalls. Expiry surfaces as exit-0-with-empty-stdout and flows through the existing missing-marker path fail-closed. The pinned no-runner-timeout contract is intact: with both knobs at defaults the plugin never kills a working child.
- **`stalledOnQuota` / `timedOut` attempt telemetry**: stall kills and max-time hits are flagged in `review_attempt_finished`, and the effective bounds are recorded in `review_chain`, so quota stalls are distinguishable from model-returned-empty.

## [0.10.0] - 2026-09-15

### Added
- **`skill://slop` vendored doctrine**: adversarial architecture, code, and specification audit skill covering parasitic meta-infrastructure detection, spec slop and integrity review, a standalone `VERDICT` report format, and a hook scoping guard restricting the standalone `VERDICT` format to standalone audits (hook reviews keep the `REVIEW_RESULT` contract).

### Fixed
- **Rejection-envelope validator misclassified reviewer failure envelopes**: `scripts/run-review.mjs` required `failure.message` to equal the canned `FAILURE_MESSAGES` string, while the dispatcher contract (`src/domain/review-prompt.mjs`, `agents/reviewer-kit.md`) specifies a non-empty diagnostic. Reviewer-emitted `review_failure` envelopes with descriptive messages were normalized to `malformed_rejection_envelope`, hiding the real failure. The runner now accepts any non-empty message, matching `src/domain/review-rejection-envelope.mjs`.
- **Verdict-marker line splitting tolerated fewer line terminators than the verdict regex**: `ReviewVerdict.fromOutput` accepts `REVIEW_RESULT=BLOCK` followed by a bare `\r` (or U+2028/U+2029), but the envelope evaluator split only on `\r?\n`, so a CR-terminated marker was never found and a valid envelope was reported as malformed. Both copies now split on `/\r\n|[\n\r\u2028\u2029]/`.
- **Live E2E matrix environment**: isolated test profiles now relax `artifactSpillThreshold` and route the review through a session-persistent OMP wrapper (`OMP_REVIEW_KIT_OMP` shim stripping `--no-session`), so `agent://` handles for truncated task-result previews resolve instead of collapsing into fallback `review_failure` envelopes. The default evidence-wording regex also accepts equivalent failure-semantics phrasings (`true by construction`, `red_proof`, `cannot fail`, `vacuous`, `unexercised`, `no test coverage`, `not product`).

## [0.9.0] - 2026-09-15

### Added
- **Anti-neuroslop review contracts**: hardened review prompts and agent contracts based on adversarial review methodology:
  - Six neuroslop forms codified in `skill://reality-first-review` and `skill://multi-stage-review`.
  - The "red question" ("what would have to break for this check to fail?") and vacuum checklist for every staged assertion.
  - The "self-tool rule": queries with zero matches prove nothing without positive controls.
  - `review-context-scout` extracts verifiable `claims` and `declared_checks` from staged content.
  - `review-risk-hunter` performs a mandatory Neuroslop Pass on the correctness lane, producing a `red_proof` candidate field.
  - `review-finding-verifier` adds Neuroslop confirmation, Self-tool audit, and `triage` classification (`lie`, `stale_record`, `disclosed_gap`).
  - `### Notes` report section for non-blocking observations that never interfere with `PASS`.
  - Measurable `### Verified-OK` section requiring concrete counts, paths, and positive controls (bare "looks correct" prohibited).
- **Deterministic suspicion map**: automatically computed from the staged diff by analyzing assert line deltas, deleted test files, and removed test declarations in test files (`src/domain/suspicion-map.mjs`).
- **Opt-in test execution evidence**: optional pre-review check execution (`OMP_REVIEW_KIT_EXECUTE=1`) and red-proof reverted snapshot execution (`OMP_REVIEW_KIT_RED_PROOF=1`) with 2×2 interpretation matrix passed to review agents.
- **Commit-range audit CLI**: `node scripts/audit-range.mjs <base>..<head>` for auditing entire commit ranges for stealth test weakening, deleted assertions, and vacuous checks, with optional LLM exploration via new agent `review-range-auditor` and `skill://range-audit`.

### Changed
- Dispatcher prompt now carries the deterministic suspicion map and optional execution evidence.
- Environment variables added: `OMP_REVIEW_KIT_ASSERT_PATTERNS`, `OMP_REVIEW_KIT_TEST_PATH_PATTERNS`, `OMP_REVIEW_KIT_EXECUTE`, `OMP_REVIEW_KIT_EXECUTE_COMMAND`, `OMP_REVIEW_KIT_EXECUTE_TIMEOUT_MS`, `OMP_REVIEW_KIT_EXECUTE_LINK_DIRS`, `OMP_REVIEW_KIT_RED_PROOF`.
- Extension status bar reflects the `executing: 'running project checks'` lifecycle phase.

## [0.8.0] - 2026-09-15

### Added
- **Verbatim re-emit recovery on missing marker**: when the reviewer output ends without a verdict marker, the adapter issues one bounded no-tools re-prompt asking the model to re-emit its previous answer verbatim, then re-evaluates the full envelope on the recovered output. `OMP_REVIEW_KIT_REEMIT=0` disables the recovery pass.
- **Run signal guard**: `RunSignalGuard` (`src/infra/run-signal-guard.mjs`) records `run_failed`/`interrupted` telemetry when the review process is terminated by a signal, so interrupted runs no longer vanish silently from `runs.jsonl`/`last-run.json`.
- **Stale-reviewing liveness reconcile in status**: `/reviewer-kit:status` reconciles a persisted `reviewing` state against the live child PID and reports it as stale when the recorded process is gone.
- **Dispatcher prompt hardening**: the dispatcher prompt now explicitly forbids wrapping the verdict in JSON and states that the verdict contract takes precedence over conflicting output instructions.

### Fixed
- **stderr `Working...` progress noise**: spinner/progress lines emitted on stderr are stripped from combined output and from stored audit reports instead of leaking into parsed review text.
- **CRLF normalization**: reviewer output is normalized to LF before marker/envelope parsing so Windows line endings no longer corrupt verdict detection.

## [0.7.1] - 2026-09-13

### Fixed
- **Telemetry `effortOverride` honesty**: `review_chain.effortOverride` now records the effective default (`"low"`) when `OMP_REVIEW_KIT_EFFORT` is unset, instead of `null`. Previously the chain-level field reported "no override" even though `applyEffortOverride` applied `low` and the attempt-level resolved model carried `:low` — the field lied about the actual effort used. Verified end-to-end: a seeded-defect run (3 known bugs in a 473-byte diff) found all 3 confirmed findings in 1.8 min on `gemini-3.8-flash:low`, with `effortOverride: "low"` in telemetry.

## [0.7.0] - 2026-09-13

### Changed
- **Default effort is now `low`**: `OMP_REVIEW_KIT_EFFORT` defaults to `low` instead of preserving the configured effort suffix. This halves thinking-block latency on gemini-flash (30–60s → ~15–30s per response). Set `OMP_REVIEW_KIT_EFFORT=high` or `=max` for complex diffs requiring deeper analysis.
- **Scout receives changed paths in prompt**: `ReviewPrompt.forDiff` now inlines `diff.changedPaths` into the dispatcher prompt, and the orchestrator passes them to the scout's task text. The scout no longer reads `.review/changed-files.txt` separately when paths are provided — eliminating redundant inventory tool calls (~3–6 min → ~2 min scout stage).
- **Adaptive hunter budget**: the orchestrator reads scout output and sets the hunter tool-call budget adaptively — ≤5 changed paths and ≤3 relevant consumers → ~15 calls, otherwise ~30. Hunters receive the budget in their task text instead of a fixed ~30.
- **Scout decoupled from `--smol` pin**: the CLI no longer passes `--smol` to pin the smol role to the selected reviewer model. The scout (`model: "@smol"`) resolves to the user's configured `@smol` role (e.g. antigravity) independently of `OMP_REVIEW_KIT_MODEL`, so when the reviewer runs on `@task`→swe-2, the scout still rides the fast `@smol` model.

### Fixed
- `applyEffortOverride` now applies a default `low` effort even when `OMP_REVIEW_KIT_EFFORT` is unset, ensuring consistent effort across probes and attempts without requiring explicit configuration.

## [0.6.0] - 2026-09-13

### Added
- **Review Run Telemetry**: `TelemetryPort`/`FileSystemTelemetryAdapter` persists append-only `audit-reports/commit-reviews/runs.jsonl` events (`review-run-event@1`) — run start/skip/finish, diff identity, snapshot size, per-attempt and per-probe model/PID/status/duration/provider-failure, verdict, report path, and OMP log hints — plus a throttled `last-run.json` live-state channel (`review-last-run@1`) updated during active reviews. `OMP_REVIEW_KIT_TELEMETRY=0` disables writes; telemetry failures never change the verdict.
- **Run Analyzer**: `scripts/analyze-review-run.mjs` (`npm run analyze-review`) correlates a run with `~/.omp/logs/omp.<date>.<pid>.log` by child PID (or time window for `.cmd` wrappers) and reports request counts, models used, context growth, per-stage subagent timing, and provider-error classes.
- **Incident Playbook**: `.devin/skills/omp-review-incidents/SKILL.md` documents telemetry/log locations, PID and time-window correlation, failure signatures, and reporting hygiene.
- **Live Status Fallback**: the extension polls `last-run.json` while a `git commit` tool call is active, and `/reviewer-kit:status` reports persisted run telemetry via `installer.status().lastRun`.
- **Materialized Review Inputs**: the staged snapshot now carries `.review/diff.patch` (the complete staged diff, byte-exact) and `.review/changed-files.txt` (the changed-file manifest parsed from `diff --git` headers). The dispatcher prompt names both artifacts and every agent contract instructs reading the diff as a file instead of re-deriving it with `git diff`/`git show` — measured runs showed ~76% of hunter tool calls were diff/staging plumbing.
- **`OMP_REVIEW_KIT_EFFORT`**: rewrites the `:effort` suffix of every resolved `provider/model[:effort]` selector (appends when absent), applied consistently to availability probes and review attempts and recorded as `effortOverride` in the `review_chain` telemetry event.
- **Soft tool-call budgets** in agent contracts: scout ~20, risk-hunter ~30 per lane, verifier ~20 calls — focuses verification on diff-touched symbols and deciding callers.
- A staged path under `.review/` fails loudly as a reserved snapshot-artifacts directory collision.

### Changed
- **Default model chain is now `@smol → @task`**: the primary model defaults to the `@smol` role instead of `@slow`, and the only default fallback is the `@task` role. `OMP_REVIEW_KIT_MODEL`/`OMP_REVIEW_KIT_FALLBACK_MODELS`/`OMP_REVIEW_KIT_MAX_FALLBACKS` still override. Automatic `omp models --json` catalog probing is removed from the default path.
- `review-context-scout` now declares `model: "@smol"` so it rides the same pinned reviewer model as the rest of the fleet; previously `@task` bypassed the `--slow`/`--smol` role pinning.

### Fixed
- A total provider outage now emits an actionable infrastructure-failure message (models attempted, how to repoint `modelRoles.smol`/`modelRoles.task`, telemetry location) instead of a bare report path.
- **Verdict-emission contract failures** (7 of 16 historical reports ended `review_failure` without findings): all four agents now must return their complete result through the `yield` tool's data payload — never an empty `yield` or a bare closing message (OMP drops those results with `yield with null data`). The dispatcher prompt gains a deterministic fallback: when the task fails, returns empty, or its `agent://` URI is unreadable, it emits a `review_failure` envelope naming the observed error instead of summarizing — so the audit report keeps the real diagnostic instead of a bare `missing_verdict_marker`. The orchestrator contract also states the rejection envelope is exactly one JSON object, never YAML/prose (recurring `malformed_rejection_envelope` mode).
- **Multi-envelope output resilience**: `ReviewRejectionEnvelope.evaluate` no longer rejects a BLOCK verdict when an earlier `<task-result>` embeds its own envelope pair — the marker-adjacent pair is parsed and validated, and only a marker-adjacent malformed payload falls back to `malformed_rejection_envelope`. `failure.message` also accepts any non-empty diagnostic (previously it had to equal the canonical text exactly, which misclassified the dispatcher's named-error fallback as malformed on v0.4.0 runners).
- **Non-ASCII path handling**: `DiffIdentity.changedPaths` now decodes Git's octal-escaped quoted paths (`core.quotepath` default) instead of using `JSON.parse`, which threw `SyntaxError` on non-ASCII filenames (e.g. `café.js`, `руководство.md`) and permanently blocked commits.
- **Submodule gitlink safety**: `SubprocessGitAdapter.getSnapshot` now skips gitlink index entries (mode 160000) instead of running `git cat-file blob` on a commit SHA, which exited 128 and blocked all commits in repositories containing submodules.
- **Case-insensitive `.review` collision**: `FileSystemSnapshotAdapter.materialize` now normalizes staged paths (lowercase + backslash-to-slash) before checking the reserved `.review/` directory, preventing case-variant collisions (`.Review`) from bypassing the check on Windows/macOS.

## [0.5.0] - 2026-09-10

### Added
- **Staged Index Snapshot**: Materializes the exact staged file bytes into a temporary read-only review source, keeping the real repository available for Git metadata and OMP discovery.
- **Two-Lane Correctness Guidance**: Requires correctness and security risk lanes, focused test evidence, and bounded YAGNI checks without adding a new rejection category.
- **Verified-OK Report Section**: Records paths, tests, caller checks, and invariants actually verified during the review.

### Fixed
- Snapshot materialization no longer adds generated metadata or allows unstaged worktree content to replace staged files.

## [0.4.0] - 2026-09-07

### Added
- **Anti-Parasitic Correctness Gate**: The existing correctness hunter now blocks duplicated control infrastructure only when both an available native mechanism and zero product capability are proven; justified Port/Adapter, Template Method, public CLI, and remote-trust cryptography remain allowed.
- **Live Architecture Matrix**: Real named-profile OMP commits cover five parasitic designs and three justified OOP/DDD controls.
- **Immutable Release Pipeline**: Tagged archives, checksums, release identity, and GitHub provenance attestations are verified before publication and on idempotent reruns.

### Fixed
- Strict rejection parsing now rejects prototype-key extras at every envelope depth.
- Automatic setup refuses to activate unrelated Git hooks already stored in `.githooks`.
- Headless dispatch uses the native task schema without unsupported model/schema overrides and retrieves truncated task artifacts before relaying a complete rejection envelope.
- Auto-installed hooks derive the repository from their own trusted path instead of executing a working-directory-resolved Git binary.
- Public review results preserve concrete failure details for caller-owned repair.
- POSIX catalog and availability-probe timeouts escalate from `SIGTERM` to `SIGKILL` and observe process exit.
- Strict rejection parsing requires the envelope end immediately before the solitary BLOCK verdict.
- Existing-release reruns require the exact three-asset set and compare persisted commit, package-tree, and archive identity.
- Large staged diffs no longer fail the hook with ENOBUFS: the Git runner streams `git diff` via async `spawn` instead of buffer-capped `spawnSync`.
- Hook infrastructure failures now report `reviewer-kit INFRA_ERROR` instead of masquerading as a verdict `BLOCK`, while remaining fail-closed.
- POSIX escalation test records the fake reviewer PID with `$$` (a lone `$` followed by a double-quote expands to a literal dollar in POSIX sh, yielding NaN).

## [0.3.0] - 2026-09-06

### Added
- **Caller-Owned Rejection Envelope**: BLOCK reports now carry a strict `review-rejection-envelope@1` with validated diff identity, P1/P2 findings, fixed failure codes, and one report pointer.
- **Automatic Hook Setup**: Session startup configures the repository hook in the background while retaining the manual setup command as a fallback.
- **Provider Model Fallback**: Review execution now retries quota, rate-limit, authentication, and model-capacity failures with models that pass a short no-tools availability probe from explicit configuration or the installed OMP catalog, while preserving fail-closed behavior for real verdicts, timeouts, and an exhausted model list.
- **Fallback Evidence**: Audit reports and execution results record the reviewer models attempted.
- **Live Commit Review Progress**: The Git hook emits observable progress and model-response states in the OMP status bar and streamed command output without starting another agent turn.

### Changed
- **Review Time Budgets**: Full reviews have no timeout and are never cancelled by this plugin. Availability probes remain bounded at 60 seconds by default.
- **BLOCK Output Boundary**: After progress lines, rejected commits end with only the report path and `REVIEW_REJECTION_REPORT` pointer; raw model output remains in the audit report.

## [0.2.0] - 2026-09-04

### Added
- **Multi-Stage Orchestrator**: Transformed `reviewer-kit` into a multi-stage review orchestrator coordinating context discovery, parallel risk hunting, adversarial verification, and local synthesis.
- **Specialist Subagents**:
  - `review-context-scout` (`@task`, `blocking: true`): Discovers diff blast radius, touched files, callers/consumers via LSP/grep, invariants, and existing test coverage without judging code.
  - `review-risk-hunter` (`@slow`, `blocking: true`): Evaluates staged diffs in parallel `correctness` and `security` lanes under strict anti-noise prohibitions (no comments, formatting, or ungrounded advice).
  - `review-finding-verifier` (`@slow`, `blocking: true`): Adversarial defense lawyer agent challenging candidate defects against upstream caller protections, framework middleware, and reachability.
- **Review Protocol Skill**: Added `skills/multi-stage-review/SKILL.md` specifying stage ordering, candidate finding schemas, anti-noise rules, and report synthesis contracts.
- **Adversarial Noise Filter**: Eliminated false-positive suggestions by requiring concrete reachability and rejecting pre-existing defects, stylistic nitpicks, and ungrounded advice.
- **Fail-Closed Stage Protection**: Any missing, failed, timed-out, or unparseable mandatory stage fails closed with a stage-specific diagnostic and `REVIEW_RESULT=BLOCK`.
- **Extended Review Timeout**: Increased default timeout to 10 minutes (`600_000ms`) to accommodate multi-stage agent workflows.
- **Dependency-Free Mutation Testing**: Added `scripts/run-mutation-tests.mjs` providing a zero-dependency mutation gate verifying safety invariants across modular and distributable runners.
- **Opt-in Real OMP E2E Verification**: Added portable real-model E2E test suite (`tests/live-e2e-omp.test.mjs`) testing clean and violating diff fixtures with native OMP CLI.

### Changed
- **`skills/reality-first-review/SKILL.md`**: Delegated execution stage sequencing to `multi-stage-review` while preserving all 16 review rules and dynamic project skill discovery.
- **`src/domain/review-prompt.mjs`**: Updated dispatch prompt to require the multi-stage review protocol and removed obsolete prohibition on child subagents.
- **Layout Validator**: Updated `scripts/check-layout.mjs` to enforce presence of all 4 agent definitions and both review skills.
- **Package Metadata**: Bumped version to `0.2.0` across `package.json` and `.omp-plugin/marketplace.json`.

## [0.1.0] - 2026-09-04

### Added
- **Core Agent**: Introduced headless OMP review task-agent `reviewer-kit` running on `@slow` model with strictly read-only capabilities (`read, grep, glob, lsp, bash`).
- **Methodology Skill**: Defined `reality-first-review` skill codifying 16 reality-first engineering principles, structured finding classification (P1/P2/P3), and dynamic project skill discovery.
- **Domain Architecture (DDD / OOP)**:
  - `DiffIdentity`: Value object providing deterministic SHA-256 diff hashing and staged change isolation.
  - `ReviewVerdict`: Value object enforcing binary `PASS` vs `BLOCK` verdict parsing and fail-closed handling of malformed or multiple markers.
  - `ReviewPrompt`: Domain specification for headless dispatcher instructions.
  - `ReviewReport`: Domain entity formatting immutable markdown audit reports under `audit-reports/commit-reviews/`.
  - `ReviewExecutionResult`: Value object representing the outcome of review executions.
- **Application & Ports (SOLID)**:
  - `ReviewWorkflowService`: Decoupled orchestrator coordinating Git, reviewer, and report storage ports.
  - `SubprocessGitAdapter`, `OmpCliReviewerAdapter`, `FileSystemReportStoreAdapter`: Concrete infrastructure adapters.
- **Pre-commit Runner**: Zero-dependency runner script `scripts/run-review.mjs` synchronized with self-hosted copy `.omp/review-kit/run-review.mjs`.
- **Cross-Platform Installers**:
  - `scripts/install-hook.sh`: POSIX shell installer for Linux and macOS.
  - `scripts/install-hook.ps1`: PowerShell installer for Windows.
- **Testing & Verification**:
  - Unit and integration tests covering diff hashing, verdict parsing, and report writing.
  - BDD scenario suite (`tests/bdd-scenarios.test.mjs`) testing all observable review outcomes.
  - Real Git pre-commit hook E2E suite (`tests/e2e-git-hook.test.mjs`) exercising actual `git commit` invocations.
- **Governance & Documentation**:
  - Repository Guidelines in `AGENTS.md`.
  - Engineering Roadmap across 5 phases in `ROADMAP.md`.
  - Marketplace metadata in `.omp-plugin/marketplace.json`.
