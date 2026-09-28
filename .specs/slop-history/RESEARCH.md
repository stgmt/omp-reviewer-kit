# Slop Audit Dogfood History: Research & Architecture Analysis

## Existing Persistence Patterns in omp-reviewer-kit

1. **Pre-commit Commit Reviews**:
   - Uses `ReportStorePort` and `FileSystemReportStoreAdapter` to save `<timestamp>-<hash>.md`.
   - Uses `TelemetryPort` and `FileSystemTelemetryAdapter` to maintain `runs.jsonl` and `last-run.json`.
   - Location: `audit-reports/commit-reviews/`.
   - Note: Excluded in `.gitignore` because commit reviews are ephemeral pre-commit gate artifacts.

2. **Range Audits**:
   - `scripts/audit-range.mjs` generates deterministic git diff suspicion reports under `audit-reports/range-audits/<slug>-<timestamp>.md`.
   - These reports are tracked in git as diagnostic evidence.

3. **Slop Audit Gap**:
   - `SlopReport` (`src/domain/slop-report.mjs`) already renders Part V markdown.
   - `SlopPrompt` (`src/domain/slop-prompt.mjs`) dispatches `slop` agent.
   - Missing: persistence adapter, CLI runner, and git tracking for `audit-reports/slop/`.

## Invariants

- **Agent Read-Only Boundary**: Review agents (`slop`, `slop-scout`, `slop-verifier`) MUST NOT have `write` or `edit` tools. Persistence is strictly the responsibility of the host process.
- **Merge Safety**: Append-only JSONL entries avoid git merge conflicts when multiple developers run audits across branches.
