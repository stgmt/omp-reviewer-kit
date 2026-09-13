# Review Observability Domain Spec

Status: implemented (2026-09-12).
Date: 2026-09-12. Supersedes no prior document; extends `audit-reports/multi-stage-review-architecture.md`.

## 1. Problem Statement

A commit review is currently a black box:

- The runner emits `reviewer-kit progress: [...]` lines to **stderr only**; nothing is persisted.
- The audit report (`audit-reports/commit-reviews/<ts>-<hash>.md`) records only `result` and `reviewer models tried` — no durations, no per-attempt data, no child PID, no stage timing.
- The OMP session status bar entry (`reviewer-kit: active` / `unconfigured` from `session_start`) is static: it never reflects a running or finished review, because the hook runs in a detached child process with no TUI channel. Users perceive it as "not working".
- OMP does write rich diagnostics (`~/.omp/logs/omp.<date>.<pid>.log`, `http-400-requests/*.json`, `%TEMP%/omp-task-*/**.jsonl` transcripts), but **nothing links a review report to its OMP child PID**, so reconstructing an incident requires manual log archaeology.

Goal: every review run must be traceable end-to-end — wall-clock, per-attempt and per-stage timings, models used, provider failures, child process identity — without weakening any fail-closed invariant.

## 2. Domain Boundaries

New bounded context: **Review Telemetry** (`telemetry`). It observes the existing domain; it never feeds back into it.

- Owned by: application layer (`ReviewWorkflowService` emits lifecycle events; `OmpCliReviewerAdapter` emits attempt/probe events).
- Infrastructure: `FileSystemTelemetryAdapter` (append-only JSONL store).
- Port: `TelemetryPort` (`record(event)`), injected like other ports.
- Non-goal: capturing prompt text, diff content, model output, tool payloads. Telemetry stores identifiers, timings, sizes, and statuses only — no secrets, no code content.
- Hard invariant: telemetry failure must never change the verdict, the exit code, or the review flow. All adapter writes are best-effort; errors are swallowed to stderr at debug level only.

## 3. Storage Layout

Under the existing gitignored audit directory (`audit-reports/commit-reviews/` is already in `.gitignore`):

```
audit-reports/commit-reviews/
  <ts>-<hash>.md          # existing human report (unchanged)
  runs.jsonl              # append-only event stream, one JSON object per line
  last-run.json           # rewritten per run: compact final state for status/doctor
```

- `runs.jsonl` is the single source of truth for incident investigation. Append-only; events carry `runId` so concurrent or retried runs stay separable.
- `last-run.json` is a denormalized summary of the most recent finished run (`verdict`, `durationMs`, `modelsTried`, `reportPath`, `finishedAt`) plus, while a run is active, the live state (`state`, `elapsedMs`, `model`, `pid`). The extension's `/reviewer-kit:status` and `session_start` hook read this file — this replaces the static status-bar text with real state.
- Rotation: out of scope for v1 (gitignored, ~1–3 KB per run). Revisit if a repo accumulates >10k runs.

## 4. Event Catalog (`schema: "review-run-event@1"`)

Every event: `{ schema, runId, type, at, ...payload }`. `runId = <reportTimestamp>-<diffHash12>` (or `-skipped` when no diff exists); `at` = ISO 8601.

| type | payload | emitted by |
|---|---|---|
| `run_started` | `cwd`, `repoRoot`, `node`, `platform` | workflow |
| `review_chain` | `primaryModel`, `maxFallbacks`, `probeTimeoutMs` | adapter |
| `diff_collected` | `diffHash`, `diffBytes` | workflow |
| `snapshot_materialized` | `files`, `bytes`, `durationMs` | workflow |
| `review_attempt_started` | `model`, `attemptIndex`, `pid` | adapter |
| `review_attempt_first_output` | `model`, `attemptIndex`, `pid`, `elapsedMs` | adapter (first stdout byte) |
| `review_attempt_working` | `model`, `attemptIndex`, `pid`, `elapsedMs` | adapter (first `Working...` stderr signal) |
| `review_attempt_finished` | `model`, `attemptIndex`, `pid`, `status`, `durationMs`, `providerFailure`, `stdoutBytes`, `stderrBytes` | adapter |
| `probe_started` | `model` | adapter |
| `probe_finished` | `model`, `pid`, `durationMs`, `status` | adapter |
| `verdict_evaluated` | `verdict`, `envelopeKind`, `findings` | workflow |
| `report_written` | `reportPath`, `durationMs` | workflow |
| `run_finished` | `verdict`, `exitCode`, `durationMs`, `modelsTried`, `attemptCount`, `probeCount`, `ompLogHints` | workflow |
| `run_skipped` | `reason` | workflow |
| `run_failed` | `error` (message only) | workflow (infra error path) |

The default fallback chain is `@smol → @task` (role selectors), so no
`catalog_fetch_*` events exist — catalog probing was removed from the default
path; `OMP_REVIEW_KIT_FALLBACK_MODELS` still overrides the candidate list.

`pid` on attempt/probe events is the spawned `omp` child PID — the join key to `~/.omp/logs/omp.<date>.<pid>.log`. `ompLogHints` in `run_finished` lists expected log file paths for each recorded pid.

## 5. Per-Stage Visibility

The runner cannot see inside the OMP session; stage boundaries live in the child log. Spec therefore defines a **post-hoc analyzer**, not inline instrumentation:

- `scripts/analyze-review-run.mjs [runId] [--all] [--json] [--log <omp.log>]` (npm: `analyze-review`):
  1. Reads `runs.jsonl`, resolves the run's attempt `pid`s.
  2. Parses `~/.omp/logs/omp.<date>.<pid>.log` for `subagent launch timing` (agent name, id), `sending chat request` (per-model call counts, `requestBytes` growth), `Session exit recorded` (stage transcript paths and exit times), and provider-error lines (401/403/429/quota classes).
  3. Emits a stage table: pre-dispatch orchestrator time, scout/hunter-security/hunter-correctness/verifier/synthesis windows, calls per stage, provider errors, fallback chain.
  4. PID correlation is direct for a native `omp` executable; when `OMP_REVIEW_KIT_OMP` is a `.cmd`/`.bat` wrapper the recorded pid is `cmd.exe`, and the analyzer falls back to time-window correlation, labeling it explicitly.
- The analyzer is read-only and works on historical runs — it is also the verification tool for this spec (evidence-first).

## 6. Wiring

- `ReviewWorkflowService.execute` wraps the lifecycle; `OmpCliReviewerAdapter` gets an optional `telemetry` collaborator; `defaultRunner` exposes the child `pid` (currently discarded) via the result object or a callback.
- `createReviewWorkflowService` composes `FileSystemTelemetryAdapter` by default; `telemetry: null` disables (tests inject stubs).
- Extension (`src/extension.mjs`): `/reviewer-kit:status` reads `last-run.json`; `session_start` reports `reviewer-kit: last=<verdict> <ago>` when a record exists, else the current static text.
- Env: `OMP_REVIEW_KIT_TELEMETRY=0` disables persistence; `OMP_REVIEW_KIT_TELEMETRY_DIR` overrides the directory (tests, nonstandard layouts).

## 7. Mirroring & Tests

- Change lands in `scripts/run-review.mjs` **and** `.omp/review-kit/run-review.mjs` byte-identically (`check-layout` enforces), plus the modular `src/` equivalents (`ports.mjs`, `review-workflow-service.mjs`, `omp-cli-reviewer-adapter.mjs`, new `src/infra/filesystem-telemetry-adapter.mjs`).
- Tests (BDD style, `node:test`):
  - telemetry adapter appends valid JSONL events and tolerates unwritable dirs (no throw, no verdict change);
  - workflow emits `run_started`/`run_finished` with pid-carrying attempt events (stub runner returns fake pid);
  - `skipped` diff still writes `run_skipped`;
  - provider-failure run records `probe_*` and `review_attempt_*` sequence;
  - `last-run.json` reflects final verdict;
  - e2e hook run leaves a `run_finished` line with `ompLogHints`.
- Mutation runner gains cases around telemetry swallowing (e.g., telemetry throwing must still produce identical exit codes).

## 8. Acceptance Criteria

1. After any commit attempt, `runs.jsonl` contains a complete event chain ending in `run_finished`/`run_skipped`/`run_failed`, and `last-run.json` exists.
2. Every `review_attempt_*`/`probe_*` event carries the child `pid`; `scripts/analyze-review-run.mjs --run last` prints the stage timeline joined from the OMP pid log.
3. Disabling telemetry or pointing it at an unwritable path changes nothing about PASS/BLOCK/exit codes.
4. `/reviewer-kit:status` and session start show the real last verdict and duration.

## 9. Follow-up Domain Work (out of scope here, enabled by telemetry)

- ~~`@smol`-primary + `@task` fallback chain with UX-complete BLOCK on total provider outage~~ — shipped with this change.
- ~~`.devin/skills/omp-review-incidents` playbook~~ — shipped with this change.
- Budget controls for subagents informed by measured per-stage call counts (see incident analysis from 2026-09-12: hunters at 48–78 model calls each, max request ~500KB).
- Real Stage-2 parallelism and diff-in-prompt redesign — pending measured data from `runs.jsonl`.
