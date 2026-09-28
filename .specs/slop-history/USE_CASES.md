# Slop Audit Dogfood History: Use Cases

## UC1: Headless CLI Audit on Working Tree

- **Actor:** Developer or CI Runner.
- **Preconditions:** Git repository initialized; OMP CLI available or mocked in tests.
- **Main Flow:**
  1. Actor invokes `node scripts/audit-slop.mjs [target] [--focus=<focus>]`.
  2. Runner resolves target (defaults to `.` when omitted), builds `SlopPrompt`, and dispatches `slop` agent headlessly.
  3. Upon completion, runner parses the `VERDICT:` output into `SlopReport`.
  4. Runner invokes `FileSystemSlopStoreAdapter.saveAudit(report)`.
  5. Adapter writes `audit-reports/slop/<timestamp>-<target-slug>.md` and appends a record to `audit-reports/slop/runs.jsonl`.
  6. Runner exits with 0 (CLEAN / ACCEPTABLE_WITH_NOTES) or 1 (BLOCKED / ERROR).

## UC2: Interactive Slash Command Execution

- **Actor:** OMP User in interactive session.
- **Preconditions:** `omp-reviewer-kit` extension loaded in session.
- **Main Flow:**
  1. User issues `/slop src/domain --focus=architecture`.
  2. Extension dispatches slop audit task via `SlopPrompt`.
  3. Turn settles and returns the raw `SlopReport` text.
  4. Extension invokes `FileSystemSlopStoreAdapter` to persist the snapshot and append to `runs.jsonl` in `audit-reports/slop/`.
  5. User sees formatted verdict in chat; repository now has the dogfood commit candidate.

## UC3: Fail-Safe Disk I/O Degradation

- **Actor:** Runner or Extension.
- **Condition:** Filesystem permissions error or disk full on `audit-reports/slop/`.
- **Main Flow:**
  1. Store adapter encounters an I/O error during report or JSONL write.
  2. Adapter logs a warning to stderr.
  3. The audit verdict itself is not altered or disguised.
  4. Process returns the genuine audit exit code (BLOCKED stays exit 1).
