# Slop Audit Dogfood History: Non-Functional Requirements

## NFR1: Zero External Runtime Dependencies

All implementation code in `src/` and `scripts/audit-slop.mjs` shall use strictly Node.js built-in modules (`node:fs/promises`, `node:path`, `node:child_process`, `node:crypto`, `node:os`). No third-party npm runtime dependencies.

## NFR2: Fail-Safe Telemetry and Persistence

Storage adapter errors (e.g. disk full, read-only permissions) shall be logged to `stderr` as warnings and must never mask or flip an audit verdict. A blocked audit must still exit with code 1 even if the disk write fails.

## NFR3: Merge Safety via Append-Only Log

The `runs.jsonl` log file shall strictly append one line per audit run. Independent branch executions shall be mergeable by git with standard line-based merge mechanics.

## NFR4: Cross-Platform Path and Line-Ending Support

All file paths and content generation shall operate consistently across Windows 11 and Linux POSIX runners, using `path.join`, normalized forward slashes in IDs, and universal `\n` line endings in generated markdown and JSONL.

## NFR5: Suppression Integrity

The `audit-memory@1` suppression index is a security boundary for the review gate. Auto-suppression shall honor only provenance-verified entries (recorded run artifact SHA recomputed at read time), `exempted` shall require operator `grantedBy`, and the memory files themselves shall be excluded from suppression when staged — so no committer can silence the review of their own change.
