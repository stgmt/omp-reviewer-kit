# Roadmap: OMP Review Kit

This roadmap defines the engineering direction and release milestones for `omp-reviewer-kit`. It codifies the evidence-first, reality-first review methodology and establishes clear delivery boundaries across each phase.

---

## Phase 1: Fail-Closed Staged Review Gate (Completed)

Deliver an automated, fail-closed pre-commit gate that prevents unreviewed or violating code from entering Git history.

- [x] **Repository & Identities**: Fixed public plugin `omp-reviewer-kit`, OMP task-agent `reviewer-kit`, and core methodology `reality-first-review`.
- [x] **Agent Specification**: Headless `@slow` model agent strictly confined to read-only inspection (`read, grep, glob, lsp, bash`) with forbidden mutation.
- [x] **Methodology Skill**: 16 reality-first rules, structured finding format (P1/P2/P3), and dynamic project skill composition without manual directory scans.
- [x] **Domain Architecture (OOP / DDD / SOLID)**:
  - `DiffIdentity`: Deterministic SHA-256 hashing and staged isolation.
  - `ReviewVerdict`: Strict binary verdict parsing (`PASS` vs `BLOCK`) enforcing fail-closed invariants.
  - `ReviewPrompt`: Immutable prompt specification for the headless review dispatcher.
  - `ReviewReport`: Immutable markdown audit trail stored at `audit-reports/commit-reviews/<timestamp>-<hash>.md`.
  - `ReviewWorkflowService`: Orchestrator decoupled from transports via `GitPort`, `ReviewerPort`, and `ReportStorePort`.
- [x] **Self-Contained Runner**: Single-file distributable runner in `scripts/run-review.mjs` synchronized with `.omp/review-kit/run-review.mjs`.
- [x] **Platform Installers**: Symmetrical Windows (`install-hook.ps1`) and POSIX (`install-hook.sh`) installers configuring repository-local `core.hooksPath .githooks`.
- [x] **BDD & E2E Testing**: Comprehensive test suite covering domain units, BDD scenarios, and real Git pre-commit hook executions.

---

## Phase 2: Autonomous Agent Correction Loop (Feedback Loop)

Close the loop between code generation and review rejection. When a commit is blocked, the triggering AI agent should autonomously read the audit report and fix the defect.

- [ ] **Machine-Readable Failure Envelope**: Emit a structured JSON-compatible rejection payload alongside the human-readable report.
- [ ] **Agent Context Re-injection**: Provide a standardized protocol for OMP agents to parse rejected commit findings and locate the exact file lines requiring correction.
- [ ] **Automatic Retry Policy**: Enable bounded auto-remediation (e.g., up to 3 automated fix attempts) before escalating to the developer.

---

## Phase 3: Review Replay & Model Benchmarking

Enable empirical evaluation and historical auditing of code review quality.

- [ ] **Context Snapshot Persistence**: Store sanitized input context and loaded project skill metadata alongside each audit report.
- [ ] **Review Replay CLI**: Command to replay historical staged diffs against alternative models (e.g., Claude 3.7 Sonnet vs GPT-4o vs Qwen 2.5) without Git repository mutations.
- [ ] **Rigor & Noise Benchmarks**: Automated metrics calculating false positive rates, missed P1 defect detection, and verdict consistency across model versions.

---

## Phase 4: Native OMP Extensibility

Deepen integration with the Oh My Pi harness beyond Git hooks.

- [ ] **Pre-Tool-Use Hook Interceptor**: Intercept `bash` or `git commit` commands within active OMP sessions to reject violating changes before subprocess invocation.
- [ ] **Interactive `/review-staged` Command**: Provide an on-demand OMP command for interactive reviews before deciding to commit.
- [ ] **Status Bar Integration**: Visual indicator in OMP UI showing review status of the currently staged diff.

---

## Phase 5: CI/CD & Ecosystem Release

Scale verification across platforms and establish verified distribution.

- [x] **Cross-Platform CI**: Automated GitHub Actions matrix testing Node.js on Ubuntu and Windows.
- [ ] **Automated Release Packaging**: Semantic release automation with GitHub Release asset digests and provenance.
- [ ] **Marketplace Registry Verification**: Automated validation against Claude Code and OMP marketplace schemas.
