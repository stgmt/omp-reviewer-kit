---
description: Install the omp-reviewer-kit pre-commit hook in the current repository.
allowed-tools: Bash(node:*)
---

Install or repair the review hook and runner in the current Git repository. The hook is owned by the OMP plugin's installer; this command only calls it, never overwrites a foreign hook, and never replaces a newer runner with an older one.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" setup
```

Exit code 2 means OMP or the OMP plugin is missing or outdated: tell the user to run `/omp-reviewer-kit:install-omp`. Exit code 1 with a conflict message means another pre-commit hook exists; show the message and the README adoption instructions, do not edit the hook yourself. Report the output to the user.
