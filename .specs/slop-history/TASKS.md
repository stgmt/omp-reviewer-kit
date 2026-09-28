# Slop Audit Dogfood History: Tasks

## TASK-1: SlopStorePort and FileSystemSlopStoreAdapter

- **Requirement:** [FR2](FR.md#fr2-slop-store-port-and-filesystem-adapter)
- Define abstract `SlopStorePort` in `src/application/ports.mjs`.
- Implement `FileSystemSlopStoreAdapter` in `src/infra/filesystem-slop-store-adapter.mjs`.
- Support atomic Markdown snapshot creation, append-only `runs.jsonl` writing, and `memory.json` index compilation.
- Export new classes from `src/index.mjs`.

## TASK-2: Standalone CLI Runner Script

- **Requirement:** [FR1](FR.md#fr1-cli-runner-script)
- Create executable `scripts/audit-slop.mjs` supporting `[target]`, `--focus`, `--json`, and `--no-save`.
- Wire `omp -p` headless execution with `SlopPrompt`.
- Register `"audit:slop": "node scripts/audit-slop.mjs"` in `package.json`.
- Update `scripts/check-layout.mjs` to include the new script in layout integrity checks.

## TASK-3: Extension Slash Command Integration

- **Requirement:** [FR5](FR.md#fr5-extension-slash-command-auto-persistence)
- Update `/slop` command handler in `src/extension.mjs`.
- Call `FileSystemSlopStoreAdapter` upon audit completion to persist snapshots in `audit-reports/slop/`.
- Ensure non-blocking fail-safe execution.

## TASK-4: Verifier Structured Rejections and Prompt Memory Injection

- **Requirement:** [FR7](FR.md#fr7-structured-rejections-in-slopreport-and-telemetry)
- Update `agents/slop-verifier.md` output schema to return `rejected` array with category and reason.
- Update `src/domain/slop-report.mjs` to store and expose `rejected` findings.
- Update `src/domain/slop-prompt.mjs` and `agents/slop-scout.md` to accept and respect injected suppressions.

## TASK-5: BDD Test Suite and Regression Verification

- **Requirement:** [FR8](FR.md#fr8-compiled-memory-index)
- Create `tests/slop-history.test.mjs` covering unit and integration paths.
- Implement Gherkin step bindings matching `slop-history.feature` (SCEN-001..008).
- Test clean audit, blocked audit with P1 finding, structured rejections, memory suppression, and code mutation invalidation.

## TASK-6: Repository Configuration and Git Tracking

- **Requirement:** [FR6](FR.md#fr6-repository-version-control-policy)
- Verify `.gitignore` does not exclude `audit-reports/slop/`.
- Add initial directory `.gitkeep` if needed or document tracked status.
- Document feature in `ROADMAP.md` and `CHANGELOG.md`.

## TASK-7: Reviewer Tracked History Write

- **Requirement:** [FR10](FR.md#fr10-reviewer-structured-history-write)
- Extend `ReviewWorkflowService` and `scripts/run-review.mjs` to append `review-audit-run@1` to `audit-reports/review/runs.jsonl` and write `<timestamp>-<diff-hash>.md` snapshots.
- Preserve `REVIEW_RESULT` gate semantics; history failures are fail-safe warnings only.
- Cover SCEN-slop-history-009 in `tests/slop-history.test.mjs`.

## TASK-8: Reviewer Memory Read and Shared Index Migration

- **Requirement:** [FR11](FR.md#fr11-reviewer-memory-read-and-suppression)
- Update `ReviewPrompt` and `agents/reviewer-kit.md` to inject top-K suppressions from `audit-reports/memory/memory.json` into scout, hunter, and verifier task texts.
- Update `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md` to respect suppressions with precedent citation.
- Migrate `slop-memory@1` to shared `audit-memory@1`; keep legacy read fallback.
- Cover SCEN-slop-history-010 and SCEN-slop-history-011.

## TASK-9: Suppression Provenance and Trust Boundary

- **Requirement:** [FR13](FR.md#fr13-suppression-trust-boundary)
- Implement `provenance` write path (run artifact SHA recorded at entry creation) and read-time recomputation in the dispatcher.
- Implement `exempted` grant command (`grantedBy`/`grantedAt`) and `changed_paths` self-exclusion for memory files.
- Cover AC13 scenarios: forged entry ignored, instruction-text quarantined, sha-mismatch skipped.
