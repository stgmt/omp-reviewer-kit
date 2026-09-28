# Slop Audit Dogfood History

Status: SPECIFIED

## Overview

This specification defines in-repository structured history and dogfooding persistence for the OMP Review Kit slop audit (`skill://slop`, `agents/slop.md`).

Currently, slop audits are ephemeral: when the adversarial `slop` agent orchestrates `slop-scout` and `slop-verifier`, the resulting `SlopReport` is printed into the caller session or stdout, leaving no durable trace in git. To enable real dogfooding and track code quality and debt reduction over time, all slop audits must be persisted inside the repository under `audit-reports/slop/`.

## Core Capabilities

1. **Dual Storage Model**:
   - Human-readable Markdown snapshots: `audit-reports/slop/<timestamp>-<target-slug>.md`.
   - Machine-readable append-only telemetry: `audit-reports/slop/runs.jsonl` (`slop-audit-run@1` schema).
2. **Headless CLI Runner** (`scripts/audit-slop.mjs`, `npm run audit:slop`):
   - Standalone CLI executing slop audits locally or in CI pipelines with deterministic exit codes (0 for pass/acceptable, 1 for blocked/error).
3. **Domain Persistence Architecture**:
   - Decoupled `SlopStorePort` in `src/application/ports.mjs` and `FileSystemSlopStoreAdapter` in `src/infra/filesystem-slop-store-adapter.mjs`.
   - Read-only agent invariant preserved: review agents never mutate files; the host process persists the audit artifacts.
4. **Extension Slash Command Auto-Persistence**:
   - Interactive `/slop` command in `src/extension.mjs` automatically writes snapshots and appends to `runs.jsonl` upon completion.
5. **Version Control Integration**:
   - `audit-reports/slop/` is committed to git (excluded from `.gitignore`), establishing a durable audit trail.

## Reviewer Integration

6. **Reviewer Tracked History** (`audit-reports/review/`): every `reviewer-kit` run appends `review-audit-run@1` with `diff_hash`, `confirmed_findings`, `confirmed_coverage_gaps`, and structured `decisions` for rejected and not_proven.
7. **Shared Memory** (`audit-reports/memory/memory.json`, `audit-memory@1`): single precedent index for both slop and review, keyed by content fingerprint; `contentHash` drift marks entries stale; security P1 never auto-suppressed.
