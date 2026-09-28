# Changelog: slop-history

All notable changes to the slop audit dogfood history subsystem will be documented in this file.

## [Unreleased]

### Added
- Specification `.specs/slop-history/` establishing requirements, architecture, schemas, and tasks for in-repo dogfood persistence.
- Dual storage model for slop audits: Markdown reports + append-only JSONL log (`slop-audit-run@1`).
- CLI runner `scripts/audit-slop.mjs` and npm script `npm run audit:slop`.
- Domain port `SlopStorePort` and adapter `FileSystemSlopStoreAdapter`.
- Auto-persistence in interactive `/slop` extension command.
