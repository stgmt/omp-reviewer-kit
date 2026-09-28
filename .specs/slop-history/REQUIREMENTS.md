# Slop Audit Dogfood History: Requirements

## Business Requirements

- **REQ-1 (Durable Quality Trail)**: Every adversarial slop audit must be recordable into the repository to prove absence of parasitic architecture and vacuous checks.
- **REQ-2 (Zero Friction Dogfooding)**: Both CLI and in-session `/slop` invocations must support recording without requiring manual file writes from the developer.
- **REQ-3 (CI Enforcement)**: Automated runs must support headless execution with standard Unix exit codes for pipeline blocking.

## Architectural Requirements

- **REQ-4 (Port/Adapter Separation)**: Storage logic must adhere to hexagonal architecture, allowing pluggable storage adapters and mockability in tests.
- **REQ-5 (Schema Versioning)**: JSONL telemetry records must be tagged with an explicit schema identifier (`slop-audit-run@1`).
- **REQ-6 (Git Tracked)**: Unlike local commit reviews, the slop audit directory must remain un-ignored in `.gitignore`.

## Review Integration Requirements

- **REQ-7 (Reviewer Remembers)**: Reviewer must read shared memory before hunting and write structured rejections after verifying, so refuted hypotheses are not re-raised.
- **REQ-8 (Shared Fingerprint)**: Slop worktree coordinates and review staged-snapshot coordinates map to the same fingerprint space via normalized snippet hash.
- **REQ-9 (Tracked Review Log)**: Review history lives in git under `audit-reports/review/`; ephemeral `audit-reports/commit-reviews/` remains local-only.
