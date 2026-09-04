# omp-reviewer-kit

OMP plugin with one review agent and a Git `pre-commit` hook.

## Names

- GitHub and plugin: `omp-reviewer-kit`
- OMP agent: `reviewer-kit`
- Review method: `reality-first-review`

## What it does

The hook runs OMP before a commit. OMP is asked to run the native task agent `reviewer-kit`. The agent reviews only staged changes, reads `reality-first-review`, and then reads only relevant project review skills discovered by OMP.

The commit continues only when the output contains:

```text
REVIEW_RESULT=PASS
```

Any other result blocks the commit.

## Install the hook in a project

Run the installer from this repository:

```powershell
pwsh ./scripts/install-hook.ps1 -Repository E:/repos/your-project
```

Or on a POSIX shell:

```sh
./scripts/install-hook.sh E:/repos/your-project
```

The installer copies the small runner into the target project, creates `.githooks/pre-commit`, and sets the target repository's local `core.hooksPath` to `.githooks`.

The installer does not change global Git configuration or other projects.

## Global OMP installation

Install the `omp-reviewer-kit` plugin in the OMP user scope to make the skill and `reviewer-kit` agent available in projects. When the hook starts OMP inside a target project, OMP discovers that project's `.omp/skills` and user skills through its normal discovery rules.

The plugin does not copy or maintain a second project-skill registry.

## Reports

A target project receives reports at:

```text
audit-reports/commit-reviews/<timestamp>-<diff-hash>.md
```

Reports include the staged paths, result, findings, and skills reported as used by the agent.

## Development

```sh
node --test tests/*.test.mjs
node scripts/check-layout.mjs
```
