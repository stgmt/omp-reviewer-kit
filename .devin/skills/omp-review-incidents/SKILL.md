---
name: omp-review-incidents
description: Investigate omp-reviewer-kit pre-commit review incidents in the native (Bun) review of 0.22.0 and later — slow or silent runs, BLOCK verdicts and host errors, unexpected reviewer model or fallback, commits stopped by the guard or never reviewed. Correlates the saved report with OMP session transcripts and OMP process logs by diff hash, session id and time.
---

# OMP Review Kit — Incident Investigation (native review, 0.22.0+)

Use this when a commit review was slow, blocked, used an unexpected model, or never ran. Goal: explain what happened from durable evidence, not guess.

The 0.22.0 kit keeps no run telemetry: no `runs.jsonl`, no `last-run.json`, no `~/.omp/review-kit-runs/`, no analyzer script. Evidence is the verdict report, the host's stderr (only while the terminal exists), the staged snapshot if the host was killed, OMP's session transcripts, and OMP's process log. The protocol and rules are in `.claude/skills/investigate-review-incident/SKILL.md`.

## Where the evidence lives

| Evidence | Path | Notes |
|---|---|---|
| Verdict report | `~/Documents/omp-reviewer-kit/<repo folder>/<UTC stamp>-<hash12>.md` (`OMP_REVIEW_KIT_REPORTS_DIR` overrides the root) | First line `# reviewer-kit review: PASS` or `BLOCK`. `Diff SHA-256` is the full hash. The file name carries the UTC save time and 12 hash characters. `<repo folder>` is `<directory name>-<hash12 of the absolute path>`. |
| Host stderr | The terminal of the `git commit` run | Not stored by the kit. Whether a commit run from an OMP session keeps them in that session's bash output is not verified. See the line list below. |
| Staged snapshot | `%TEMP%/staged-*/.review/` | Removed in `finally` (`src/native/native-review.mjs`). A leftover after the run means the host was killed or crashed. |
| Reviewer session | `~/.omp/agent/sessions/<folder for the repo path>/<UTC time>_<session uuid>.jsonl` | Header `session` is named `reviewer-kit native review`. Folder example: `--E--repos-omp-reviewer-kit--`. |
| Reviewer task transcript | `…/<UTC time>_<uuid>/Review.jsonl` | First user message is the assignment, containing `Diff hash (SHA-256 of the binary staged diff): <hash>`. |
| Stage transcripts | `…/<UTC time>_<uuid>/Review/Review.<Agent>.jsonl`, plus `.md` and `.json` artifacts | `Review.ContextScout`, `Review.CorrectnessHunter` (lane `correctness`), `Review.FindingVerifier`. Hunter names for other lanes are not verified. |
| OMP process log | `~/.omp/logs/omp.<local date>.<pid>.log` | JSON lines. `pid` is the host's `bun` process. Debug level is written by default; `OMP_LOG_LEVEL` can filter it. |
| Owner config (read-only) | `~/.omp/agent/config.yml`, `~/.omp/agent/models.yml` | Never edit during an incident. |
| Commit guard | `src/extension.mjs` (`tool_call` → `installer.guardCommit`) | Refusal text `reviewer-kit stopped this commit: ...` in the tool output. No review ran, no report. |

Timestamps: session paths and report names are UTC (`Z`). Transcript `timestamp` fields are UTC. Log `timestamp` fields carry the local offset (`+03:00` on the investigated machine). Convert before comparing.

## Host stderr lines (0.22.0)

Printed by `src/native/native-host.mjs` through the launcher `scripts/run-review.mjs`:

- `review: <N> staged path(s), profile <full|spec-docs>, lanes <...>` — start.
- `review: native task update (<N> result(s), <M> running)` — during the run. Identical consecutive lines are suppressed. This is the only live signal.
- `review: reviewer role=<role> model=<model>` and `review: stage <agent> role=... model=... exit=... structured=...` — printed only after the reviewer task ends.
- `review: PASS` or `review: BLOCK (<reasons joined by "; ">)`, then `review: report <path>`.
- `review: SKIPPED (no staged changes)` — exit 0, no report by design.
- `review: BLOCK (host error: ...)` — an exception in the host. No report.
- Launcher: `review: BLOCK (bun is required ...)`, `review: BLOCK (the OMP library is not installed ...)`, `review: BLOCK (cannot start the native review host: ...)`.
- No `review:` line at all with a non-zero exit: the host crashed or was killed before a verdict. The launcher adds nothing in that case.

## Fast path

```sh
# 1. The verdict and the evidence it cites
head -n 30 "<report path>"

# 2. The reviewer task transcript for that report (full hash from "Diff SHA-256")
grep -rl "<full Diff SHA-256>" ~/.omp/agent/sessions

# 3. Session uuid from that path, then the logs that mention it
grep -l "<uuid>" ~/.omp/logs/omp.*.log

# 4. Stage launches and exits in that log
grep '"message":"subagent launch timing"' <log>
grep '"message":"Session exit recorded"' <log>
```

Stage durations come from the transcripts, not from the exit lines (in the two runs checked, the exit lines were all written at the end of the run):

```sh
node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){const l=fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x));const t=l.map(o=>o.timestamp).filter(Boolean);console.log(f,t[0],t[t.length-1],l.length)}' <stage .jsonl files>
```

## PID ↔ log correlation

- The host's pid is not printed. Find the log by content, not by pid: the reviewer session directory (`…/<UTC>_<uuid>/…`) appears in the `sessionFile` field of the `Session exit recorded` lines in that process's log.
- Session uuid → log: `grep -l "<uuid>" ~/.omp/logs/omp.*.log`. Then the log's `pid` field gives the host process.
- Without a session uuid, match by time window: the log's first and last `timestamp` must bracket the transcript's first and last `timestamp` (after converting the offset).

## Reading an OMP log

Each line is a JSON object: `timestamp`, `level`, `pid`, `message`, plus fields.

| Message | Fields | Meaning |
|---|---|---|
| `subagent launch timing` (debug) | `id`, `agent`, `queueMs`, `preRunMs`, `resolveMs`, `sessionOpenMs`, `createSessionMs`, `readyMs`, `promptToFirstChatMs`, `setupToFirstChatMs`, `invokeToFirstChatMs` | A stage was launched. `id` `Review` is the reviewer-kit task; `Review.<Stage>` are its stages. |
| `Session exit recorded` (level varies: debug or warn in the runs checked) | `sessionId`, `sessionFile`, `reason`, `kind`, `pendingToolCalls` | A session ended. `sessionFile` points into the sessions tree. In the two runs checked, all of them were written together at the end of the run. |
| `title-generator: start`, `title-generator: request`, `title-generator: success` | — | Noise for review analysis. |
| `model discovery failed for provider` (warn) | `provider`, `url`, `error` | Local providers that are not running (`llama.cpp`, `lm-studio` on the investigated machine). Noise unless the failed provider is the one in use. |
| `task: no AsyncJobManager registered; falling back to sync execution` (warn) | — | The native host runs tasks synchronously. Noise. |
| `devin: sending chat request` (debug) | — | Only the `devin` provider emits a per-request debug line in 18.12.5. Do not expect one for other providers; use the transcript. |

## Reading a transcript

JSON lines. Entry `type` values seen in native reviews:

- `session` — header with `cwd`, `id`, `timestamp`.
- `model_change` — `model`, `resolvedModelIsFallback`, `runtime.version`. `resolvedModelIsFallback: true` means the model was selected by retry fallback routing (`coding-agent/src/registry/agent-registry.ts`, `AgentHistorySummary`).
- `message` — `role`, `provider`, `model`, `stopReason`, `errorMessage` (only when set), `usage`, `duration`, `ttft` (time to first token), `completedAt`, `timestamp`, `toolName`, `isError`.
- `custom` — `tool_execution_start`, `session_exit`, `system-prompt-digest`.

`stopReason` values: `toolUse` is a tool call. `error` and `aborted` are failures (`pi-ai/src/error/finalize.ts`); read `errorMessage` for the cause. Provider status codes such as 401, 403 or 429 appear there when the provider reports them; not verified for every provider. Do not paste `errorMessage` payloads with credentials into reports.

## Diagnosing slow runs

1. Whole run: the report's time (UTC in its name) minus the reviewer session's first `timestamp`.
2. Per stage: first and last `timestamp` of `Review/Review.<Agent>.jsonl` (see the snippet above). Stages that ran in sequence show non-overlapping ranges.
3. Inside a stage: the `message` entries with the largest `duration` and `ttft`, and their `usage`. A large `ttft` points to the provider; a large gap between messages points to tool execution or OMP's own work.
4. Startup: `subagent launch timing` gives `queueMs`, `createSessionMs` and `invokeToFirstChatMs` per stage.
5. A quiet transcript is not a hang proof. Check whether the host process is alive and whether the last `message` has a `stopReason`. Whether 18.12.5 writes a transcript entry only at message completion is not verified.

## Diagnosing wrong-model runs

- Compare `review: reviewer role=... model=...` and the report's `Reviewer role/model (OMP resolved)` with the `model_change` entries in `Review.jsonl` and the stage transcripts.
- `resolvedModelIsFallback: true` means a fallback happened. Read the failing message's `errorMessage` just before the change.
- Owner config: `~/.omp/agent/config.yml` (`modelRoles`, `retry.fallbackChains`). Check the keys against OMP's settings source, not memory.
- `agentModelOverrides` exists in OMP 18.12.5 (`coding-agent/src/task/settings.ts`, in the pinned package's source). If a stage ran on a model its role does not name, check that key. How it is applied is not verified.
- The kit does not set a model. `OMP_REVIEW_KIT_MODEL` is not read by the review path; only `scripts/audit-range.mjs` reads it.

## Diagnosing BLOCKs

- `review: BLOCK (<reasons>)`: the same reasons appear in the report under `Verdict reasons`. Map them:
  - `reviewer verdict BLOCK` — a review decision. Read the report text.
  - `reviewer task exit N`, `reviewer task aborted`, `reviewer yield <status>` — the reviewer task failed. Read its transcript's last `stopReason` and `errorMessage`.
  - `no completed stage evidence for review-context-scout` (and similar) — the stage did not finish with `exitCode 0` and `structured valid`. Read its stage line (`structured=`) and its `.json` artifact.
  - `no completed review-risk-hunter task for planned lane(s): ...` — a planned lane has no completed hunter.
  - `reviewer yield carries no Markdown report` — the reviewer yielded a payload that is not a single `report` string.
- `review: BLOCK (host error: ...)` — exception in the host. No report is written.
- No `review:` lines and a non-zero exit — the host was killed or crashed before a verdict. Check for a leftover `%TEMP%/staged-*` directory and the last lines of the host's log.
- A PASS is valid only with an exact single `REVIEW_RESULT=PASS` marker as the last line (`readVerdictMarker`). Never call a run PASS from partial stage evidence.

## Commits that never reached review

- `reviewer-kit stopped this commit: ...` (guard in `src/extension.mjs`, `installer.guardCommit`): git would run something other than the kit's hook (`core.hooksPath`). Unless `OMP_REVIEW_KIT_AUTO_SYNC=0`, the guard tries to repair the checkout; if the repair works, the commit goes through with a warning. If the repair is disabled or fails, the commit is blocked. `OMP_REVIEW_KIT_GUARD=0` turns the guard off entirely. If it is set during an incident, that is part of the finding.
- `--no-verify`: a bypass by the committer. Git skips the hook, so the kit runs nothing and writes no report or log entry. Investigate from the commit history and the consumer's report, and report it as an incident.
- `review: SKIPPED (no staged changes)`: no report by design.

## Status and progress

- No status file exists in 0.22.0. The status line is kept in memory (`setReviewStatus` in `src/extension.mjs`). Nothing is left to read after the fact.
- Live progress is the `review: native task update` line in the commit's terminal. Once the terminal is gone, use the process check and the transcript tail.

## Hygiene

- Never paste raw transcript or log contents into reports. Cite status codes, model names, counts, timings and field names.
- Never copy keys, tokens or credentials from `errorMessage` or config files.
- Report files contain reviewer text; quote only what the question needs.
- Keep the UTC and local-offset distinction visible in every timeline you write.
