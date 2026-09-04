# omp-reviewer-kit

Native Oh My Pi plugin for evidence-first code review of staged Git changes.

## Names

- GitHub and plugin: `omp-reviewer-kit`
- OMP agent: `reviewer-kit`
- Review method: `reality-first-review`
- OMP extension: `src/extension.mjs`

## What it does

The hook runs OMP headlessly before each Git commit. OMP invokes native task agent `reviewer-kit`, which reviews only staged changes (`git diff --cached`), loads `reality-first-review`, and dynamically selects relevant project review skills discovered by OMP.

The commit proceeds only when the output contains exactly:

```text
REVIEW_RESULT=PASS
```

Any other result, model error, or timeout strictly blocks the commit (fail-closed).

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

For CI environments or machines without an interactive OMP shell, standalone scripts remain available:

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

Reports contain the staged diff hash, verdict, model output, and project skills utilized.

## Development & Testing

```sh
npm test         # runs native node:test suites (unit, BDD, E2E)
npm run check    # asserts repository layout integrity and zero runner drift
```
