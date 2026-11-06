---
description: Install or repair the kit-owned review hook in the current repository.
agent: kit-operations
---

Call the loaded kit plugin's `review_kit` tool with `operation: "setup"` for the current repository. It owns only the kit's hook and runner, does not overwrite a foreign hook, and does not replace a newer runner with an older one. Report the exact output. If setup reports a hook conflict, do not edit or bypass that hook; show the README adoption instructions from the kit.