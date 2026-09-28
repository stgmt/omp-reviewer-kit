# Slop Audit Dogfood History: Planned File Changes

## New Files

- `src/infra/filesystem-slop-store-adapter.mjs`: Implementation of `SlopStorePort` persisting snapshots, `runs.jsonl`, and compiling `memory.json` in `audit-reports/slop/`.
- `scripts/audit-slop.mjs`: Standalone CLI runner for slop audits with memory integration.
- `tests/slop-history.test.mjs`: Comprehensive BDD and unit tests for runner, adapter, telemetry, and memory suppression.

## Modified Files

- `src/application/ports.mjs`: Add `SlopStorePort` abstract class definition.
- `src/domain/slop-report.mjs`: Add `rejected` findings collection and getters to `SlopReport`.
- `src/domain/slop-prompt.mjs`: Support querying `memory.json` and rendering `## Suppressed False Alarms` in prompt.
- `agents/slop-verifier.md`: Update output schema from scalar `rejectedCount` to structured `rejected[]` array.
- `agents/slop-scout.md`: Add instructions to respect suppressed hypotheses.
- `src/index.mjs`: Re-export `SlopStorePort` and `FileSystemSlopStoreAdapter`.
- `src/extension.mjs`: Wire `/slop` command to persist audit history and memory via `FileSystemSlopStoreAdapter`.
- `package.json`: Add npm script `"audit:slop": "node scripts/audit-slop.mjs"`.
- `scripts/check-layout.mjs`: Register `scripts/audit-slop.mjs` in repository layout integrity gates.

## Reviewer Integration (FR10-FR12)

### New Files

- `audit-reports/review/runs.jsonl`: Tracked append-only review telemetry (`review-audit-run@1`).
- `audit-reports/memory/memory.json`: Shared precedent index (`audit-memory@1`).

### Modified Files

- `src/domain/review-report.mjs`: Expose structured `decisions` for history serialization.
- `src/domain/review-prompt.mjs` and `agents/reviewer-kit.md`: Memory read and injection into scout, hunter, verifier task texts.
- `agents/review-context-scout.md`, `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`: Respect suppressions, fast-reject by precedent.
- `scripts/run-review.mjs`, `src/infra/filesystem-report-store-adapter.mjs`, `src/infra/filesystem-telemetry-adapter.mjs`: Tracked review history write path.
