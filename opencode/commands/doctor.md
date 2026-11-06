---
description: Diagnose OMP, plugin, library, and repository hook readiness.
agent: kit-operations
---

Call the loaded kit plugin's `review_kit` tool with `operation: "doctor"` for the current repository and report every returned line. It checks installation, library, and hook status; it does not perform a model-reachability probe. If the user requests a live model probe, state that the tool does not implement one rather than claiming to have tested it.