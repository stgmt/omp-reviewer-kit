---
description: Show the OMP and plugin installation plan without changing the machine.
agent: kit-operations
---

Call the loaded kit plugin's `review_kit` tool with `operation: "install_omp_plan"` only. This call changes nothing. Report the exact commands and ask the user for explicit confirmation before installation. Never apply the plan from this command; after confirmation, ask the user to invoke `/install-omp-apply` explicitly.