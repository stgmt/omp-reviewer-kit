---
name: review-progress
description: Use when a git commit is waiting on the reviewer-kit pre-commit review, when the user asks how a commit review is going, or when a commit was blocked by a review and its verdict is needed. Lists this session's and this repository's review runs, follows one run, and finds the run that reviewed a commit.
allowed-tools: Bash(node *)
---

# Review progress

A commit in a repository with reviewer-kit runs its review in a git pre-commit hook. Each review writes its own run record, so reviews from one session or many never overwrite each other. This skill only reads those records and changes nothing.

Run the reader through the plugin shell:

- Runs of this session (start here): `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" progress --mine`
- Runs of this repository: `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" progress`
- One run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" progress --run <runId>`
- The run that reviewed a commit: `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" progress --commit <sha>`
- To wait for a running review, start `progress --run <runId> --follow` with the Bash tool and `run_in_background: true`. When it finishes, read its output. Exit codes: 0 the commit may go ahead (PASS or skipped), 1 blocked or failed, 3 quiet or orphaned.

Rules:
1. Start with `--mine`. If it lists no runs, say so. Do not guess a runId.
2. Do not start a second commit in a repository while one of this session's runs there is still active. Ask the user first.
3. A quiet run may still be working. An orphaned run has no runner process left and did not complete. Report the runId, runner pid, review pid and the OMP log folder (`~/.omp/logs`). Never stop a process and never restart a review yourself; the user decides.
4. For a blocked commit, report its verdict and the report path from the run record. The findings are in that report.
5. Keep the answer short: state, stage, time silent, verdict.
