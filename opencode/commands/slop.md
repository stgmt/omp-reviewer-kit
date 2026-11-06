---
description: Run the native read-only slop audit for a target or the current staged change.
agent: slop
---

Audit the target and optional focus supplied in `$ARGUMENTS`. If no target was supplied, audit the current Git status and staged diff. This is diagnostic only; it does not control commits. Follow the native `slop` agent's staged scout, verifier, and synthesis stages. Never run a mutating command.