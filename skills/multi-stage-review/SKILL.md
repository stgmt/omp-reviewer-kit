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
[Stage 2: Parallel Risk Hunting] (review-risk-hunter — one task per lane named in the assignment's `Risk lanes for this diff:` list)
  - Lane "correctness" (boundary conditions, null/default states, resource leaks, anti-parasitic correctness defects).
  - Lane "security" (attacker input source, dangerous sink, missing controls) — opt-in via `OMP_REVIEW_KIT_LANES`.
  - Lane "content-risk" — spec-docs profile only.
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
  - Ends with exactly one solitary machine-readable verdict marker; PASS and BLOCK both end with one.
```


## Review profiles

The runner classifies every changed path deterministically into file classes (`executable`, `test`, `prompt`, `spec`, `docs`, `config`, `data`), materializes the manifest at `<snapshot>/.review/file-classes.json` (`file-classes@1`, one row per path with the staged-content SHA-256), and states the review profile on the `Review profile for this diff:` prompt line.

- `full` — at least one `executable` or `test` file changed. Run the four stages exactly as specified below, spawning one hunter task per lane named in `Risk lanes for this diff:` (correctness only by default; the security lane is opt-in via `OMP_REVIEW_KIT_LANES`).
- `spec-docs` — zero `executable`/`test` files changed (prompt/spec/docs/config/data only). Run a reduced review:

```
[Stage 1: Context Scout] — same role; no coverage_map is produced; test_harness may be reported absent for this diff.
            │
[Stage 2: Content-risk hunting] — ONE task, lane "content-risk" (secrets/credentials committed in text, documented-behavior contradictions with executable files, dead links/commands/steps in docs and specs, fabricated numbers, prompt-contract drift in agents/*.md and skills/, metadata staleness).
            │
[Stage 3: Adversarial Verification] — runs only when stage 2 produced at least one candidate; skipped otherwise.
            │
[Stage 4: Orchestrator Synthesis] — same report shape; `### Required test coverage` reads "None required" (no executable change exists to cover).
```

Under `spec-docs` the orchestrator MUST NOT run the correctness lane, the separate security lane, coverage-gap enumeration, or coverage-gap verification, and MUST NOT write coverage directives. Confirmed content findings block normally (lane `content-risk`). The file-class manifest is a deterministic input; agents must not re-classify paths. When the manifest contradicts what an agent observes (e.g. an `executable` row that is actually prose), it flags the row in `unknowns`/`### Notes` — it does not silently widen the profile.
## Snapshot and evidence boundary

The runner materializes an absolute staged snapshot directory from the Git index before invoking the reviewer. All source-file contents, tests, and fixtures must be read from that snapshot; use the repository working tree only for read-only Git metadata, caller discovery, and project-skill discovery. The snapshot is the authoritative review input and prevents unstaged worktree content from entering the decision.

The snapshot also carries the review inputs under `.review/`: `diff.patch` holds the complete staged diff and `changed-files.txt` lists every touched path. When the dispatch prompt carries an inline `---STAGED DIFF---` block, that block is authoritative: embed it verbatim into every subagent's task text (the context scout keeps file paths for repository context; both risk hunters and the verifier receive the diff inline instead of the `.review/diff.patch` path). Otherwise every stage reads the diff from `.review/diff.patch` as a file. In both cases agents must not re-derive the staged diff or staged file bytes with `git diff`, `git show`, or `git cat-file`.

Dispatch every planned task of a stage as a native task call, with the shared context embedded in each assignment, and do not advance until the whole stage has completed; never change user settings to obtain batching. A verifier must disposition every authoritative candidate, coverage gap and previous finding. Confirmed blocking findings/gaps cannot be overridden by final PASS synthesis.

## 2. Stage Contracts & Schemas

### Stage 1: Context Scout (`review-context-scout`)
- **Verdict Rule**: A BLOCK ends the Markdown report with exactly one `REVIEW_RESULT=BLOCK` line; a PASS ends it with `REVIEW_RESULT=PASS`. Waived coverage records MUST be mirrored into `### Notes`.
- **Role**: Read-only explorer. Discovers the purpose, blast radius, callers, and invariants of the staged change. Reads the diff from `<snapshot>/.review/diff.patch` and the file list from `<snapshot>/.review/changed-files.txt`.
- **Tools**: `read`, `grep`, `glob`, `lsp`, `bash` (read-only git diff/log commands only). No `task`, no mutating tools. No global 20–30-call hard cap: complete owned source/test/consumer obligations or report them unresolved. When NATIVE REVIEW BATCH PLAN is supplied, run every planned scout in one native task batch, using exact task names and ownership. Cross-scope reads resolve contracts without taking another scope's behavior ownership. Use the native merged report, not a second general scout.
- **Output Contract**:
  - `change_goal`: Concise description of what the change attempts to achieve.
  - `changed_paths`: Array of files modified or added in the staged diff.
  - `relevant_consumers`: Direct callers, consumers, or downstream dependencies affected.
  - `invariants`: Domain invariants, contracts, or assumptions in the touched code.
  - `test_evidence`: Existing automated tests exercising the touched areas.
  - `test_harness`: `"present" | "absent"` — whether the repository has a runnable test harness (test script, test directory, or runner config).
  - `coverage_map`: Array of `{behavior, file_path, line_start, line_end, covering_test, file_class, test_harness}` — every changed executable behavior (new or altered control-flow branch, boundary, default, side effect, or error path reachable from a caller) **that a runnable test harness in this repository can exercise for its file class/runtime**; `covering_test` names the focused test that fails if the behavior is reverted, or `null` when none exists. Each entry carries `file_class` from the manifest and a per-entry `test_harness` (`present` | `absent`) for that entry's file class/runtime. Non-coverable code (e.g. an inline browser script in a standalone spec/document HTML when only Go/vitest harnesses exist) is excluded here and recorded as a structured `non_coverable_items` entry (`file_path`, `line_start`, `line_end`, `reason`) — a repo-global harness that cannot execute the file class counts as absent for that entry. `test`-class entries are never `coverage_map` material: test code is the harness, not product behavior, so a changed test item is recorded under `non_coverable_items` with reason `test-class`.
  - `non_coverable_items`: Array of `{file_path, line_start, line_end, reason}` — structured record for each changed executable item excluded from `coverage_map` because no runnable harness in this repository can exercise its file class/runtime; the orchestrator normalizes each into an envelope `non_coverable_items` entry (`category_kind:"non_coverable"`, `severity:"none"`, `blocking:false`, `source:"scout"`) and mirrors it into `### Notes`.
  - `claims`: Array of `{claim, source_path, source_line, kind}` (`kind` in `"number" | "status" | "check_output" | "verified_claim"`) — verifiable claims found in staged content.
  - `declared_checks`: Array of `{selector, source_path, source_line}` — check commands or test selectors declared in staged content.
  - `unknowns`: Areas with insufficient visibility or ungrounded assumptions.
  - `reviewed_paths`: Complete list of repository files read during scouting.
  - `completion`: `{scope_id, completed_paths, unresolved}`; every owned path must be completed, unresolved obligations must remain explicit. Empty or partial result never means no findings.

Specialist frontmatter owns its native `output` schema. Submit one complete `yield` data payload, not incremental sections. Fix a rejected shape once; repeated identical invalid submissions stop with an error. Native exit 0 and schema-valid aborted payloads are failures. A previous scout baseline is historical context unless staged fingerprint validation explicitly permits reuse; added-line delta alone does not protect changed tests, callers, harness, deletions or renames.
- **Constraint**: Must NOT generate defect findings or verdict markers (`REVIEW_RESULT=...`).

### Stage 2: Parallel Risk Hunters (`review-risk-hunter`)
- **Role**: Generates focused defect candidates — ONE blocking task per lane named in the assignment's `Risk lanes for this diff:` list (default: `correctness` only; the `security` lane is opt-in via `OMP_REVIEW_KIT_LANES`; `spec-docs` profile names `content-risk` and nothing else). Lane semantics:
  - `lane: "correctness"`: Boundary conditions, absence/default/failure values, side effects, determinism, resource/handle leaks, behavior-test gaps, and control infrastructure that duplicates an existing mechanism without adding product capability.
  - `lane: "security"`: Attacker-controlled input source, dangerous sink, missing/bypassed controls, credential leakage, permission bypass.
  - `lane: "content-risk"` (spec-docs only): spec/prose claims that contradict repository facts, anchors, or stated contracts — not executable defects.
- **Tools**: `read`, `grep`, `glob`, `lsp`, `bash` (read-only git commands only). No `task`, no mutating tools. Budget: roughly 30 tool calls per lane — analyze `.review/diff.patch`, read each changed file once, verify only deciding callers.
- **Correctness test/YAGNI boundary**: Inspect focused tests for changed behavior and record concrete test evidence. Missing or weak tests and unnecessary code are not independent defect classes; raise them only when a reachable P1/P2 correctness impact is proven, and keep the existing `correctness`/`security` candidate schema.
- **Coverage Gaps**: In lane `correctness`, walk the scout `coverage_map`. Every entry with `covering_test: null` produces a `coverage_gaps` item — a coverage directive, not a defect candidate. Impact floor: a gap is `severity: "blocking"` only when it states the concrete, reachable failure or cost the missing test leaves unprotected; presentation text, test helpers, seed tooling, or an unproven hunch is `severity: "advisory"` and never blocks. Skip non-behavioral changes (pure renames, comments, docs-only or test-only diffs, unreachable code). Skip `test`-class entries on ground `test-class` — test code is the harness, not product behavior. Skip also entries whose code no runnable harness in this repository can execute for that file's runtime (a repo-global harness that does not cover the file class counts as absent for the entry; e.g. an inline browser script in a standalone spec HTML when only Go/vitest harnesses exist), entries whose own `test_harness` is `absent`, and byte-identical copies of untested code already committed elsewhere **only when the staged file's class/runtime is equally non-coverable** (a byte-identical copy into a harness-coverable file class is still a real gap; cite the existing location). Every skipped entry MUST emit one `suppressed_coverage_items` record (`file_path`, `line_start`, `line_end`, `ground`) — a skip without a record is a protocol violation. Each gap carries `severity` (`blocking` | `advisory`), `impact`, `file_class`, `test_harness`, and `required_tests`: for a blocking gap, at least one `edge` test per new boundary/default/error path and at least one `mutation` test whose `mutant` field names the concrete staged-lines mutation it kills. Advisory gaps never block and are mirrored into `### Notes`; only blocking gaps appear under `### Required test coverage`. Vague directives like "add tests" are prohibited.
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
  - `lane`: the lane name this task was spawned under (`"correctness"` | `"security"` | `"content-risk"`).
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
  - `severity`: `"blocking"` (concrete reachable impact proven) | `"advisory"` (no such impact; never blocks).
  - `impact`: Concrete reachable failure or cost the missing test leaves unprotected; required and non-empty for `severity: "blocking"`.
  - `file_class`, `test_harness`: Copied from the scout entry; `test_harness: "absent"` never blocks.
  - `required_tests`: Array of `{kind: "edge" | "mutation", scenario, mutant}` — concrete runnable scenarios; `mutant` is required and non-empty for `kind: "mutation"`.
- **Suppressed Coverage Schema** (correctness lane only, emitted alongside `coverage_gaps`):
  - `suppressed_coverage_items`: Array of `{file_path, line_start, line_end, ground}` — one record per `coverage_map` entry skipped on the suppression grounds (`harness-mismatch` | `byte-identical-non-coverable` | `test-class`); required so the orchestrator can mirror waivers into `### Notes`.

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
  9. **Coverage gaps**: Verify each `coverage_gaps` item is real: reject when the behavior already has a covering test the scout missed (cite it), when the lines are not changed executable behavior (rename, comment, docs-only, test-only), when unreachable, when no runnable harness in this repository covers the file's class/runtime, when the gap's own `test_harness` is `absent`, or when the lines are a byte-identical copy of already-committed untested code **and the staged file's class/runtime is equally non-coverable** (a byte-identical copy into a harness-coverable class is still a real gap; cite the location). Reject a `test`-class gap with ground `test-class`: test code is the harness, not product behavior. Enforce the impact floor: a gap stays `severity: "blocking"` only with a concrete, reachable failure or cost; presentation text, test helpers, seed tooling, or an unproven hunch is confirmed as `severity: "advisory"` (non-blocking, mirrored to `### Notes`) or rejected with ground `advisory-impact`. Every rejected `coverage_gaps` item MUST emit one `rejected_coverage_gaps` record (`coverage_id`, `file_path`, `line_start`, `line_end`, `ground`) — a rejection without a record is a protocol violation. Confirm surviving gaps into `confirmed_coverage_gaps` with `severity`, `impact`, `file_class`, `test_harness`, and `required_tests` intact; never promote an advisory gap to blocking, and never weaken `required_tests`, but add a missing edge or mutation requirement when the behavior obviously needs it.
- **Output Contract**:
  - `coverage_summary`: Summary of verified candidates.
  - `decisions`: Array of per-candidate decisions with fields:
    - `candidate_id`: Matching candidate identifier.
    - `disposition`: `"confirmed"` | `"rejected"` | `"not_proven"`.
    - `triage`: `"lie"` | `"stale_record"` | `"disclosed_gap"` | `"not_applicable"`.
    - `reason`: Factual justification citing repository evidence.
    - `evidence`: File and line citations supporting the decision.
  - `confirmed_findings`: Array of validated findings with normalized priority (`P1` | `P2`), file_path, line range, observed, expected, trigger, impact, and evidence.
  - `confirmed_coverage_gaps`: Array of verified coverage gaps with `coverage_id`, file_path, line range, `behavior`, `severity` (`blocking` | `advisory`), `impact`, `file_class`, `test_harness`, and `required_tests` (`{kind, scenario, mutant}`).
  - `rejected_coverage_gaps`: Array of `{coverage_id, file_path, line_start, line_end, ground}` — one record per `coverage_gaps` item rejected on any ground (`already-covered` | `non-executable` | `unreachable` | `harness-mismatch` | `byte-identical-non-coverable` | `test-class` | `advisory-impact`); required so the orchestrator can mirror waived directives into `### Notes`.
- **Constraint**: Must NOT invent replacement patches or emit verdict markers (`REVIEW_RESULT=...`).

### Stage 4: Orchestrator Synthesis (`reviewer-kit`)
- **Role**: Synthesizes verified evidence, formats the audit report, and controls the commit gate.
- **Report Structure**:
  - `### Review coverage`: Summary of inspected diff, changed files, active skills, and stages executed.
  - `### Confirmed findings`: Detailed list of confirmed findings (priority, path, range, trigger, impact, evidence).
  - `### Required test coverage`: Mandatory directive to the committer — every confirmed `severity: "blocking"` coverage gap with file path, line range, changed behavior, concrete impact, and the concrete tests that must be added (edge tests per new boundary/default/error path, mutation tests naming the killed mutant). "None required" when no blocking gap remains. Only blocking gaps appear here: advisory gaps, `test`-class gaps, and gaps whose per-entry `test_harness` is `absent` are mirrored into `### Notes`; when the scout reported `test_harness: absent`, every gap is non-blocking and goes to Notes.
  - `### Unproven/rejected summary`: Terse summary of rejected or unproven candidates with rationale.
  - `### Notes`: Non-blocking observations (stale records with intact code, check commands suppressing output, showcase stub tests, disclosed gaps with named owners, advisory coverage gaps, `test`-class waivers); never blocks PASS. Coverage items suppressed on the new grounds MUST be mirrored here with `file_path`, line range, and the ground applied — sourced from the three producer records: scout `non_coverable_items`, hunter `suppressed_coverage_items`, verifier `rejected_coverage_gaps` — and a suppression whose producer record is absent is not grounded and must be noted.
  - `### Verified-OK`: Explicit paths, tests, caller checks, and invariants actually verified, each carrying a concrete measure (unit count, path, positive control). Bare "looks correct" is prohibited; never use this section to hide unresolved candidates.
- **Verdict Rule**:
  - Exactly zero confirmed findings and zero blocking coverage gaps -> emit `REVIEW_RESULT=PASS`.
  - At least one confirmed `P1` or `P2` finding -> emit `REVIEW_RESULT=BLOCK`.
  - At least one confirmed `severity: "blocking"` coverage gap with concrete impact, while the scout reported `test_harness: present` -> emit `REVIEW_RESULT=BLOCK`.
  - `not_proven` or `rejected` candidates NEVER block; coverage gaps NEVER block when they are `severity: "advisory"`, when their file is `test`-class, when their per-entry `test_harness` is `absent`, or when the scout reported `test_harness: absent`.
  - A blocking gap without concrete reachable impact is not a blocking gap; it is advisory.
  - If any mandatory stage fails, times out, or produces invalid output -> emit stage-specific explanation and `REVIEW_RESULT=BLOCK`.
