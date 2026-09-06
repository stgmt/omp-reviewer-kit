# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
