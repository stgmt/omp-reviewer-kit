# omp-reviewer-kit

[![review-kit](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fstgmt%2Fomp-reviewer-kit%2Fmain%2Faudit-reports%2Freview-badge.json)](audit-reports/review-badge.full.json)

Native Oh My Pi plugin for multi-stage, evidence-first code review of staged Git changes.

## Names

- GitHub and plugin: `omp-reviewer-kit`
- Orchestrator agent: `reviewer-kit`
- Specialist agents: `review-context-scout`, `review-risk-hunter`, `review-finding-verifier`
- Review skills: `reality-first-review`, `multi-stage-review`
- OMP extension: `src/extension.mjs`

## What It Does

`omp-reviewer-kit` provides a fail-closed Git pre-commit hook powered by a 4-stage hierarchy of specialized OMP agents running on your local machine:

```
Staged Diff (git diff --cached --binary --no-ext-diff --)
                    │
                    ▼
[Stage 1: Context Scout] (review-context-scout)
  - Maps blast radius, touched files, callers/consumers via LSP/grep, invariants, and tests.
  - Generates structured context without judging code or emitting findings.
                    │
                    ▼
[Stage 2: Parallel Risk Hunting] (review-risk-hunter batch per lane)
  - Profile `full`: Correctness lane by default; Security lane via `OMP_REVIEW_KIT_LANES=correctness,security`.
  - Profile `spec-docs`: Content-risk lane only (secrets in text, doc-vs-code contradictions, dead links/steps).
  - Anti-Noise Prohibitions: Strictly rejects comments, formatting, naming, and ungrounded advice.
                    │
                    ▼
[Stage 3: Adversarial Verification] (review-finding-verifier)
  - Defense Attorney: Assumes the author is correct until disproven by repository evidence.
  - Challenges each candidate against upstream protections, caller constraints, and reachability.
  - Categorizes candidates into confirmed, rejected, or not_proven.
                    │
                    ▼
[Stage 4: Orchestrator Synthesis] (reviewer-kit)
  - Synthesizes coverage, validated findings, and rejected summaries.
  - Emits the final machine-readable verdict marker:
```

The commit proceeds only when the orchestrator emits exactly one solitary line:

```text
REVIEW_RESULT=PASS
```

Any confirmed `P1` or `P2` finding, missing/failed stage, malformed marker, or process timeout strictly blocks the commit (fail-closed). Default execution timeout is 10 minutes (`600_000ms`), overridable via `timeoutMs`.

### Review Profiles & Risk Lanes

- **`full` profile** (diff contains executable code or tests): Runs the complete 4-stage pipeline with test coverage mapping. Stage 2 runs the `correctness` lane by default; set `OMP_REVIEW_KIT_LANES=correctness,security` to run both correctness and security lanes concurrently.
- **`spec-docs` profile** (diff contains only documentation, specifications, agent/skill prompts, or configuration): Automatically selects a reduced review without the coverage requirement, focusing on `content-risk` findings.

## Standard Installation (Recommended)

Install the plugin using the official Oh My Pi plugin manager:

### Option A: From GitHub directly

```bash
omp plugin install github:stgmt/omp-reviewer-kit
```

### Option B: Via OMP Marketplace

```bash
# Add the marketplace
omp plugin marketplace add stgmt/omp-reviewer-kit

# Install in project scope
omp plugin install omp-reviewer-kit@omp-reviewer-kit --scope project

# Or install globally in user scope
omp plugin install omp-reviewer-kit@omp-reviewer-kit --scope user
```

## Configuring the Hook via OMP Slash Commands

Once installed, manage the review hook directly inside your OMP session without leaving the terminal:

- `/reviewer-kit:setup` — Automatically configures the pre-commit review hook in the active Git repository (`core.hooksPath .githooks`).
- `/reviewer-kit:status` — Displays current hook configuration, runner integrity, and the latest review verdict.
- `/reviewer-kit:doctor` — Runs environment and toolchain health checks (Node.js, Git, OMP CLI, hook permissions).

The plugin also observes `session_start`: opening any Git repository in OMP auto-installs the review hook in the background (manual `/reviewer-kit:setup` remains as fallback), and updates the OMP status bar indicator (`reviewer-kit: active` or `reviewer-kit: unconfigured`).

### Coexisting with an existing `.githooks/pre-commit`

The installer never overwrites a foreign hook. If your repository already ships a `.githooks/pre-commit`, adopt the review stage by adding one bare invocation line to that hook:

```sh
"$hook_dir/pre-commit.d/00-omp-reviewer-kit.chain"
```

The line must invoke exactly that entry name — no arguments, no `&&`/`;` chaining, no other `*.chain` basename. A hook that enumerates the directory (`for h in "$hook_dir/pre-commit.d"/*.chain; do "$h"; done`) is also adopted, since it picks up the entry once deployed.

When `session_start` or `/reviewer-kit:setup` sees either shape, it deploys the owned chain entry `.githooks/pre-commit.d/00-omp-reviewer-kit.chain` (which execs the review runner) and repairs it on drift — the foreign hook file stays byte-identical. A foreign hook that calls a different entry name, or has no chain marker at all, still reports `conflict` and is left untouched.

## Standalone / CI Installation (Fallback)

For CI environments or machines without an interactive OMP shell, standalone scripts remain available as secondary fallbacks:

```powershell
pwsh ./scripts/install-hook.ps1 -Repository E:/repos/your-project
```

Or on POSIX systems:

```sh
./scripts/install-hook.sh /path/to/your-project
```

## Reports

Every review generates an immutable audit record in the target repository at:

```text
audit-reports/commit-reviews/<timestamp>-<diff-hash>.md
```

Reports record:
- Staged diff hash and review timestamp
- Review coverage (inspected paths, loaded project skills, executed stages)
- Confirmed findings (priority, line ranges, observed vs. expected, trigger, impact, evidence)
- Unproven and rejected candidate summaries with defense justifications
- Machine-readable verdict marker (`REVIEW_RESULT=PASS` or `REVIEW_RESULT=BLOCK`)

### Report delivery and project policy guards

The review child is a dispatcher plus a `reviewer-kit` task; the dispatcher's stdout is the only thing the runner parses, so the full report must survive the hop from the task. Two channels guarantee that, and neither depends on the dispatcher reading anything back:

1. **Session artifacts (primary fallback, no write).** Every review attempt runs `omp` with its own `--session-dir` (a `reviewer-kit-session-<pid>-*` directory under the OS temp dir, removed after the attempt). When the dispatcher output has no standalone verdict marker, or carries an `execution_failure` envelope, the runner reads the task's complete result from `<session>/<artifacts>/<TaskId>.md` and evaluates that instead. Telemetry records `report_artifact_recovered`. A reviewer verdict is never invented: the recovered text goes through the same fail-closed `ReviewVerdict` / envelope validation as any other output.
2. **Durable report file (best effort).** The prompt names a per-run path (`reviewer-kit-report-*.md` in the OS temp dir) and the same path is exported to the review child as `OMP_REVIEW_KIT_REPORT_PATH`. The orchestrator tries one bash heredoc write to it before yielding and does not retry if it is denied.

**Projects that guard bash commands** (for example an extension that hard-denies commands containing `;`, `&`, `|`, a backtick or `$`) will deny that heredoc, because a Markdown report contains those characters. That no longer fails the review — channel 1 covers it — but you can keep channel 2 working by exempting exactly one write, keyed on the exported path rather than on a command pattern:

```ts
// In a deny-first tool_call guard, before the chained/substituted-command deny:
const reportPath = process.env.OMP_REVIEW_KIT_REPORT_PATH?.replace(/\\/g, "/");
function isReportWrite(command: string): boolean {
  const lines = command.trim().split(/\r?\n/);
  // cat > "<report path>" <<'DELIM' ... DELIM  — one heredoc, nothing else.
  const heredoc = lines[0].match(/^cat\s*>\s*"?([^"\s]+)"?\s*<<\s*'(\w+)'$/);
  return !!reportPath && !!heredoc
    && heredoc[1].replace(/\\/g, "/") === reportPath
    && lines.at(-1) === heredoc[2];
}
if (event.toolName === "bash" && isReportWrite(String(event.input.command ?? ""))) return;
```

Keep the exemption narrow (single heredoc, target equal to `OMP_REVIEW_KIT_REPORT_PATH`); the reviewer is otherwise read-only and must keep being blocked from other writes. If you skip the exemption entirely, only the secondary copy is lost.

## Claude Code Plugin and Target Sync

The Claude Code plugin is a thin shell over the OMP plugin (the review always runs on OMP): `/plugin marketplace add stgmt/omp-reviewer-kit`, `/plugin install omp-reviewer-kit`, then `/omp-reviewer-kit:install-omp` (checks what is already installed, shows the plan, and installs OMP and the OMP plugin only after your confirmation), `/omp-reviewer-kit:setup` for the current repository, and `/omp-reviewer-kit:review` before committing. `/omp-reviewer-kit:doctor` diagnoses the setup. Installing the OMP plugin does not install the Claude plugin; removing the Claude plugin does not remove a repository's hook.

A repository has exactly one git hook and one vendored runner (`.omp/review-kit/run-review.mjs`). They are written only by the OMP plugin's installer, whichever channel invoked it, and an installed runner newer than the installer's own is never replaced. `/omp-reviewer-kit:review` runs that same runner file, so it agrees with the hook. To roll a new runner out to several repositories run `node scripts/sync-targets.mjs` (dry run) or `--apply`, then commit each repository through its own hook. The vendored runner and hook are the review plugin, not the committer's work: when the staged `.omp/review-kit/run-review.mjs` or `.githooks/pre-commit` is byte-identical (line endings aside) to the copy in the installed OMP plugin (`OMP_REVIEW_KIT_PLUGIN_DIR`, else `~/.omp/plugins/node_modules/omp-reviewer-kit`), the hook leaves it out of the reviewed diff, and a commit made only of such files is skipped (`reviewer-kit SKIPPED: no reviewable staged changes`). A hand-edited copy, or any doubt (no installed plugin, unreadable blob), keeps the file in review.

## Verdict Reuse

A PASS is reused when the staged tree and diff hash are identical to an earlier PASS whose report is still present (14 days). BLOCK is never reused. Set `OMP_REVIEW_KIT_CACHE=0` to force a fresh review.

## Delta Rounds

After a BLOCK with confirmed findings, the next review of a changed diff (within 12 hours) is told which findings were raised and which lines changed since, must verify each previous finding, and only raises new P2 findings inside that delta (new P1 anywhere). A PASS resets the chain. Set `OMP_REVIEW_KIT_ROUNDS=0` to review every diff from scratch.

## Review Speed

A review stage lasts (model turns) x (the model's per-turn latency), so the runner removes turns instead of changing models:

- **Context pack**: the runner writes a deterministic pack (changed files, changed symbols with their references, test-file mapping) and points the scout at it; the scout reads it with the diff and the changed files in one batch.
- **Scout baseline**: after a BLOCK the next round reuses the scout's `coverage_map` and only re-derives what the delta touches, so coverage stops drifting between rounds. `OMP_REVIEW_KIT_ROUNDS=0` disables it together with delta rounds.
- **Hunter shards**: a diff above `OMP_REVIEW_KIT_SHARD_BYTES` (default 40000; `0` disables) is split into at most `OMP_REVIEW_KIT_MAX_SHARDS` (default 3) file groups hunted in parallel.
- **No suite runs by agents**: the dispatcher supplies the execution evidence; the agents only read.
- **Telemetry**: `stage_stats` events in `runs.jsonl` (turns, tool calls, turn latency per stage), printed by `npm run analyze-review`.

## Models

reviewer-kit does not choose, pass, or fall back between models. OMP is your
tool: you log in, assign the default model role, and configure fallbacks
(`modelRoles`, `retry.fallbackChains`, `modelFallback` in
`~/.omp/agent/config.yml`) yourself, and the review child and all four agents
inherit exactly that. The hook only asks OMP for a verdict and gets `PASS`,
`BLOCK`, or an error.

Before the four stages start, the runner makes one short model-less health
call. If OMP cannot reach a model (missing login, dead provider, exhausted
quota with no configured fallback) the commit is blocked within seconds with a
message telling you to fix the OMP configuration. This is an infrastructure
failure, not a code verdict. A hard OMP child crash with no output is re-run
once.

```text
OMP_REVIEW_KIT_PREFLIGHT_TIMEOUT_MS # health-call timeout (default: 90000)
OMP_REVIEW_KIT_MAX_TIME         # opt-in child-side bound via omp --max-time (default: off; 600|10m|1h shapes)
OMP_REVIEW_KIT_SKILLS           # extra skill globs the review child lists via omp --skills, added to the always-included plugin skills (default extras: *reviewer-kit*,*review-kit*; all = full catalog)
OMP_REVIEW_KIT_OMP              # path/name of the omp executable
OMP_REVIEW_KIT_TELEMETRY=0      # disable run telemetry writes
OMP_REVIEW_KIT_ASSERT_PATTERNS    # comma-separated regexes identifying assert statements (suspicion map)
OMP_REVIEW_KIT_TEST_PATH_PATTERNS # comma-separated regexes identifying test file paths (suspicion map)
OMP_REVIEW_KIT_EXECUTE=1          # enable opt-in pre-review check execution (default: 0)
OMP_REVIEW_KIT_EXECUTE_COMMAND    # shell command to run in staged/reverted snapshots (e.g. npm test)
OMP_REVIEW_KIT_EXECUTE_TIMEOUT_MS # timeout for check execution (default: 600000)
OMP_REVIEW_KIT_EXECUTE_LINK_DIRS  # comma-separated dir names to link from repoRoot (default: node_modules,.venv,venv)
OMP_REVIEW_KIT_RED_PROOF=1        # enable reverted snapshot run for red proof (default: 0)
```

## Commit-Range Audit CLI

Audit an entire commit range for stealth test weakening, deleted assertions, vacuum checks, and neuroslop:

```sh
node scripts/audit-range.mjs <base>..<head>
node scripts/audit-range.mjs <base>..<head> --json
node scripts/audit-range.mjs <base>..<head> --out report.md
node scripts/audit-range.mjs <base>..<head> --llm
```

The CLI runs a deterministic pass across each commit using `SuspicionMap`, aggregates net assert deltas and deleted test files, and optionally invokes the native `review-range-auditor` agent (`--llm`) to adversarially challenge the change history under `skill://range-audit`.

### Pre-Review Check Execution & Red-Proof Matrix

When `OMP_REVIEW_KIT_EXECUTE=1` is configured with `OMP_REVIEW_KIT_EXECUTE_COMMAND`, the dispatcher executes the command in the staged snapshot before starting the review. If `OMP_REVIEW_KIT_RED_PROOF=1` is also enabled and both test and non-test files were modified, it creates a reverted snapshot (non-test files reverted to HEAD) and runs the same command to verify whether tests can fail without the code changes.

The 2×2 interpretation matrix is passed directly to the review agents:
- **staged pass + reverted fail**: tests prove the change; red proof achieved.
- **staged pass + reverted pass**: tests do not discriminate the change; raises a P2 correctness candidate when test files were touched.
- **staged fail + reverted pass**: change breaks the project's own checks; raises a P1 correctness candidate.
- **staged fail + reverted fail**: pre-existing failure; compare output tails.
- **unavailable**: check execution was unavailable or failed; absence proves nothing (fail-open).

Point `modelRoles.smol` and `modelRoles.task` in `~/.omp/agent/config.yml` at
fast, available models to keep reviews quick. Note that `agentModelOverrides`
in that file silently override agent `model:` frontmatter.

## Run Telemetry & Incident Analysis

Every run appends `review-run-event@1` records to
`audit-reports/commit-reviews/runs.jsonl` (attempts, probes, PIDs, timings,
verdict) and maintains `last-run.json` as the live status channel — the OMP
status bar polls it while a commit is running, and `/reviewer-kit:status`
surfaces the last run.

```sh
npm run analyze-review            # latest run: per-attempt timing + OMP log trace
node scripts/analyze-review-run.mjs --all   # all recorded runs
node scripts/analyze-review-run.mjs --log ~/.omp/logs/omp.<date>.<pid>.log
```

See `audit-reports/review-observability-domain-spec.md` for the domain spec and
`.devin/skills/omp-review-incidents/SKILL.md` for the investigation playbook.

## Development & Testing

```sh
npm test                  # runs native node:test suites (unit, BDD, layout, marketplace, hook E2E)
npm run test:mutation     # runs dependency-free safety mutation test gate (100% killed required)
npm run check             # asserts repository layout integrity and zero runner drift
```

### Opt-in Live OMP End-to-End Verification

To exercise real model execution with native OMP CLI without mocks:

```sh
OMP_REVIEW_KIT_LIVE_E2E=1 node --test tests/live-e2e-omp.test.mjs
```
