# omp-reviewer-kit

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
[Stage 2: Parallel Risk Hunting] (review-risk-hunter x 2 batch)
  - Lane 1 (Correctness): Boundary conditions, null/default states, resource leaks, test gaps.
  - Lane 2 (Security): Untrusted sources, dangerous sinks, missing/bypassed mitigations.
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

The installer never overwrites a foreign hook. If your repository already ships a `.githooks/pre-commit` that delegates into a chain directory, adopt the review stage by adding one line to that hook:

```sh
"$hook_dir/pre-commit.d/00-omp-reviewer-kit.chain"
```

When `session_start` or `/reviewer-kit:setup` sees that marker, it deploys the owned chain entry `.githooks/pre-commit.d/00-omp-reviewer-kit.chain` (which execs the review runner) and repairs it on drift — the foreign hook file stays byte-identical. A foreign hook without the marker still reports `conflict` and is left untouched.

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

## Model Selection & Fallback

The hook runs the review on the `@smol` role by default and falls back once to
`@task` (each fallback is availability-probed first). Only OMP role selectors
(`@name`) are accepted — the child resolves the role itself, so the user's
`modelRoles` assignments and `retry.fallbackChains` apply inside the review
child. Concrete `provider/model` selectors are rejected. If every role fails
with a provider/quota error the commit is blocked with an actionable message —
this is an infrastructure failure, not a code verdict.

```text
OMP_REVIEW_KIT_MODEL            # primary model role selector (default: @smol)
OMP_REVIEW_KIT_FALLBACK_MODELS  # comma-separated @role fallback list (default: @task)
OMP_REVIEW_KIT_MAX_FALLBACKS    # max fallback attempts (default: 3)
OMP_REVIEW_KIT_PROBE_TIMEOUT_MS # availability probe timeout (default: 60000)
OMP_REVIEW_KIT_QUOTA_STALL_MS   # kill silent reviews after provider refusal (default: 300000; 0 disables)
OMP_REVIEW_KIT_MAX_TIME         # opt-in child-side bound via omp --max-time (default: off; 600|10m|1h shapes)
OMP_REVIEW_KIT_EFFORT           # map to omp --thinking (default: unset = role's configured effort; off|minimal|low|medium|high|xhigh|max|auto)
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
