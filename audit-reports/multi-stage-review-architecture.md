# Multi-Stage Review Architecture & Grounded Runtime Protocol

## Executive Summary

This record documents the architectural contracts, grounded runtime evidence, and design invariants for the `v0.2.0` multi-stage review system in `omp-reviewer-kit`. It replaces the single-pass reviewer with a repository-native 4-stage hierarchy executed entirely within OMP without external vector stores, graphs, or databases.

## 1. Grounded OMP Runtime Verification

Inspected runtime environment: `@oh-my-pi/pi-coding-agent` version `17.3.7` (installed globally at `~/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent`).

The following core contracts were directly verified against the installed source:

1. **Agent Discovery (`src/task/discovery.ts`)**:
   - Discovers extension package agents from `agents/*.md`.
   - Frontmatter defines name, description, tools, model, spawns, and autoloadSkills.

2. **Tools and Spawns Resolution (`src/discovery/helpers.ts:264-290`)**:
   - Explicit tool lists automatically append `yield` (`tools: [...tools, "yield"]`).
   - The `spawns` frontmatter field is parsed from array, CSV, or `"*"`.
   - When `spawns` is omitted and `tools` contains `task`, OMP defaults `spawns: "*"`. An explicit allowlist (e.g. `spawns: [review-context-scout, review-risk-hunter, review-finding-verifier]`) strictly restricts allowed child agents.

3. **Spawn Policy Enforcement (`src/task/spawn-policy.ts:18-57`)**:
   - `resolveSpawnPolicy(parentSpawns)` enforces strict allowlisting.
   - When `allowedAgents` is set, calling `task` with any agent not in the allowlist throws `StructuredSubagentError("preflight", "Cannot spawn '...'. Allowed: ...")`.

4. **Task Batching Support (`src/config/settings-schema.ts:4573-4576`)**:
   - `task.batch` setting defaults to `true`.
   - The `task` tool accepts a batch array `tasks: [{ name, agent, task, outputSchema, schemaMode }]` executed with shared context.

5. **Blocking Synchronous Subagents & Fan-Out (`src/task/index.ts:721-741, 986-990, 1233-1236`)**:
   - Agents declaring `blocking: true` in frontmatter execute synchronously inline on the caller's turn.
   - For batch `task` calls where items declare `blocking: true`, OMP executes synchronous fan-out: batch members run concurrently within the session concurrency limit, running each spawn to completion inline and merging payloads before returning to the parent agent.

6. **Structured Subagent Preflight & Schema Handling (`src/task/structured-subagent.ts:218-278, 535-538, 644-649`)**:
   - Preflight enforces recursion depth (`task.maxRecursionDepth`, default 2), self-spawn prohibition (`blockedAgent === agentName`), and spawn policy.
   - Structured subagent output validation returns `{ status: "valid" | "invalid", data, error }`.
   - Subagent crashes or unhandled rejections throw `StructuredSubagentError("execution", ...)`.

## 2. External Patterns & Grounded Decisions

Two battle-tested multi-stage patterns inform this design:

1. **`The-PR-Agent/pr-agent`**:
   - Key Insight: Separates candidate generation from reflection and verification (`pr_code_suggestions_reflect_prompts.toml`).
   - Anti-Noise: Candidate generators over-report; a dedicated reflection/verifier pass eliminates false positives.

2. **`sashiko-dev/sashiko`**:
   - Key Insight: Deconstructs review into specialized passes (goal/flow/security analysis) followed by consolidation and adversarial verification.
   - Anti-Noise: Strict negative constraints during candidate generation prevent style, comment, and formatting bikeshedding.

### Local Decision: Parameterized Risk-Hunter with Orchestrator Synthesis

Instead of duplicating schemas across distinct correctness and security agents, `omp-reviewer-kit` uses:
- **`review-context-scout`**: 1 instance, read-only diff & consumer analysis.
- **`review-risk-hunter`**: 1 agent definition invoked in parallel lanes (`lane: "correctness"` and `lane: "security"`).
- **`review-finding-verifier`**: 1 instance, adversarial verification assuming the author is correct until disproven by repository evidence.
- **`reviewer-kit` (Orchestrator)**: Local synthesis of confirmed findings, human-readable report formatting, and solitary `REVIEW_RESULT=PASS|BLOCK` verdict emission.

## 3. The 4-Stage Protocol Contract

```
Staged Diff (git diff --cached --binary --no-ext-diff --)
                    │
                    ▼
[Stage 1: Context Scout] (review-context-scout)
  - Inspects staged diff, modified files, consumers via LSP/grep, tests.
  - Outputs: change_goal, changed_paths, relevant_consumers, invariants, test_evidence, unknowns.
  - Invariant: No findings, no verdict markers.
                    │
                    ▼
[Stage 2: Parallel Risk Hunting] (review-risk-hunter x 2 batch)
  - Lane 1: Correctness (boundary conditions, null/default states, resource leaks, breaking consumer assumptions).
  - Lane 2: Security (attacker input source, dangerous sink, missing controls).
  - Anti-Noise: Zero style/naming/comment/refactoring suggestions. Every candidate requires concrete trigger scenario.
  - Outputs: candidates[] with candidate_id, lane, priority (P1/P2), line ranges, observed, expected, trigger, impact, evidence.
                    │
                    ▼
[Stage 3: Adversarial Verification] (review-finding-verifier)
  - Defense lawyer mindset: assumes code is correct until proven broken.
  - Verifies upstream sanitization, caller constraints, test protections.
  - Outputs: decisions[] (confirmed, rejected, not_proven) and confirmed_findings[].
  - Invariant: No verdict markers.
                    │
                    ▼
[Stage 4: Orchestrator Synthesis & Gate] (reviewer-kit)
  - Synthesizes coverage and confirmed findings.
  - Formats markdown audit report under audit-reports/commit-reviews/.
  - Emits solitary verdict marker:
    - Zero confirmed findings -> REVIEW_RESULT=PASS
    - Any confirmed P1 or P2 finding -> REVIEW_RESULT=BLOCK
    - Missing/failed mandatory stage -> REVIEW_RESULT=BLOCK
```

## 4. Fail-Closed Invariants

1. **Solitary Verdict Marker**: Only an exact, solitary `REVIEW_RESULT=PASS` line permits a commit. Any other text, multiple conflicting markers, or absent marker strictly yields exit code 1 (`BLOCK`).
2. **Mandatory Stage Execution**: If scout, risk-hunter, or verifier fails, times out, or produces unparseable output, `reviewer-kit` records the failure and emits `REVIEW_RESULT=BLOCK`.
3. **No Repository Mutation**: Neither orchestrator nor any subagent may run `edit`, `write`, or mutating git commands (`git add`, `git commit`, `git checkout`, `git reset`).
4. **Staged Change Isolation**: Review operates exclusively on `git diff --cached --binary --no-ext-diff --` and ignores unstaged worktree modifications.
