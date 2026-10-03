---
description: Review the staged Git changes with the omp-reviewer-kit gate (PASS or BLOCK).
allowed-tools: Bash(node:*), Bash(git:*)
---

Run the fail-closed reviewer on the currently staged changes and report the verdict verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-review.mjs"
```

Exit code 0 means PASS; exit code 1 means BLOCK or infrastructure failure. Quote the findings or the "does not choose models" infrastructure message to the user; do not retry with different models and do not bypass the gate. Reports are stored under `audit-reports/commit-reviews/`.
