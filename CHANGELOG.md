# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
