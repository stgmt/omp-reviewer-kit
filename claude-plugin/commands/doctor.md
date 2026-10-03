---
description: Diagnose the omp-reviewer-kit setup (OMP, OMP plugin, hook, runner version).
allowed-tools: Bash(node:*)
---

Run the diagnostics and report every line to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" doctor
```

Add `--probe` only when the user asks to verify that OMP can reach a model; it sends one short request through OMP.
