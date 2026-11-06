---
description: Apply the OMP and plugin installation plan.
agent: kit-operations
---

This command installs software and can modify the machine. Its explicit invocation is the user's authorization to perform this installation; do not require a prior `/install-omp` invocation or a second confirmation. Call the loaded kit plugin's `review_kit` tool with `operation: "install_omp_apply"` when this command is invoked. Never infer authorization to install from an unrelated request or question. Report the exact result and do not claim provider login or model configuration was completed.