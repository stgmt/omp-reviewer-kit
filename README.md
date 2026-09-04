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

The plugin also observes `session_start` and updates the OMP status bar indicator (`reviewer-kit: active` or `reviewer-kit: unconfigured`).

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
