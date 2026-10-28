# Audit: does the review gate force unnecessary tests?

- Date: 2026-10-27
- Repository: `E:\repos\omp-reviewer-kit` (0.22.1 tree, HEAD `c134524`)
- Question: the owner reports that the pre-commit review "forces tests for every trivial thing". Verify or refute, with evidence.
- Answer: **confirmed in substance, with a precise boundary.** The gate does not demand tests for every change, but it does block commits for missing tests on changed executable behavior **without any impact floor**, and in practice it demands tests for test helpers, BDD step code, seed tooling and UI text. Part of this contradicts the gate's own written exemption for test-only diffs.

## 1. Method

1. Read the contracts that produce the verdict: `agents/reviewer-kit.md`, `agents/review-risk-hunter.md`, `agents/review-context-scout.md`, `agents/review-finding-verifier.md`, `skills/multi-stage-review/SKILL.md`, `skills/reality-first-review/SKILL.md`, `src/native/verdict.mjs`.
2. Enumerated all 1,072 saved reports under `~/Documents/omp-reviewer-kit/**/*.md` and parsed the verdict, the `### Confirmed findings` section and the `### Required test coverage` section with a throwaway Node script (not committed).
3. Manually read eight reports that the parser flagged, plus the kit's own incident report and status record.
4. No live model run and no repository mutation were performed. The review corpus is the owner's own history, so it is observational, not a controlled experiment.

## 2. How the gate decides

```
scout coverage_map (every changed executable behavior, covering_test: null)
        -> hunter coverage_gaps      (no P1/P2 impact proof required)
        -> verifier confirmed_coverage_gaps
        -> orchestrator REVIEW_RESULT=BLOCK when test_harness: present
        -> verdict.mjs rejects a PASS that contradicts a confirmed gap
```

The decisive contract lines:

- `agents/review-risk-hunter.md:48` — "For every entry whose `covering_test` is `null`, emit a `coverage_gaps` item — this is a coverage directive, not a defect candidate, and it does not need P1/P2 impact proof."
- `skills/multi-stage-review/SKILL.md:98` — same rule, plus "Each gap carries `required_tests`: at least one `edge` test per new boundary/default/error path and at least one `mutation` test whose `mutant` field names the concrete staged-lines mutation it kills."
- `skills/reality-first-review/SKILL.md:26` — "every changed executable behavior without a covering test ... is a coverage gap ... and blocks the review."
- `skills/reality-first-review/SKILL.md:79` — the blocking definition is syntactic: "new or altered control-flow branch, boundary, default, side effect, or error path reachable from a caller".
- `agents/reviewer-kit.md:59` — the orchestrator must list every confirmed gap with "at least one edge test per new boundary, default or error path, and at least one mutation test naming the mutant it kills".
- `src/native/verdict.mjs:79-82` — deterministic backstop: a reviewer PASS is still blocked when the verifier confirmed a gap and the scout said `test_harness: present`.
- `tests/native-verdict.test.mjs:176-183` — an offline test pins exactly that behavior.

This is an intentional asymmetry: **findings need P1/P2 impact; coverage gaps need none.** The kit's own incident report calls it out: "coverage gaps require none (deliberately ...). ... There is no severity floor ... that creates the observed absurdity: verifiably-correct presentation code blocks a commit for lack of tests" (`audit-reports/coverage-gate-docs-html-incident-2026-09-27.md:27`).

## 3. Observed cases

### 3.1 A one-line change in a test file, with no functional impact

`~/Documents/omp-reviewer-kit/team-tokenplan-ops-admin-cabinet-9cd5a359-be17b7f01944/2026-10-25T09-09-56-191Z-c9b11375d6ad.md`

- Staged paths: **1** (`gateway/bdd/admin_steps_test.go`), one added line: `cmd.Dir = w.dir` at line 829.
- `### Confirmed findings`: "None. No P1 or P2 defect was confirmed."
- The report itself says the gap "is about protecting the changed line, not a defect in the line" and "the cwd change has no reachable functional impact beyond the logs directory location" (lines 45-46).
- Verdict: `REVIEW_RESULT=BLOCK`, with a required edge test and a required mutation test.

The same file was blocked again on 2026-10-25 (`2026-10-25T09-20-15-010Z-6ba9880b8694.md`): **1 staged path**, 5 confirmed coverage gaps for a new `os.Stat(...)` assertion inside the test helper. All five required tests test the test assertion.

### 3.2 A 12-file test-only BDD diff, 22 required tests

`~/Documents/omp-reviewer-kit/team-tokenplan-ops-team-harnesss-skil-c1957cb2-3d0d5dd3d806/2026-10-22T20-34-44-264Z-41582889b618.md`

- Staged paths: **12**, all under `gateway/bdd` (2 `.feature`, 10 `.go`; every required test target is a `_test.go` file) — test code only.
- Scout: 47 coverage entries, 22 with `covering_test: null`.
- Hunter: 0 defect candidates, 22 coverage gaps.
- Verifier: all 22 confirmed, 0 rejected.
- Result: `REVIEW_RESULT=BLOCK`; the required tests cover helpers such as `closeDB` (nil guard), `ownerPoolCall` branches, `setPoolObjects` ordering and `standAssertPoolObjects` messages (lines 36-58).

The same class repeats on the 2026-10-25 tg-invid worktree: a 3-file diff (feature + two `_test.go`) produced a required test for the `sbExhaustPlan` transport-error branch, and the report says "No test covers this branch" (`wt-tg-invid-28fa95d63c6a/2026-10-25T09-57-22-919Z-b7743ce91a24.md:31-35`).

### 3.3 Tests for display text and `'-'` fallbacks

`~/Documents/omp-reviewer-kit/affinity-readonly-bda9a5e01791/2026-10-26T13-23-54-957Z-ef84922d73e7.md`

- 25 staged paths, one React file (`channel-affinity/index.tsx`).
- `### Confirmed findings`: "None."
- Six confirmed gaps, including:
  - a read-only notice: render and assert the text is visible; mutation: delete the Alert block (lines 41-43);
  - the name cell `'-'` fallback; mutation: drop `|| '-'` (lines 49-52);
  - the TTL cell `'-'` fallback; mutation: drop `|| '-'` (lines 53-56);
  - a "Group" badge condition; mutation: remove the badge entry (lines 57-59).
- Result: `REVIEW_RESULT=BLOCK`.

These are assertions about presentation strings, not behavior with a failure impact. The gate is doing exactly what its contract says; the contract has no blast-radius filter.

### 3.4 A test helper's cleanup is "uncovered"

`~/Documents/omp-reviewer-kit/rework-pr83-a09e87b782c2/2026-10-23T10-45-37-206Z-d5aef0d5f067.md`

- 7 changed Go files, all test files or the BDD harness.
- The verifier **rejected** the gap because the lines are test-only.
- The orchestrator **overrode the rejection**: "In Go, `_test.go` helpers are executable code ... Any test-only exemption is a rule decision for the owner, not a verifier ground" (line 47).
- Required tests: a test for `setQuotaUnitForTest` restoring `common.QuotaPerUnit`, including a mutation test for the constant `500000` (lines 35-38).
- Result: `REVIEW_RESULT=BLOCK`.

This is a direct contradiction inside the contract: `agents/review-risk-hunter.md:48` says to skip "test-only ... diffs", and `skills/multi-stage-review/SKILL.md:152` lists "test-only" as a verifier rejection ground, while `skills/reality-first-review/SKILL.md:79` counts test code as executable behavior. The observed run chose the strict reading and blocked.

### 3.5 The kit's own release was blocked the same way

`.specs/native-task-review/STATUS.md:3` — "The hook's last run on this tree BLOCKed with six confirmed coverage gaps (no findings); targeted tests now cover them."
`.specs/native-task-review/STATUS.md:28` — the first 0.22.0 commit attempt had "one confirmed P2 and thirteen coverage gaps"; the gaps were addressed with tests in five test files.

So the mechanism is not a consumer-repo accident; it is the kit's normal behavior on its own tree.

## 4. Corpus statistics

Parsed from `~/Documents/omp-reviewer-kit/**/*.md` (1,072 reports):

| Metric | Count |
|---|---|
| PASS reports | 403 |
| BLOCK reports | 563 |
| Coverage-only BLOCKs (zero confirmed findings, non-empty `### Required test coverage`) | **123** |
| …of which in the modern report format, strict parse | 61 |
| …of which name **only test/spec files** as targets (strict set) | 10 |
| …that explicitly require a `mutation` test (strict set) | 45 |
| Median staged paths in coverage-only BLOCKs | 7 |
| Coverage-only BLOCKs with ≤10 staged paths | 33 |
| Largest single required-test list observed | 22 gaps (the 12-file BDD diff above) |

"Coverage-only" means the `### Confirmed findings` section starts with `None`/`No`/`0` and the `### Required test coverage` section is not "None required". The 123 is a lower bound: 106 older reports lack the current section format and were not classified.

A representative sample of the shortest directives shows the granularity:

- a React `key` change: test that two items with the same title but different URLs do not log a duplicate-key warning (`session-anchor-724967d7341f/2026-10-26T04-33-22-042Z-1001bc505d25.md`);
- a removed audit-template entry: test the rendered text for a stored log row (`affinity-readonly-bda9a5e01791/2026-10-26T13-32-49-976Z-072f193b1747.md`);
- a seed tool `main()`: a test that re-execs the test binary with a `TEST_*` guard (`team-tokenplan-ops-admin-alert--tg-bo-a650bba8-99525e713604/2026-10-22T16-59-40-768Z-2d9a8f714ed0.md`);
- one line `cmd.Dir = w.dir` in a BDD step (`team-tokenplan-ops-admin-cabinet-9cd5a359-be17b7f01944/2026-10-25T09-09-56-191Z-c9b11375d6ad.md`).

## 5. Where the claim is false (fairness check)

The gate is not a blanket "test everything" gate:

- **403 reviews passed.** It does not block every change.
- **Docs/prompts/specs/config only** run the `spec-docs` profile with no `coverage_map` and "None required" (`agents/reviewer-kit.md:44`, `skills/multi-stage-review/SKILL.md:46-58`).
- **Comments, pure renames, non-coverable file classes and already-covered behavior** are skipped or rejected; sampled reports rejected 5/7, 2/8, 3/7 and 2/6 gaps respectively.
- **No runnable harness** means gaps are non-blocking (`skills/reality-first-review/SKILL.md:80`).
- **Real defects are caught**: the 0.22.0 review found a genuine P2 (the verdict counted hunter completions instead of planned lanes), and the docs incident exposed and fixed a false-block class.

The accurate statement is therefore: **not "tests for every change", but "tests for every changed executable branch in a harness-coverable file, with no impact floor"** — and that definition includes test code, test helpers, tooling and UI text. That is enough to produce the owner's experience.

## 6. Root causes

1. **No impact floor for coverage.** Findings need P1/P2; gaps explicitly need no impact proof (`agents/review-risk-hunter.md:48`). This is deliberate, and it is the direct cause of tests for display text and test helpers.
2. **Syntactic definition of "behavior".** Any new branch, default, boundary, side effect or error path counts, regardless of reachability impact (`skills/reality-first-review/SKILL.md:79`).
3. **`test_harness` is repo-global, not per item.** A Go/vitest suite anywhere in the repo makes every changed executable file "coverable", including standalone HTML and test tooling. The per-item fix is still open (`ROADMAP.md:73`, Phase 4a).
4. **Test-only exemption is contradictory and unstable.** The hunter rule and the verifier ground say test-only is not executable behavior; the methodology counts it as executable. Observed outcomes differ: the verifier rejected it once and the orchestrator overrode it (3.4), while other runs confirmed 22 gaps on a test-only diff (3.2).
5. **Fail-closed synthesis.** The orchestrator may override a verifier rejection, and a PASS cannot stand against a confirmed gap. The strictest reading wins.
6. **Mutation-test requirement per gap.** Each gap demands an edge test and a test naming the mutant it kills. This doubles the work and produces tests whose only purpose is to satisfy the gate.

## 7. Options (A, B and C implemented 2026-10-27; D and E remain open)

Status: the owner chose **A + C + B**. As of 2026-10-27 the gate enforces them together: scout `coverage_map` entries carry `file_class` and a per-entry `test_harness`; hunter and verifier gaps carry `severity` (`blocking` | `advisory`), `impact`, `file_class`, and `test_harness`; and `verdict.mjs` blocks only a `blocking` gap with a non-empty impact in a non-`test` file class with a present per-entry harness while the scout reports a runnable harness. Advisory, `test`-class and harness-absent gaps are mirrored to `### Notes` and never block. The changes are pinned by `tests/native-verdict.test.mjs`, `tests/native-review.test.mjs`, `tests/native-snapshot.test.mjs` and `tests/plugin-layout.test.mjs`.

| Option | Effect | Cost / risk |
|---|---|---|
| **A. Impact floor** — require a reachable P2-level impact or a named blast radius before a gap blocks; otherwise `### Notes` | Kills the "display text" and "test helper" class | Weakens "everything changed must be covered"; policy decision, same as option D in the 2026-09-27 incident |
| **B. Per-item harness scoping** — `test_harness` per coverage entry, `absent` never blocks | Kills docs/HTML/tooling false blocks structurally | Schema changes in four agents + runner validation; already on `ROADMAP.md:73` |
| **C. Explicit test-code exemption** — gaps in `test`-class files never block; require coverage of product behavior instead | Resolves 3.1, 3.2, 3.4 cleanly | Needs a deterministic file-class check at verdict time, not only a prompt rule |
| **D. Coverage mode switch** — `OMP_REVIEW_KIT_COVERAGE=block|notes|off`; findings still block | Gives the owner a per-repo choice; no change to the default | New env surface and tests; the owner's own gate could be weakened silently if set globally |
| **E. Narrow the definition** — only product-facing behavior, not test/tooling/UI text | Most faithful to the intent | Requires a clear ownership boundary and prompt/schema changes |

Owner decision: **A + C + B together** (2026-10-27). **D** remains an escape hatch and **E** a possible later narrowing; neither is implemented.

## 8. Evidence index

Contract:
- `agents/review-risk-hunter.md:48-52`
- `agents/reviewer-kit.md:30, 59, 72-76`
- `skills/multi-stage-review/SKILL.md:98, 152, 171-179`
- `skills/reality-first-review/SKILL.md:26, 79-80`
- `src/native/verdict.mjs:74-87`
- `tests/native-verdict.test.mjs:176-183`

Prior internal analysis:
- `audit-reports/coverage-gate-docs-html-incident-2026-09-27.md:19-27` (blast radius ignored; "observed absurdity")
- `ROADMAP.md:69-75` (Phase 4a, per-item harness pending)
- `.specs/native-task-review/STATUS.md:3, 28` (13 gaps and 6 gaps on the kit's own release)
- `CHANGELOG.md:317` (coverage gate introduced in 0.12.0)

Reports:
- `team-tokenplan-ops-admin-cabinet-9cd5a359-be17b7f01944/2026-10-25T09-09-56-191Z-c9b11375d6ad.md` (1 line, test file, no impact)
- `team-tokenplan-ops-admin-cabinet-9cd5a359-be17b7f01944/2026-10-25T09-20-15-010Z-6ba9880b8694.md` (5 gaps in one test file)
- `team-tokenplan-ops-team-harnesss-skil-c1957cb2-3d0d5dd3d806/2026-10-22T20-34-44-264Z-41582889b618.md` (22 gaps, test-only diff)
- `wt-tg-invid-28fa95d63c6a/2026-10-25T09-57-22-919Z-b7743ce91a24.md` (gap in BDD step test)
- `rework-pr83-a09e87b782c2/2026-10-23T10-45-37-206Z-d5aef0d5f067.md` (orchestrator override of a test-only rejection)
- `affinity-readonly-bda9a5e01791/2026-10-26T13-23-54-957Z-ef84922d73e7.md` (UI text and fallbacks)
- `team-tokenplan-ops-balanser-72d4c0db-f68a6a43e243/2026-10-26T13-47-54-578Z-bc1eada1d822.md` (2 product gaps after 5 rejections)
- `team-tokenplan-ops-balanser-72d4c0db-f68a6a43e243/2026-10-26T14-01-23-611Z-964c9cdb2b56.md` (3 product gaps; verdict formatting block)
