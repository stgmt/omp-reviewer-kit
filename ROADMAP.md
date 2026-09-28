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

## Phase 3: Caller-Owned Review Rejection Feedback (v0.3.0)

Give the triggering AI agent a strict, machine-readable rejection signal while keeping the full reviewer evidence in the immutable audit report. The plugin reports the rejection; it never fixes the code itself.

- [ ] **Rejection Envelope (`review-rejection-envelope@1`)**: Emit exactly one JSON envelope between standalone `REVIEW_REJECTION_ENVELOPE_BEGIN` and `REVIEW_REJECTION_ENVELOPE_END` lines before exactly one solitary `REVIEW_RESULT=BLOCK`. Require the exact schema, reject duplicate or unknown fields, validate a 64-character lowercase SHA-256 `diff_hash`, and keep malformed, missing, mismatched, or contradictory cases BLOCKed with `kind: review_failure`.
- [ ] **Confirmed Finding Contract**: For `kind: confirmed_findings`, require at least one unique finding with P1/P2 priority, correctness/security defect class, repository-relative slash path without `../`, positive inclusive line range, nonempty verifier argument, and concrete counterexample.
- [ ] **Coverage-Required Contract**: For `kind: coverage_required`, require `findings: []` and a non-empty `coverage_items` array; each item has a unique `coverage_id`, repository-relative path, positive inclusive line range, non-empty `behavior`, and `required_tests` where every entry is `{kind: edge|mutation, scenario, mutant}` with a non-empty `mutant` for mutation tests.
- [ ] **Review-Failure Contract**: For `kind: review_failure`, require `findings: []` and `failure: { code, message }` with a non-empty diagnostic message; allow only execution_failure, missing_verdict_marker, multiple_verdict_markers, missing_rejection_envelope, malformed_rejection_envelope, and contradictory_rejection_envelope.
- [ ] **Two-Line Caller Signal**: After the report is saved, BLOCK stderr carries only `reviewer-kit BLOCK: <absolute-report-path>` and `REVIEW_REJECTION_REPORT=<absolute-report-path>`; full reviewer output, envelope, and parser diagnostics stay in the audit report, and the Git hook keeps exit code 1. PASS keeps its current success signal and emits no rejection pointer.
- [ ] **Caller-Owned Repair (no auto-remediation)**: No new agent turn, `pi.sendMessage`, fixer agent, recursive `omp -p`, retry counter, provider retry after a real verdict, file edit, `git add`, reset, checkout, commit, automatic re-commit, `session_stop`, or second review process; the calling agent reads the report, fixes the defect, stages its files, and re-commits itself.
- [ ] **Synchronized Delivery and Proof**: Update the modular workflow and both self-contained runners together; add contract tests for valid envelopes, every failure code, malformed/duplicate/unknown fields, path traversal, invalid ranges, hash mismatch, marker ordering, and exactly-two-line BLOCK stderr; prove runner synchronization with `npm run check`.

---

## Phase 4a: Coverage Gate Precision (incident 2026-09-27)

Root cause: `test_harness` was repo-global, so any changed executable line in a harnessless file class (standalone spec HTML with an inline viewer script) produced a blocking `coverage_required`, and the verifier had no contractual ground to reject it. Prompt-level grounds landed in the agent contracts; the schema fix is pending.

- [ ] **Per-Item Harness Scoping**: Change the scout `coverage_map` contract so `test_harness` is recorded per entry (which runnable harness can execute this file's runtime), not once per repository; `absent` for an item demotes the gap to `### Notes` and never blocks. Requires schema changes in `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`, `agents/reviewer-kit.md`, `skills/multi-stage-review/SKILL.md`, and runner validation of `coverage_items`.
- [x] **Reject-Grounds Extension (done)**: hunter skips + verifier rejection grounds now cover harness-runtime mismatch and byte-identical copies of already-committed untested code (document-viewer chrome incident, `audit-reports/coverage-gate-docs-html-incident-2026-09-27.md`).
- [x] **Suppressed-Gap Observability (done)**: `### Notes` now mandates mirroring every suppressed coverage item with file, line range, and ground, sourced from structured producer records — scout `non_coverable_items`, hunter `suppressed_coverage_items`, verifier `rejected_coverage_gaps` (`agents/reviewer-kit.md`, `skills/multi-stage-review/SKILL.md`).

## Phase 4b: Review Latency & Iteration Cost (incident 2026-09-28)

Measured on the v0.12.4 release round: a 40-file / ~2700-line spec+contract diff took 8 sequential full reviews at ~14-40 min each (~2.5h wall) before converging, each attempt re-running all 4 stages and ~30+ model requests from scratch on near-identical input. Historical baselines: small diffs 3.6-16m, today's large spec diffs 18-40m. Levers ranked by cost/quality, no model downgrades or effort cuts:

- [ ] **Content-aware scoping**: route review depth by staged file class. A diff that is doc/spec/prompt-only (`.specs/`, `*.md`, `agents/`, `skills/`) should run a reduced lane (contract-consistency + no P1/P2 defect claims) instead of the full executable-code pipeline; coverage machinery applies only to harness-executable classes anyway post-0.12.4.
- [ ] **Per-diff-hash stage reuse**: `DiffIdentity` already hashes the staged bytes — cache the scout report and hunter candidates keyed by diff hash and rehydrate when a re-commit stages the same or a small-superset diff (BLOCK → fix → re-commit re-runs the whole pipeline on the same ~95% unchanged bytes today).
- [ ] **Snapshot reuse**: `snapshot_materialized` re-materializes the staged tree per attempt; key it by diff hash so a retry can link the same snapshot.
- [ ] **File-class lane partition**: hunters currently walk every staged file; partition correctness lane by file class (executable / prompt / spec / docs) so each hunter lane bounds its reads to its class.
- [ ] **Verifier batching**: verifier evaluates per-candidate; batch independent findings in fewer model calls when the candidate list is long.
- [ ] **Doc/spec review profile**: spec corpus reviews should not pay the executable-code price — spec changes have no coverage pipeline work and bounded defect classes (stale counters, naming drift, schema holes); a dedicated lighter reviewer profile for spec-only commits cuts the dominant cost case.

## Phase 4: Holistic Project Audit & Agent Usability ([Issue #1](https://github.com/stgmt/omp-reviewer-kit/issues/1))

Define and implement a context-neutral deep-audit capability that evaluates a system as a product, implementation, operational surface, and tool for human and AI-agent users.

- [ ] **Universal Multi-Layer Review Philosophy**: Define reusable analysis dimensions, evidence rules, unknown-area handling, deduplication, and prioritization.
- [ ] **Project Audit Orchestration**: Run product, usage, behavior, security, failure, maintainability, lifecycle, and evidence analyses without changing the commit-gate contract.
- [ ] **Agent Usability Analysis**: Evaluate discoverability, action order, state clarity, safe writes, error recovery, and result verification.
- [ ] **Advisory Audit Report**: Produce a separate report with confirmed problems, risks, unknowns, coverage, and prioritized actions.
- [ ] **Audit Result Isolation**: Ensure deep-audit output cannot be interpreted as `REVIEW_RESULT=PASS|BLOCK`.

---

## Phase 5: Review Replay & Model Benchmarking

Enable empirical evaluation and historical auditing of code review quality.

- [ ] **Context Snapshot Persistence**: Store sanitized input context and loaded project skill metadata alongside each audit report.
- [ ] **Review Replay CLI**: Command to replay historical staged diffs against alternative models (e.g., Claude 3.7 Sonnet vs GPT-4o vs Qwen 2.5) without Git repository mutations.
- [ ] **Rigor & Noise Benchmarks**: Automated metrics calculating false positive rates, missed P1 defect detection, and verdict consistency across model versions.

---

## Phase 6: Ecosystem & Interactive Tooling

Deepen integration with the Oh My Pi harness and developer workflows.

- [x] **Cross-Platform CI**: Automated GitHub Actions matrix testing Node.js on Ubuntu and Windows plus mutation testing.
- [ ] **Pre-Tool-Use Hook Interceptor**: Intercept `bash` or `git commit` commands within active OMP sessions to reject violating changes before subprocess invocation.
- [ ] **Interactive `/review-staged` Command**: Provide an on-demand OMP command for interactive reviews before deciding to commit.
- [ ] **Status Bar Integration**: Visual indicator in OMP UI showing review status of the currently staged diff.
