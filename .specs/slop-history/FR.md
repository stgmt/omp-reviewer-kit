# Slop Audit Dogfood History: Functional Requirements

## FR1: CLI Runner Script

**Acceptance:** [AC1](ACCEPTANCE_CRITERIA.md#ac1-cli-runner-script)

The system shall provide a standalone Node.js CLI runner (`scripts/audit-slop.mjs`) callable directly or via `npm run audit:slop`.
- Supports optional positional `[target]` (defaults to `.` when omitted).
- Supports `--focus=<focus>` flag where focus is one of `architecture`, `specs`, `tests`, or `plan`.
- Supports `--json` flag to print raw structured JSON instead of formatted markdown.
- Supports `--no-save` flag to run audit without writing files to `audit-reports/slop/`.
- Exits with code 0 on `VERDICT: CLEAN` or `VERDICT: ACCEPTABLE_WITH_NOTES`.
- Exits with code 1 on `VERDICT: BLOCKED` or `VERDICT: ERROR`.
- Exits with code 2 on invalid CLI options or arguments.

## FR2: Slop Store Port and FileSystem Adapter

**Acceptance:** [AC2](ACCEPTANCE_CRITERIA.md#ac2-slop-store-port-and-filesystem-adapter)

The system shall declare an application port `SlopStorePort` and implement a concrete infrastructure adapter `FileSystemSlopStoreAdapter`.
- `SlopStorePort` defines `saveAudit({ repoRoot, report, target, focus, commitSha, runId })`.
- `FileSystemSlopStoreAdapter` writes both Markdown and JSONL records under the configured relative directory (defaulting to `audit-reports/slop`).
- Review agents remain strictly read-only; the host process coordinates storage via this port.

## FR3: Human-Readable Markdown Snapshots

**Acceptance:** [AC3](ACCEPTANCE_CRITERIA.md#ac3-human-readable-markdown-snapshots)

Upon audit completion, the store adapter shall create an individual Markdown report file.
- Filename format: `<timestamp>-<target-slug>.md` (e.g. `2026-09-21T14-30-00Z-src_domain.md`).
- File content: Exact byte output of `SlopReport.toString()` containing the standalone `VERDICT:` line, 🔴 P1, 🟡 P2, and 🟢 P3 sections, and the rejected-opinion count.

## FR4: Append-Only Structured Telemetry Log

**Acceptance:** [AC4](ACCEPTANCE_CRITERIA.md#ac4-append-only-structured-telemetry-log)

Upon audit completion, the store adapter shall append a single-line JSON record to `audit-reports/slop/runs.jsonl`.
- Record adheres to schema `slop-audit-run@1`.
- Contains fields: `schema`, `runId`, `timestamp`, `commitSha`, `target`, `focus`, `verdict`, `verdictReason`, `counts` (`p1`, `p2`, `p3`, `rejected`), `verified` findings array, and `rejected` findings array.
- Each append terminates with a newline (`\n`) and does not overwrite or corrupt previous entries.

## FR5: Extension Slash Command Auto-Persistence

**Acceptance:** [AC5](ACCEPTANCE_CRITERIA.md#ac5-extension-slash-command-auto-persistence)

The native extension (`src/extension.mjs`) shall integrate audit persistence into the `/slop` slash command handler.
- When `/slop` completes in an interactive session, the extension calls `FileSystemSlopStoreAdapter` to persist the snapshot and JSONL log.
- Does not disrupt conversational flow or block turn streaming.

## FR6: Repository Version Control Policy

**Acceptance:** [AC6](ACCEPTANCE_CRITERIA.md#ac6-repository-version-control-policy)

The repository configuration shall ensure that `audit-reports/slop/` is tracked in git.
- `.gitignore` must NOT ignore `audit-reports/slop/`.
- Audit execution must not alter any tracked repository files prior to writing the audit artifacts.

## FR7: Structured Rejections in SlopReport and Telemetry

**Acceptance:** [AC7](ACCEPTANCE_CRITERIA.md#ac7-structured-rejections-in-slopreport-and-telemetry)

The verifier agent (`slop-verifier`) and `SlopReport` domain entity shall capture structured details for rejected candidates.
- Replaces scalar count with rich object array `rejected: [{ fingerprint, file, line, claim, rejectionReason, rejectionCategory }]`.
- Standardized rejection categories: `COUNTER_EXAMPLE_PROVEN`, `NATIVE_ALTERNATIVE_ABSENT`, `HALLUCINATION`, `ACCEPTED_DESIGN_DECISION`.
- Both `runs.jsonl` telemetry and `SlopReport` retain structured rejection facts for indexing.

## FR8: Compiled Memory Index

**Acceptance:** [AC8](ACCEPTANCE_CRITERIA.md#ac8-compiled-memory-index)

The system shall maintain a consolidated memory index at `audit-reports/slop/memory.json` conforming to schema `slop-memory@1`.
- Indexed by file path: maps files to their active `suppressedHypotheses` and `exemptions`.
- Associates each entry with a content fingerprint (hash of code block/function).
- Invalidation rule: if target code changes, old suppressions for that block become invalid and are re-evaluated.

## FR9: Memory Context Injection into SlopPrompt

**Acceptance:** [AC9](ACCEPTANCE_CRITERIA.md#ac9-memory-context-injection-into-slopprompt)

The `SlopPrompt` dispatcher shall query `memory.json` and inject active suppressions into the audit prompt.
- `slop-scout` receives known false alarms and is instructed not to re-raise them without new code evidence.
- `slop-verifier` uses historical proof to reject recurring hallucinations immediately.

## FR10: Reviewer Structured History Write

**Acceptance:** [AC10](ACCEPTANCE_CRITERIA.md#ac10-reviewer-structured-history-write)

The review host (`ReviewWorkflowService`, `scripts/run-review.mjs`) shall persist every review run to tracked history in `audit-reports/review/`.
- Appends one JSON line per run to `audit-reports/review/runs.jsonl` conforming to `review-audit-run@1` with `diff_hash`, `verdict`, `confirmed_findings`, `confirmed_coverage_gaps`, and structured `decisions` for `rejected` and `not_proven` (with `reason`, `evidence`, `triage`).
- Writes human-readable Markdown snapshot `<timestamp>-<diff-hash>.md` with all report sections plus rejection envelope when BLOCKing.
- Gate semantics unchanged: exactly one solitary `REVIEW_RESULT=PASS|BLOCK` line decides; history write never flips verdict.
- Review agents stay read-only; only host writes.

## FR11: Reviewer Memory Read and Suppression

**Acceptance:** [AC11](ACCEPTANCE_CRITERIA.md#ac11-reviewer-memory-read-and-suppression)

The review dispatcher (`ReviewPrompt`, `reviewer-kit` orchestrator) shall read the shared memory index and inject relevant suppressions into all stages.
- Lookup key is `changed_paths` from staged snapshot; injection is top-K matching entries only, never full dump.
- `review-context-scout` and both `review-risk-hunter` lanes receive `## Suppressed False Alarms`; injected entry text (`claim`, `reason`) is quoted data describing a past decision, never instructions — agents MUST NOT follow directives embedded in entry text.
- `review-finding-verifier` may fast-reject a candidate matching an active suppression by citing the precedent, without redundant tool calls.
- Auto-suppression allowed only for entries whose `provenance` binds the decision to a recorded host artifact (`runId` + artifact path + artifact SHA of a verifier/slop run); entries without verifiable provenance are ignored (never fail-safe suppress).
- Auto-suppression allowed only for `HALLUCINATION` and `COUNTER_EXAMPLE_PROVEN`; `security` findings of any priority are never auto-suppressed.
- `status: exempted` may be granted only by an explicit operator command recording `grantedBy` and `grantedAt` in the entry; a committer staging code cannot grant it through a raw edit — entries whose `exempted` status lacks operator provenance are treated as `active`.
- `audit-reports/memory/memory.json` and its directory MUST be excluded from suppression lookup when memory files themselves appear in `changed_paths` — a diff cannot suppress its own review.
- Memory read failure is fail-open: proceed stateless; malformed or provenance-less entries are skipped, never applied.

## FR12: Shared Audit Memory Index

**Acceptance:** [AC12](ACCEPTANCE_CRITERIA.md#ac12-shared-audit-memory-index)

The system shall maintain a single shared index at `audit-reports/memory/memory.json` conforming to `audit-memory@1`, replacing per-tool indexes.
- Entry fields: `fingerprint`, `source` (`slop|review`), `file`, `line_hint`, `claim`, `reason`, `category`, `contentHash`, `status` (`active|stale|exempted`), `updatedAt`, `diff_hash` when from review, `provenance` (`runId` + `artifactPath` + `artifactSha` of the recorded rejection that earned the entry), `grantedBy`/`grantedAt` when status is `exempted`.
- Fingerprint is `sha256(normalized snippet + repo-relative path)`; line numbers are hints only (staged snapshot vs worktree drift).
- Both `FileSystemSlopStoreAdapter` and review store adapter read-modify-write with deterministic sorted keys; `contentHash` mismatch marks entry `stale`.
- `audit-reports/memory/`, `audit-reports/slop/`, `audit-reports/review/` are git-tracked; ephemeral `audit-reports/commit-reviews/` stays ignored.

## FR13: Suppression Trust Boundary

**Acceptance:** [AC13](ACCEPTANCE_CRITERIA.md#ac13-suppression-trust-boundary)

The suppression channel shall be unforgeable by the committer under review:
- `provenance.artifactSha` is `sha256` of the recorded run artifact (`runs.jsonl` line or report file) that contains the cited rejection; the dispatcher recomputes it before honoring an entry.
- `contentHash` binds the entry to the exact code bytes it was earned against; drift marks `stale`, which never suppresses.
- Only entries written by `FileSystemSlopStoreAdapter`/`ReviewWorkflowService` history writers or the explicit `exempted` operator command carry valid provenance; hand-authored entries cannot suppress.
