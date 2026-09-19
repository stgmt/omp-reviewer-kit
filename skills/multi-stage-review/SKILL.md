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
  - Lane 1: Correctness (boundary conditions, null/default states, resource leaks, anti-parasitic correctness defects).
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
  - Emits a strict `review-rejection-envelope@1` before BLOCK and a solitary machine-readable verdict marker; PASS has no envelope.
```

## Snapshot and evidence boundary

The dispatcher materializes an absolute staged snapshot directory from the Git index before invoking the reviewer. All source-file contents, tests, and fixtures must be read from that snapshot; use the repository working tree only for read-only Git metadata, caller discovery, and project-skill discovery. The snapshot is the authoritative review input and prevents unstaged worktree content from entering the decision.

The snapshot also carries the review inputs under `.review/`: `diff.patch` holds the complete staged diff and `changed-files.txt` lists every touched path. When the dispatch prompt carries an inline `---STAGED DIFF---` block, that block is authoritative: embed it verbatim into every subagent's task text (the context scout keeps file paths for repository context; both risk hunters and the verifier receive the diff inline instead of the `.review/diff.patch` path). Otherwise every stage reads the diff from `.review/diff.patch` as a file. In both cases agents must not re-derive the staged diff or staged file bytes with `git diff`, `git show`, or `git cat-file`.

## 2. Stage Contracts & Schemas

### Stage 1: Context Scout (`review-context-scout`)
- **Role**: Read-only explorer. Discovers the purpose, blast radius, callers, and invariants of the staged change. Reads the diff from `<snapshot>/.review/diff.patch` and the file list from `<snapshot>/.review/changed-files.txt`.
- **Tools**: `read`, `grep`, `glob`, `lsp`, `bash` (read-only git diff/log commands only). No `task`, no mutating tools. Budget: roughly 20 tool calls — stop scouting once callers and tests for changed behavior are mapped.
- **Output Contract**:
  - `change_goal`: Concise description of what the change attempts to achieve.
  - `changed_paths`: Array of files modified or added in the staged diff.
  - `relevant_consumers`: Direct callers, consumers, or downstream dependencies affected.
  - `invariants`: Domain invariants, contracts, or assumptions in the touched code.
  - `test_evidence`: Existing automated tests exercising the touched areas.
  - `test_harness`: `"present" | "absent"` — whether the repository has a runnable test harness (test script, test directory, or runner config).
  - `coverage_map`: Array of `{behavior, file_path, line_start, line_end, covering_test}` — every changed executable behavior (new or altered control-flow branch, boundary, default, side effect, or error path reachable from a caller); `covering_test` names the focused test that fails if the behavior is reverted, or `null` when none exists.
  - `claims`: Array of `{claim, source_path, source_line, kind}` (`kind` in `"number" | "status" | "check_output" | "verified_claim"`) — verifiable claims found in staged content.
  - `declared_checks`: Array of `{selector, source_path, source_line}` — check commands or test selectors declared in staged content.
  - `unknowns`: Areas with insufficient visibility or ungrounded assumptions.
  - `reviewed_paths`: Complete list of repository files read during scouting.
- **Constraint**: Must NOT generate defect findings or verdict markers (`REVIEW_RESULT=...`).

### Stage 2: Parallel Risk Hunters (`review-risk-hunter`)
- **Role**: Generates focused defect candidates in two parallel lanes using the scout context:
  - `lane: "correctness"`: Boundary conditions, absence/default/failure values, side effects, determinism, resource/handle leaks, behavior-test gaps, and control infrastructure that duplicates an existing mechanism without adding product capability.
  - `lane: "security"`: Attacker-controlled input source, dangerous sink, missing/bypassed controls, credential leakage, permission bypass.
- **Tools**: `read`, `grep`, `glob`, `lsp`, `bash` (read-only git commands only). No `task`, no mutating tools. Budget: roughly 30 tool calls per lane — analyze `.review/diff.patch`, read each changed file once, verify only deciding callers.
- **Correctness test/YAGNI boundary**: Inspect focused tests for changed behavior and record concrete test evidence. Missing or weak tests and unnecessary code are not independent defect classes; raise them only when a reachable P1/P2 correctness impact is proven, and keep the existing `correctness`/`security` candidate schema.
- **Coverage Gaps**: In lane `correctness`, walk the scout `coverage_map`. Every entry with `covering_test: null` produces a `coverage_gaps` item — a coverage directive, not a defect candidate, requiring no P1/P2 impact proof. Skip non-behavioral changes (pure renames, comments, docs-only or test-only diffs, unreachable code). Each gap carries `required_tests`: at least one `edge` test per new boundary/default/error path and at least one `mutation` test whose `mutant` field names the concrete staged-lines mutation it kills. Vague directives like "add tests" are prohibited.
- **Neuroslop Pass**: In lane `correctness`, execute an explicit pass across every staged assertion, check, status claim, and number:
  - Ask the red question: "what would have to break in the tree for this check to fail?"
  - Apply the vacuum checklist: count inspected units with your own query, find a positive control outside the checked zone, verify missing/renamed behavior.
  - Check for stub oracles returning asserted values.
  - Recount every staged number with your own query.
  - Resolve every `declared_checks` selector against the snapshot.
  - Apply the self-tool rule: zero matches prove nothing without positive control.
  - An empty `red_proof` is a finding.
- **Anti-Noise Prohibitions**:
  - Never report formatting, whitespace, indentation, or line length.
  - Never suggest adding or modifying comments, docstrings, or type annotations.
  - Never suggest renaming variables, functions, or files unless demonstrably misleading.
  - Never suggest architectural or design pattern refactorings if current code is correct; this does not suppress a proven anti-parasitic correctness defect.
  - Never report pre-existing defects unrelated to the lines touched by the staged diff.
  - Never speculate on potential breakage without citing a concrete, reachable callsite.
  - Never report advice without a concrete failing trigger scenario.
- **Anti-Parasitic Correctness Gate**:
  - Evaluate only five forms: micro-CLIs replacing domain calls; local PKI without a trust boundary; file inbox/exit-code protocols replacing native pause and persistence; process receipts replacing product behavior tests; indiscriminate command capture duplicating existing logging.
  - Confirm only when both repository or declared-framework evidence proves an existing mechanism for the same responsibility and the staged layer adds no product capability.
  - Treat ownership cost as impact, not a third condition. Missing either proof means no candidate, `rejected`, or `not_proven`.
  - Protect capability-adding Port/Adapter and Template Method designs, public user-facing CLIs, and cryptography for remote untrusted payloads from false positives.
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
  - `red_proof`: Concrete tree breakage that would make this check fail; empty string means the check cannot fail.
  - `evidence`: Array of repository citations (files, lines, callers).
- **Coverage Gap Schema** (correctness lane only, emitted alongside `candidates`):
  - `coverage_id`: `coverage-<ordinal>`.
  - `file_path`, `line_start`, `line_end`: Location overlapping added diff lines.
  - `behavior`: The changed executable behavior lacking a covering test.
  - `required_tests`: Array of `{kind: "edge" | "mutation", scenario, mutant}` — concrete runnable scenarios; `mutant` is required and non-empty for `kind: "mutation"`.

### Stage 3: Adversarial Verifier (`review-finding-verifier`)
- **Role**: Defense attorney. Challenges every candidate against repository reality to eliminate false positives. Budget: roughly 20 tool calls — one verification pass per candidate against the snapshot and deciding callers.
- **Verification Method**:
  1. **Upstream Defenses**: Did a caller, controller, middleware, or type constraint already sanitize, validate, or guarantee this input? If yes -> disposition: `rejected`.
  2. **Concrete Trigger**: Is the trigger scenario realistically reachable in this codebase? If purely theoretical -> disposition: `not_proven`.
  3. **Diff Ownership**: Is the defect genuinely introduced by this staged change? If pre-existing -> disposition: `rejected`.
  4. **Security Defense**: Is there a credible source-to-sink path without effective mitigations? If mitigated -> disposition: `rejected`.
  5. **Deduplication**: Collapse duplicate candidate findings representing the same root cause.
  6. **Neuroslop confirmation**: Confirm candidate about dead, vacuous, or tautological checks only with own unit count, positive control, and empty `red_proof`.
  7. **Self-tool audit**: Reject or mark not-proven any candidate whose proof relies on zero matches without positive control.
  8. **Triage**: Classify decision into triage categories (`lie`, `stale_record`, `disclosed_gap`, or `not_applicable`).
  9. **Coverage gaps**: Verify each `coverage_gaps` item is real: reject when the behavior already has a covering test the scout missed (cite it), when the lines are not changed executable behavior (rename, comment, docs-only, test-only), or when unreachable. Confirm surviving gaps into `confirmed_coverage_gaps`; never weaken `required_tests`, but add a missing edge or mutation requirement when the behavior obviously needs it.
- **Output Contract**:
  - `coverage_summary`: Summary of verified candidates.
  - `decisions`: Array of per-candidate decisions with fields:
    - `candidate_id`: Matching candidate identifier.
    - `disposition`: `"confirmed"` | `"rejected"` | `"not_proven"`.
    - `triage`: `"lie"` | `"stale_record"` | `"disclosed_gap"` | `"not_applicable"`.
    - `reason`: Factual justification citing repository evidence.
    - `evidence`: File and line citations supporting the decision.
  - `confirmed_findings`: Array of validated findings with normalized priority (`P1` | `P2`), file_path, line range, observed, expected, trigger, impact, and evidence.
  - `confirmed_coverage_gaps`: Array of verified coverage gaps with `coverage_id`, file_path, line range, `behavior`, and `required_tests` (`{kind, scenario, mutant}`).
- **Constraint**: Must NOT invent replacement patches or emit verdict markers (`REVIEW_RESULT=...`).

### Stage 4: Orchestrator Synthesis (`reviewer-kit`)
- **Role**: Synthesizes verified evidence, formats the audit report, and controls the commit gate.
- **Report Structure**:
  - `### Review coverage`: Summary of inspected diff, changed files, active skills, and stages executed.
  - `### Confirmed findings`: Detailed list of confirmed findings (priority, path, range, trigger, impact, evidence).
  - `### Required test coverage`: Mandatory directive to the committer — every confirmed coverage gap with file path, line range, changed behavior, and the concrete tests that must be added (edge tests per new boundary/default/error path, mutation tests naming the killed mutant). "None required" when every changed behavior is covered. Non-blocking only when the scout reported `test_harness: absent`; then the gaps are mirrored into `### Notes`.
  - `### Unproven/rejected summary`: Terse summary of rejected or unproven candidates with rationale.
  - `### Notes`: Non-blocking observations (stale records with intact code, check commands suppressing output, showcase stub tests, disclosed gaps with named owners); never part of rejection envelope and never blocks PASS.
  - `### Verified-OK`: Explicit paths, tests, caller checks, and invariants actually verified, each carrying a concrete measure (unit count, path, positive control). Bare "looks correct" is prohibited; never use this section to hide unresolved candidates.
- **Rejection Envelope Rule**:
  - A confirmed-finding BLOCK emits one strict `review-rejection-envelope@1` with the current diff hash and only normalized `correctness` or `security` findings.
  - A coverage-only BLOCK (zero confirmed findings, at least one confirmed coverage gap, `test_harness: present`) emits one `coverage_required` envelope: `findings: []` plus `coverage_items` mirroring `confirmed_coverage_gaps` one-to-one (`coverage_id`, `file_path`, `line_start`, `line_end`, `behavior`, `required_tests`). Confirmed findings take precedence: when both exist, emit the `confirmed_findings` envelope and keep the coverage directive in the report section only.
  - A mandatory-stage failure emits a `review_failure` envelope with `execution_failure` and a non-empty diagnostic message.
  - The envelope occurs between standalone begin/end lines before the solitary BLOCK marker. PASS emits no envelope.
- **Verdict Rule**:
  - Exactly zero confirmed findings and zero blocking coverage gaps -> emit `REVIEW_RESULT=PASS`.
  - At least one confirmed `P1` or `P2` finding -> emit `REVIEW_RESULT=BLOCK`.
  - At least one confirmed coverage gap with `test_harness: present` -> emit `REVIEW_RESULT=BLOCK`.
  - `not_proven` or `rejected` candidates NEVER block; coverage gaps with `test_harness: absent` NEVER block.
  - If any mandatory stage fails, times out, or produces invalid output -> emit stage-specific explanation and `REVIEW_RESULT=BLOCK`.