# Slop Audit Dogfood History: User Stories

## US1: Developer In-Session Audit Dogfooding

As a developer running an adversarial slop audit in an OMP session via `/slop`,
I want the audit verdict, verified findings, and rejected opinions to be automatically saved into `audit-reports/slop/`,
so that my quality check leaves a durable dogfood record in the repository without manual copy-pasting.

## US2: Team Lead & Code Reviewer Traceability

As a team lead reviewing pull requests,
I want to see committed Markdown audit reports and the updated `runs.jsonl` log in `audit-reports/slop/`,
so that I can verify that architectural changes and tests were verified against parasitic bloat and vacuous checks.

## US3: CI Automation & Quality Gate

As a CI pipeline engineer,
I want to run `npm run audit:slop -- [target]` as an automated test/lint step,
so that any verified P1 blocker or uncaught slop fails the build (exit code 1) while recording machine-readable JSONL telemetry.
