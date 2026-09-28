# Slop Audit Dogfood History: Technical Design

## Architecture Overview

This subsystem integrates in-repo dogfood persistence and an active memory feedback loop for adversarial slop audits. Review agents (`slop`, `slop-scout`, `slop-verifier`) remain completely read-only (`tools: read, grep, glob, lsp, bash, task`).

All filesystem persistence and memory indexing are owned by host-side orchestrators (`scripts/audit-slop.mjs` and `src/extension.mjs`) through decoupled application ports and infrastructure adapters.

```
┌─────────────────────────────────────────────────────────────┐
│                     Slop Execution Host                     │
│ (scripts/audit-slop.mjs, extension /slop handler)           │
└──────────────────────────────┬──────────────────────────────┘
                               │ 1. Reads memory.json, injects
                               │    suppressions into SlopPrompt
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               OMP Agent Pipeline (Read-Only)                │
│                                                             │
│   slop-scout: Skips known false alarms                      │
│        │                                                    │
│        ▼                                                    │
│   slop-verifier: Outputs verified[] AND structured          │
│                  rejected[] with reasons & categories       │
└──────────────────────────────┬──────────────────────────────┘
                               │ 2. Yields report with
                               │    verified + rejected data
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  SlopReport Domain Entity                   │
│                (src/domain/slop-report.mjs)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ 3. report.toString(), toRecord()
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        SlopStorePort                        │
│                 (src/application/ports.mjs)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ 4. Implemented by
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 FileSystemSlopStoreAdapter                  │
│           (src/infra/filesystem-slop-store-adapter)         │
└──────────────────────────────┬──────────────────────────────┘
                               │ 5. Writes atomically
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     audit-reports/slop/                     │
│   ├── <timestamp>-<slug>.md (Human Markdown Snapshots)      │
│   ├── runs.jsonl            (Append-Only Stream Log)        │
│   └── memory.json           (Active Precedent & Debt Index) │
└─────────────────────────────────────────────────────────────┘
```

## The Memory Feedback Loop

To prevent the review pipeline from flapping on controversial designs or repeatedly proposing previously rejected false alarms, the system closes the feedback loop:

1. **Structured Rejections**:
   `slop-verifier` does not merely discard candidates. It classifies every rejected candidate with a `rejectionCategory` (`COUNTER_EXAMPLE_PROVEN`, `NATIVE_ALTERNATIVE_ABSENT`, `HALLUCINATION`, `ACCEPTED_DESIGN_DECISION`) and a factual `rejectionReason` citing why the code is valid.

2. **Memory Index (`memory.json`)**:
   `FileSystemSlopStoreAdapter` maintains `audit-reports/slop/memory.json`. It maps file paths to arrays of active suppressions:
   - `claim`: the refuted criticism.
   - `rejectionReason`: why it was rejected.
   - `contentHash`: SHA-256 hash of the target line range or function.

3. **Prompt Injection**:
   Before dispatching the audit, `SlopPrompt` inspects `memory.json` for target files. If active suppressions exist, it appends a `## Suppressed False Alarms` section to the prompt instructed to `slop-scout`.

4. **Cache Invalidation (Code Drift)**:
   When code changes, its content hash changes. Upon the next audit, `FileSystemSlopStoreAdapter` checks whether target code matches `contentHash`. If code has changed, old suppressions are marked stale or purged, allowing fresh scrutiny.

## Reviewer Integration and Shared Memory

The pre-commit reviewer (`reviewer-kit` 4-stage pipeline) joins the same feedback loop:

1. **Reviewer write path**: `ReviewWorkflowService` (`scripts/run-review.mjs`, `src/infra/filesystem-report-store-adapter.mjs`, `src/infra/filesystem-telemetry-adapter.mjs`) persists to tracked `audit-reports/review/<timestamp>-<diff-hash>.md` plus one JSON line in `audit-reports/review/runs.jsonl` (`review-audit-run@1`). Payload includes `diff_hash`, `verdict`, `confirmed_findings`, `confirmed_coverage_gaps`, and `decisions[]` for every `rejected` and `not_proven` candidate with `reason`, `evidence`, `triage`. Ephemeral `audit-reports/commit-reviews/` (`runs.jsonl`, `last-run.json`) stays as local live channel and remains git-ignored.

2. **Reviewer read path**: `ReviewPrompt` and the `reviewer-kit` orchestrator load `audit-reports/memory/memory.json`, filter by staged `changed_paths` (top-K, never full dump), and forward a `## Suppressed False Alarms` block into `review-context-scout`, both `review-risk-hunter` lanes, and `review-finding-verifier`. Fast-reject by precedent citation is allowed; new code evidence re-opens.
   - **Trust boundary**: injected entry text is quoted data (never instructions). Auto-suppression honors only entries with `provenance` recomputed against the recorded artifact SHA; `exempted` requires operator `grantedBy`; memory files are excluded from suppression when they appear in `changed_paths`; security findings are never auto-suppressed.

3. **Shared index**: `audit-reports/memory/memory.json` (`audit-memory@1`) supersedes `audit-reports/slop/memory.json` (`slop-memory@1` retained as legacy read fallback during migration). Fingerprint `sha256(normalized snippet + repo-relative path)` unifies staged-snapshot coordinates (`file_path`, `line_start/end`) and worktree coordinates (`file`, `line`). `contentHash` drift marks entries `stale`. Review-only fields (`diff_hash`) are optional for slop entries.
