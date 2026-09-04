---
name: multi-stage-review
description: Multi-stage review protocol, stage ordering, candidate schema, adversarial verification, and verdict synthesis.
---

# Multi-stage review protocol

This skill defines the multi-stage review orchestration protocol for `omp-reviewer-kit`. It coordinates specialized subagents to deliver high-precision, low-noise reviews of staged Git changes.

## 1. Stage Architecture & Execution Order

The review orchestrator (`reviewer-kit`) must execute these four distinct stages strictly in sequence:

```
Staged Diff (git diff --cached --binary --no-ext-diff --)
                    │
                    ▼
[Stage 1: Context Scout] (review-context-scout)
  - Inspects staged diff, modified files, consumers via LSP/grep, tests.
  - Produces structured context report.
                    │
                    ▼
[Stage 2: Parallel Risk Hunting] (review-risk-hunter x 2 batch)
  - Lane 1: Correctness (boundary conditions, null/default states, resource leaks).
  - Lane 2: Security (attacker input source, dangerous sink, missing controls).
  - Produces candidate findings under strict anti-noise rules.
                    │
                    ▼
[Stage 3: Adversarial Verification] (review-finding-verifier)
  - Acts as defense attorney: tests upstream defenses, callers, reachability.
  - Produces confirmed findings, rejected candidates, and unproven candidates.
                    │
                    ▼
[Stage 4: Orchestrator Synthesis] (reviewer-kit)
  - Synthesizes coverage, validated findings, and unproven summaries.
  - Emits solitary machine-readable verdict marker.
```

## 2. Stage Contracts & Schemas

### Stage 1: Context Scout (`review-context-scout`)
- **Role**: Read-only explorer. Discovers the purpose, blast radius, callers, and invariants of the staged change.
- **Tools**: `read`, `grep`, `glob`, `lsp`, `bash` (read-only git diff/log commands only). No `task`, no mutating tools.
- **Output Contract**:
  - `change_goal`: Concise description of what the change attempts to achieve.
  - `changed_paths`: Array of files modified or added in the staged diff.
  - `relevant_consumers`: Direct callers, consumers, or downstream dependencies affected.
  - `invariants`: Domain invariants, contracts, or assumptions in the touched code.
  - `test_evidence`: Existing automated tests exercising the touched areas.
  - `unknowns`: Areas with insufficient visibility or ungrounded assumptions.
  - `reviewed_paths`: Complete list of repository files read during scouting.
- **Constraint**: Must NOT generate defect findings or verdict markers (`REVIEW_RESULT=...`).

### Stage 2: Parallel Risk Hunters (`review-risk-hunter`)
- **Role**: Generates focused defect candidates in two parallel lanes using the scout context:
  - `lane: "correctness"`: Boundary conditions, absence/default/failure values, side effects, determinism, resource/handle leaks, behavior-test gaps.
  - `lane: "security"`: Attacker-controlled input source, dangerous sink, missing/bypassed controls, credential leakage, permission bypass.
- **Tools**: `read`, `grep`, `glob`, `lsp`, `bash` (read-only git commands only). No `task`, no mutating tools.
- **Anti-Noise Prohibitions**:
  - Never report formatting, whitespace, indentation, or line length.
  - Never suggest adding or modifying comments, docstrings, or type annotations.
  - Never suggest renaming variables, functions, or files unless demonstrably misleading.
  - Never suggest architectural or design pattern refactorings if current code is correct.
  - Never report pre-existing defects unrelated to the lines touched by the staged diff.
  - Never speculate on potential breakage without citing a concrete, reachable callsite.
  - Never report advice without a concrete failing trigger scenario.
- **Candidate Schema**:
  - `candidate_id`: `<lane>-<ordinal>` (e.g. `correctness-1`, `security-1`).
  - `lane`: `"correctness"` | `"security"`.
  - `priority`: `"P1"` (critical/fatal defect) | `"P2"` (functional defect/vulnerability).
  - `title`: Terse summary of the defect.
  - `file_path`: Repository-relative path to the touched file.
  - `line_start` & `line_end`: Inclusive line range overlapping added diff lines.
  - `observed_behavior`: Factual description of what the staged code does.
  - `expected_behavior`: Factual description of what the contract requires.
  - `trigger_scenario`: Concrete input or sequence triggering the defect.
  - `impact`: Concrete failure consequence.
  - `evidence`: Array of repository citations (files, lines, callers).
- **Constraint**: Must NOT emit verdict markers (`REVIEW_RESULT=...`).

### Stage 3: Adversarial Verifier (`review-finding-verifier`)
- **Role**: Defense attorney. Challenges every candidate against repository reality to eliminate false positives.
- **Verification Method**:
  1. **Upstream Defenses**: Did a caller, controller, middleware, or type constraint already sanitize, validate, or guarantee this input? If yes -> disposition: `rejected`.
  2. **Concrete Trigger**: Is the trigger scenario realistically reachable in this codebase? If purely theoretical -> disposition: `not_proven`.
  3. **Diff Ownership**: Is the defect genuinely introduced by this staged change? If pre-existing -> disposition: `rejected`.
  4. **Security Defense**: Is there a credible source-to-sink path without effective mitigations? If mitigated -> disposition: `rejected`.
  5. **Deduplication**: Collapse duplicate candidate findings representing the same root cause.
- **Output Contract**:
  - `coverage_summary`: Summary of verified candidates.
  - `decisions`: Array of per-candidate decisions with fields:
    - `candidate_id`: Matching candidate identifier.
    - `disposition`: `"confirmed"` | `"rejected"` | `"not_proven"`.
    - `reason`: Factual justification citing repository evidence.
    - `evidence`: File and line citations supporting the decision.
  - `confirmed_findings`: Array of validated findings with normalized priority (`P1` | `P2`), file_path, line range, observed, expected, trigger, impact, and evidence.
- **Constraint**: Must NOT invent replacement patches or emit verdict markers (`REVIEW_RESULT=...`).

### Stage 4: Orchestrator Synthesis (`reviewer-kit`)
- **Role**: Synthesizes verified evidence, formats the audit report, and controls the commit gate.
- **Report Structure**:
  - `### Review coverage`: Summary of inspected diff, changed files, active skills, and stages executed.
  - `### Confirmed findings`: Detailed list of confirmed findings (priority, path, range, trigger, impact, evidence).
  - `### Unproven/rejected summary`: Terse summary of rejected or unproven candidates with rationale.
- **Verdict Rule**:
  - Exactly zero confirmed findings -> emit `REVIEW_RESULT=PASS`.
  - At least one confirmed `P1` or `P2` finding -> emit `REVIEW_RESULT=BLOCK`.
  - `not_proven` or `rejected` candidates NEVER block.
  - If any mandatory stage fails, times out, or produces invalid output -> emit stage-specific explanation and `REVIEW_RESULT=BLOCK`.
