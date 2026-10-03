---
description: Install OMP and the OMP plugin that omp-reviewer-kit needs, after your confirmation.
---

The review runs on OMP, so this plugin needs the `omp` executable and the `omp-reviewer-kit` OMP plugin. This command checks what is already installed and installs only what is missing.

1. Show the plan first. It changes nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" install-omp
```

2. If it prints `Nothing to install`, stop and tell the user. Otherwise show the user the exact commands from the plan (they download and run software) and ask for explicit confirmation. Do not continue without a clear yes.

3. After the yes, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" install-omp --yes
```

4. Tell the user that logging in to a provider and choosing models happens inside OMP (run `omp` once); this plugin never selects or passes models. Then suggest `/omp-reviewer-kit:setup` for the current repository.
