---
name: omp-review-incidents
description: Investigate omp-reviewer-kit pre-commit review incidents — slow runs, unexpected model use, provider/quota failures, status-line gaps. Correlates repo telemetry (runs.jsonl, last-run.json) with OMP process logs by PID or time window.
---

# OMP Review Kit — Incident Investigation

Use this when a commit review was slow, blocked, used the wrong model, or the
status line stayed stale. Goal: explain what happened from durable evidence,
not guess.

## Where the evidence lives

| Evidence | Path |
|---|---|
| Per-run event stream (one JSON object per line, `schema: review-run-event@1`) | `<repo>/audit-reports/commit-reviews/runs.jsonl` |
| Live/last run state (`schema: review-last-run@1`) | `<repo>/audit-reports/commit-reviews/last-run.json` |
| Verdict report per review | `<repo>/audit-reports/commit-reviews/<timestamp>-<hash>.md` |
| OMP process logs (JSONL; filename = `omp.<date>.<pid>.log`) | `~/.omp/logs/` (`C:\Users\<user>\.omp\logs\` on Windows) |
| OMP agent sessions (subagent transcripts) | `~/.omp/agent/sessions/` and `%TEMP%/omp-task-*/` |
| HTTP 4xx request dumps | `~/.omp/logs/http-400-requests/` |
| OMP role→model mapping | `~/.omp/agent/config.yml` (`modelRoles`, `agentModelOverrides`, `modelFallback`) |

## Fast path

```sh
npm run analyze-review              # latest run in this repo
node scripts/analyze-review-run.mjs --all          # all recorded runs, one line each
node scripts/analyze-review-run.mjs <runId>        # specific run, full trace
node scripts/analyze-review-run.mjs --log ~/.omp/logs/omp.YYYY-MM-DD.<pid>.log
node scripts/analyze-review-run.mjs --json         # machine-readable
```

The analyzer prints: verdict, duration, models tried, per-attempt pid/status/
providerFailure, the correlated OMP log, request count, models actually used,
max/last requestBytes (context growth), per-stage launch→exit timing, and
provider-error classes (429/quota, 401, 403).

## PID ↔ log correlation

- `review_attempt_started` / `probe_finished` events carry `pid` of the spawned
  child. With a native `omp` executable this pid equals the one in
  `omp.<date>.<pid>.log`.
- If `OMP_REVIEW_KIT_OMP` points to a `.cmd`/`.bat` wrapper, `pid` is `cmd.exe`.
  The analyzer falls back to time-window correlation and labels it
  `(correlated by time window)`. Verify by checking the log's first timestamp
  is inside the attempt window.
- `run_finished.ompLogHints` lists `~/.omp/logs/omp.*.<pid>.log` globs.

## Reading an OMP log

Each line is a JSON object: `timestamp`, `level`, `pid`, `message`, plus fields.

| Signal | Message pattern | Meaning |
|---|---|---|
| Model request | `*: sending chat request` (`model`, `requestBytes`, `compressedBytes`) | One LLM call; requestBytes growth = context growth |
| Stage start | `subagent launch timing` (`id`, `agent`, `invokeToFirstChatMs`) | Orchestrator spawned a subagent (scout/hunter/verifier) |
| Stage end | `Session exit recorded` (`sessionFile` basename = stage id) | Subagent finished/disposed |
| Provider failure | level warn/error + `401`/`403`/`429`/`quota`/`RESOURCE_EXHAUSTED` | Auth/quota outage; triggers fallback chain |
| Title/other noise | `title-generator:*`, `TTSR rule registered` | Ignore for review-latency analysis |

Stage ids observed: `StagedReview.ContextScout`, `.SecurityHunter`,
`.CorrectnessHunter`, `.Verifier`, and `StagedReview` (orchestrator synthesis).

## Diagnosing slow runs

1. `attempts[].durationMs` vs log `requests`: ~40 min + ~190 requests means
   agent-turn-bound, not single-request latency. Each tool call (read/grep/
   bash/lsp) = one more chat request with the whole transcript resent.
2. `maxRequestBytes` >300KB = context accumulation; check whether subagents
   re-derive the diff via git commands instead of reading it from the prompt.
3. Stage table: if SecurityHunter/CorrectnessHunter launch times are minutes
   apart, the "parallel" batch ran serially — suspect OMP task batching or a
   busy provider.
4. Long gap between `run_started` and first `subagent launch timing` = the
   orchestrator itself burned time before Stage 1 (reading skills, git calls).
5. `providerErrors` mid-run = retries/stalls from quota; correlate with
   `http-400-requests/` dumps (contains payloads — do not paste raw contents
   into reports; note status code + provider only).

## Diagnosing wrong-model runs

- Compare `modelsTried` in telemetry + `model` fields in `sending chat request`
  lines against `~/.omp/agent/config.yml`:
  - `modelRoles` (smol/task/slow/…) — runner pins `--model/--slow/--smol` to the
    selected selector; `@smol`/`@task` resolve to whatever the user configured.
  - `agentModelOverrides` — silently override agent frontmatter `model:` and can
    defeat the intended chain.
- A run on an unexpected model after a config edit usually means the OMP
  process/session predates the edit, or `OMP_REVIEW_KIT_MODEL` is set in env.

## Diagnosing BLOCKs

- `verdict BLOCK` + envelope `kind: review_failure` + `providerFailure` on all
  attempts = infrastructure outage, not a code verdict. The runner now prints
  an actionable stderr block listing models attempted and how to repoint
  `modelRoles.smol`/`modelRoles.task` or `OMP_REVIEW_KIT_MODEL`.
- Envelope `kind: findings` = real review rejection; read the report file.

## Status-line issues

- The extension shows live state from `last-run.json` (polled every ~2s during
  an active `git commit` tool call). If the status is stale: check the file's
  `updatedAt` freshness; if absent, the repo runs an outdated runner copy —
  update `.omp/review-kit/run-review.mjs` (must equal `scripts/run-review.mjs`).
- Streamed `reviewer-kit progress:` lines are best-effort only; do not rely on
  them for diagnosis — use `runs.jsonl`/`last-run.json`.

## Hygiene

- Never paste `http-400-requests/` payloads, `sessions/*.jsonl` content, or
  config tokens into reports. Cite status codes, model names, counts, timings.
- `last-run.json` is last-writer-wins under concurrent commits — a stale or
  missing file is not proof a run did not happen; check `runs.jsonl`.
- If `git rev-parse --show-toplevel` fails there is no telemetry at all — the
  runner cannot locate the report directory.
