# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
