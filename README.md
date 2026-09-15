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
`@task` (each fallback is availability-probed first). If every model fails with
a provider/quota error the commit is blocked with an actionable message — this
is an infrastructure failure, not a code verdict.

```text
OMP_REVIEW_KIT_MODEL            # primary model selector (default: @smol)
OMP_REVIEW_KIT_FALLBACK_MODELS  # comma-separated fallback list (default: @task)
OMP_REVIEW_KIT_MAX_FALLBACKS    # max fallback attempts (default: 3)
OMP_REVIEW_KIT_PROBE_TIMEOUT_MS # availability probe timeout (default: 60000)
OMP_REVIEW_KIT_EFFORT           # override :effort suffix of resolved selectors (default: low; low|medium|high|max)
OMP_REVIEW_KIT_OMP              # path/name of the omp executable
OMP_REVIEW_KIT_TELEMETRY=0      # disable run telemetry writes
```

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
