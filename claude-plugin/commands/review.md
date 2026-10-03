---
description: Review the staged Git changes with the omp-reviewer-kit gate (PASS or BLOCK).
allowed-tools: Bash(node:*)
---

Run the fail-closed reviewer on the currently staged changes. It uses the same runner file as the repository's git hook, so a PASS here makes the following `git commit` instant.

A review takes up to about 10 minutes, longer than a default tool timeout. Start it with the Bash tool using `run_in_background: true`, then wait for its completion notice and read the output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" review
```

Exit code 0 means PASS; 1 means BLOCK or a review failure; 2 means OMP or the OMP plugin is missing or outdated (tell the user to run `/omp-reviewer-kit:install-omp`). Quote the verdict, findings, or the infrastructure message to the user verbatim. Do not retry with different models, do not set model environment variables, and do not bypass the gate. Reports are stored under `audit-reports/commit-reviews/`.
