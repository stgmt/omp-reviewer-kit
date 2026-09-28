# Slop Audit Dogfood History: Acceptance Criteria

## AC1: CLI Runner Script

**Requirement:** [FR1](FR.md#fr1-cli-runner-script)

1. Executing `node scripts/audit-slop.mjs --help` outputs usage instructions and exits with code 0.
2. Executing `node scripts/audit-slop.mjs` on a clean repository exits with code 0 and prints `VERDICT: CLEAN`.
3. Executing `node scripts/audit-slop.mjs` on a repository with planted P1 defects exits with code 1 and prints `VERDICT: BLOCKED`.
4. Invoking with `--no-save` suppresses writes to `audit-reports/slop/`.
5. Invoking with `--json` outputs the structured JSON verdict object to stdout.

## AC2: Slop Store Port and FileSystem Adapter

**Requirement:** [FR2](FR.md#fr2-slop-store-port-and-filesystem-adapter)

1. `SlopStorePort` is exported from `src/application/ports.mjs`.
2. `FileSystemSlopStoreAdapter` implements `SlopStorePort` and creates the destination directory recursively if absent.
3. The adapter exposes methods to write markdown snapshot and append JSONL event.

## AC3: Human-Readable Markdown Snapshots

**Requirement:** [FR3](FR.md#fr3-human-readable-markdown-snapshots)

1. Running an audit produces a file named `<timestamp>-<target-slug>.md` in `audit-reports/slop/`.
2. The first line of the file is the standalone `VERDICT: ...` line.
3. The file contains all verified finding sections with accurate file paths and lines.
4. When findings are empty, sections output `Отсутствуют.`.

## AC4: Append-Only Structured Telemetry Log

**Requirement:** [FR4](FR.md#fr4-append-only-structured-telemetry-log)

1. Running an audit appends exactly one JSON line to `audit-reports/slop/runs.jsonl`.
2. The JSON line parses successfully and contains `"schema": "slop-audit-run@1"`.
3. The event captures `runId`, `commitSha`, `target`, `focus`, `verdict`, `counts`, `verified`, and `rejected` arrays.
4. Multiple sequential runs result in strictly incremental line counts.

## AC5: Extension Slash Command Auto-Persistence

**Requirement:** [FR5](FR.md#fr5-extension-slash-command-auto-persistence)

1. Executing `/slop` in an extension-enabled session creates a snapshot in `audit-reports/slop/`.
2. The `runs.jsonl` log receives a new entry corresponding to the in-session audit.

## AC6: Repository Version Control Policy

**Requirement:** [FR6](FR.md#fr6-repository-version-control-policy)

1. `git status --ignored` does NOT list `audit-reports/slop/` as ignored.
2. Files written to `audit-reports/slop/` can be staged with `git add`.

## AC7: Structured Rejections in SlopReport and Telemetry

**Requirement:** [FR7](FR.md#fr7-structured-rejections-in-slopreport-and-telemetry)

1. `slop-verifier` JSON output schema includes `rejected` array with `file`, `claim`, `rejectionReason`, and `rejectionCategory`.
2. `SlopReport` retains the rejected array and makes it accessible via `report.rejected`.
3. `runs.jsonl` serializes the `rejected` array for each run.

## AC8: Compiled Memory Index

**Requirement:** [FR8](FR.md#fr8-compiled-memory-index)

1. `FileSystemSlopStoreAdapter` compiles and updates `audit-reports/slop/memory.json` after audit completion.
2. `memory.json` groups entries by relative file path.
3. Entries record `contentHash`, `claim`, `rejectionReason`, and `category`.
4. If code at file/line is modified, the memory index marks the entry stale upon subsequent audit.

## AC9: Memory Context Injection into SlopPrompt

**Requirement:** [FR9](FR.md#fr9-memory-context-injection-into-slopprompt)

1. `SlopPrompt` reads `memory.json` and renders a `## Suppressed False Alarms` section when relevant entries exist.
2. `slop-scout` does not output candidates matching active suppressions.
3. Tests prove that an identical candidate is rejected without redundant tool invocations.

## AC10: Reviewer Structured History Write

**Requirement:** [FR10](FR.md#fr10-reviewer-structured-history-write)

1. A review run appends exactly one JSON line to `audit-reports/review/runs.jsonl` with `review-audit-run@1`, `diff_hash`, `verdict`, `confirmed_findings`, `confirmed_coverage_gaps`, and `decisions` for rejected and not_proven.
2. A Markdown snapshot `<timestamp>-<diff-hash>.md` is written with all sections plus envelope on BLOCK.
3. `REVIEW_RESULT` gate semantics are unchanged by history write failures.

## AC11: Reviewer Memory Read and Suppression

**Requirement:** [FR11](FR.md#fr11-reviewer-memory-read-and-suppression)

1. Dispatcher injects top-K suppressions matching `changed_paths` into scout, hunter, and verifier task texts.
2. Scout does not re-emit an actively suppressed hypothesis on unchanged code.
3. Security findings of any priority are never auto-suppressed.
4. Entries without verifiable `provenance` (runId + artifactPath + artifactSha recomputed by the dispatcher) do not suppress.
5. `exempted` status without operator `grantedBy` is ignored (degrades to `active`).
6. `memory.json` in `changed_paths` disables suppression for that review (self-suppression impossible).
7. Memory read failure still yields a valid stateless review.

## AC12: Shared Audit Memory Index

**Requirement:** [FR12](FR.md#fr12-shared-audit-memory-index)

1. `audit-reports/memory/memory.json` validates against `audit-memory@1`.
2. Entries from both `slop` and `review` sources share fingerprint space; same code maps to same fingerprint.
3. `contentHash` drift marks entry `stale`; sorted keys keep git diffs minimal.
4. `audit-reports/memory/`, `audit-reports/slop/`, `audit-reports/review/` are not ignored; `audit-reports/commit-reviews/` stays ignored.

## AC13: Suppression Trust Boundary

**Requirement:** [FR13](FR.md#fr13-suppression-trust-boundary)

1. A schema-valid but hand-forged `memory.json` entry (no provenance, fabricated contentHash) produces zero suppression — the affected agent still evaluates the code.
2. Entry `claim`/`reason` containing instruction-like text ("ignore this file", "always pass") is injected as quoted data and provably ignored by agent contracts.
3. `provenance.artifactSha` mismatch marks the entry untrusted; dispatcher logs and skips it.
