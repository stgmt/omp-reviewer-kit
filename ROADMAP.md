# Roadmap: OMP Review Kit

This roadmap defines the engineering direction and release milestones for `omp-reviewer-kit`. It codifies the evidence-first, reality-first review methodology and establishes clear delivery boundaries across each phase.

---

## Phase 1: Fail-Closed Staged Review Gate (Completed - v0.1.0)

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

## Phase 2: Multi-Stage Orchestrated Review & Adversarial Verification (Completed - v0.2.0)

Replace the single-pass reviewer with a repository-native 4-stage hierarchy to achieve high precision and suppress review noise.

- [x] **Multi-Stage Orchestration (`reviewer-kit`)**: Non-mutating orchestrator coordinating context discovery, parallel risk hunting, adversarial verification, and local verdict synthesis.
- [x] **Context Scout Specialist (`review-context-scout`)**: Read-only specialist mapping blast radius, touched files, callers/consumers via LSP/grep, invariants, and test coverage.
- [x] **Parallel Risk Hunters (`review-risk-hunter`)**: Parameterized specialist running concurrent correctness and security evaluations with strict anti-noise prohibitions (no comments, formatting, or ungrounded advice).
- [x] **Adversarial Verifier (`review-finding-verifier`)**: Defense lawyer agent challenging candidate defects against upstream caller defenses, concrete trigger reachability, and mitigations.
- [x] **Protocol Skill (`multi-stage-review`)**: Codified stage sequencing, candidate finding schemas, anti-noise rules, and report synthesis contracts.
- [x] **Fail-Closed Execution & Timeout**: Extended default timeout to 10 minutes (`600_000ms`); missing, failed, or timed-out stages fail closed with `REVIEW_RESULT=BLOCK`.
- [x] **Dependency-Free Mutation Testing**: Automated mutation test gate (`scripts/run-mutation-tests.mjs`) requiring 100% killed safety mutants across modular and distributable runners.
- [x] **Verified Distribution & Marketplace Packaging**: Official OMP plugin installation from GitHub (`omp plugin install github:stgmt/omp-reviewer-kit#v0.2.0`) and OMP marketplace catalog compliance without npm dependencies.

---

## Phase 3: Autonomous Agent Correction Loop (Feedback Loop)

Close the loop between code generation and review rejection. When a commit is blocked, the triggering AI agent autonomously reads the audit report and repairs the defect.

- [ ] **Machine-Readable Failure Envelope**: Emit a structured JSON rejection payload in audit reports for direct subagent consumption.
- [ ] **Agent Context Re-injection**: Standardized prompt injection allowing OMP agents to parse rejected findings and locate exact file lines requiring correction.
- [ ] **Bounded Auto-Remediation**: Configurable automated fix attempts (e.g. up to 3 cycles) before escalating to the developer.

---

## Phase 4: Review Replay & Model Benchmarking

Enable empirical evaluation and historical auditing of code review quality.

- [ ] **Context Snapshot Persistence**: Store sanitized input context and loaded project skill metadata alongside each audit report.
- [ ] **Review Replay CLI**: Command to replay historical staged diffs against alternative models (e.g., Claude 3.7 Sonnet vs GPT-4o vs Qwen 2.5) without Git repository mutations.
- [ ] **Rigor & Noise Benchmarks**: Automated metrics calculating false positive rates, missed P1 defect detection, and verdict consistency across model versions.

---

## Phase 5: Ecosystem & Interactive Tooling

Deepen integration with the Oh My Pi harness and developer workflows.

- [x] **Cross-Platform CI**: Automated GitHub Actions matrix testing Node.js on Ubuntu and Windows plus mutation testing.
- [ ] **Pre-Tool-Use Hook Interceptor**: Intercept `bash` or `git commit` commands within active OMP sessions to reject violating changes before subprocess invocation.
- [ ] **Interactive `/review-staged` Command**: Provide an on-demand OMP command for interactive reviews before deciding to commit.
- [ ] **Status Bar Integration**: Visual indicator in OMP UI showing review status of the currently staged diff.
