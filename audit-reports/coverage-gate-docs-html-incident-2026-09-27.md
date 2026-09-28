# Incident: coverage_required BLOCK on a spec-doc inline TOC script

- Date: 2026-09-27
- Repo of the blocked commit: `E:/repos/tokenplan/.claude/worktrees/telegram-bot-preorder-specs-adbfd3` (branch `claude/telegram-bot-preorder-specs-adbfd3`, tokenplan worktree)
- Blocking run: `2026-09-27T16-29-49-292Z-a7abc53088d8`, report `2026-09-27T16-29-49-292Z-a7abc53088d8...md`, verdict `coverage_required` on `telegram-bot-spec.html:826-832`
- Cost: ~35 min review × the blocking run; the file is on its 5th blocked commit attempt today (~2.5 h cumulative wall time on this diff shape)

## What happened

The staged `telegram-bot-spec.html` copied index.html's 7-line TOC script (`<script>`: `matchMedia` collapse of `<details class="navigation">` below 900 px + `IntersectionObserver` setting `aria-current` on `.toc a`). Pipeline chain that produced the BLOCK:

1. `review-context-scout` enumerated the script in `coverage_map` as "changed executable behavior" with `covering_test: null`, and recorded `test_harness: present` (Go tests + godog exist under `gateway/`).
2. `review-risk-hunter` (correctness lane) emitted `coverage-1` per its rule: every `covering_test: null` entry that is not a rename/comment/docs-only/unreachable diff produces a `coverage_gaps` item. An inline `<script>` is literal code, so it survived the "docs-only" skip.
3. `review-finding-verifier` checked the gap against its three rejection criteria — already covered / not executable / unreachable — and could not reject: the script is new executable code, reachable on every page load, with zero covering tests. It confirmed `confirmed_coverage_gaps` verbatim. Notably the verifier explicitly inspected the script as defect-free ("observer logic sound") yet still had to confirm the gap.
4. `reviewer-kit` synthesis emitted the `coverage_required` envelope → `REVIEW_RESULT=BLOCK` because `test_harness: present`.

## Why this is a real gate defect (not reviewer stupidity per se)

The pipeline executed its written contract exactly. The contract has three holes:

1. **Harness scope is repo-global, not file-runtime.** `test_harness: present` means "the repo has any runnable test harness" (`gateway/` go test, `gateway/web` vitest, godog BDD). Neither harness covers repo-root standalone spec HTML. The gate treats "a harness exists somewhere" as "every changed executable file is testable," which makes any inline browser JS in a docs file blockable. The verifier has no rejection ground for "no harness covers this file class" — it is absent from the reject list in both `agents/review-finding-verifier.md` (rule 11) and `skills/multi-stage-review/SKILL.md` (§Stage 3, item 9).

2. **"Changed executable behavior" excludes docs but not doc-viewer chrome.** Hunter skip list (agents/review-risk-hunter.md "Coverage Gaps") names: renames, comments, docstring edits, test-only or docs-only diffs, unreachable code. An inline `<script>` in a `.html` spec is formally "executable" — so it must be enumerated. The distinction "code that is the document's own presentation chrome, identical to a convention already shipped in sibling docs" exists nowhere in the contract.

3. **Missing "existing convention / identical copy" exemption.** On 2026-09-26 the same byte-identical script in `billing-spec.html` was emitted as `coverage-1` and rejected by the verifier with the argument "byte-identical copy of the script already shipped and live in index.html:1969-1974 — the established, untested spec-page chrome convention" (report `2026-09-26T19-43-13-648Z-702a08b4...md`). That argument is not one of the allowed rejection grounds; it was an off-contract rescue. The 2026-09-27 run simply followed the contract to the letter — the differing outcomes on identical code are the gate's nondeterminism surfacing, not agent variance in judging evidence.

4. **Coverage gate ignores blast radius entirely.** A `required_tests` directive carries equal blocking weight whether the code is a payment-path branch or TOC highlighting chrome. There is no severity floor for `coverage_required` envelopes; `confirmed_findings` require P1/P2 impact, but coverage gaps require none (deliberately: "does not need P1/P2 impact proof", agents/review-risk-hunter.md:50). For gate-worthy code that is correct (hunter's own words: "defect-free"), that creates the observed absurdity: verifiably-correct presentation code blocks a commit for lack of tests that no sibling doc has.

## Prior art inside the repo

- `index.html` itself ships the identical untested script at lines ~1969-1974 — the convention predates the gate.
- `billing-spec.html` (committed 2026-09-26, `d72bf19`) ships the same script and passed review the next day (`2026-09-27T16-19-31-678Z`, PASS) with `coverage_map` empty — i.e., the same artifact can pass, be flagged-and-rejected, or be flagged-and-blocked depending on which contract clause an individual run leans on.

## Fix options (increasing strength)

### A. Prompt-level: extend the skip/reject lists (cheap, LLM-dependent)

Add to the hunter's skip list and the verifier's reject grounds:

- "non-production executable artifacts whose only consumer is the document itself (doc-viewer chrome, presentation helpers), when the repo already ships the identical pattern untested" — reject `coverage_gaps` for it;
- "no runnable harness in the repo can exercise this file class" — the verifier may reject on file-runtime/harness mismatch, not only on the three current grounds;
- "identical copy of an already-committed untested pattern in the same repo" (citation required) — the convention exemption, made explicit instead of off-contract.

Cost: one-line changes in `agents/review-risk-hunter.md`, `agents/review-finding-verifier.md`, `skills/multi-stage-review/SKILL.md`, `agents/reviewer-kit.md` (Notes mirroring). Still probabilistic — the model must choose to apply them.

### B. Deterministic file-class gating in `run-review.mjs` (structural)

The runner already parses `coverage_items` (`validateCoverageItem`, scripts/run-review.mjs:830-840). Add a hard file-class filter at evaluation time: strip (into a `Notes`-only section) coverage items whose `file_path` matches a non-production class — e.g. `*.html`, `*.md`, `docs/**`, `*.svg` — when no entry in the item's own evidence names a runnable harness for that class. The envelope then sees zero items → PASS. Deterministic, but needs the file-class table to be right; an `.html` SPA source file would need a manifest escape hatch.

### C. Split `test_harness` semantics (protocol-level)

Replace the boolean with a per-coverage-item check: the scout records `test_harness` per `coverage_map` entry ("which runnable harness covers this file's runtime"), not once per repo. `test_harness: absent` for an item → the gap is `### Notes`-only, never blocking. This is the semantically correct fix and kills the whole class: doc scripts, example snippets, one-off tools without harness coverage. It requires schema changes in four agent contracts + runner validation.

### D. Minimum-impact floor for `coverage_required` (policy)

Require `coverage_items` to carry a risk/reachability justification comparable to the P2 bar before they block; demote zero-impact gaps to `### Notes`. Weakens the gate's purpose ("everything changed must be covered") — trade-off to weigh explicitly; policy decision, not obvious.

## Recommendation

A + C: extend the rejection grounds now (single-line prompt diffs, lands in next release) and change `test_harness` to per-item scoping at the next protocol revision. B alone would hard-code a file-class table that ages poorly; D alone hollows out the gate.

## Verification gap to note

The currently-running review (`runId 2026-09-27T17-07-45-690Z-94fd89053aca`) covers the staged tree without the script. Per the gate's rules a docs-only diff should produce zero coverage items — same as the PASS at `2026-09-27T16-19-31` in the billing worktree. The risk for the running review is not the script but the confirmed_findings lane, which has already produced different P2 findings on every one of the 4 prior attempts of this spec (duplicate-seat formula, stale footer label, anchor mismatches) — the docs-review lane is nondeterministic in finding count, a separate quality issue.

## Status

- **A — landed** (this commit): scout `coverage_map` now excludes code no repo harness can execute for its file class (`agents/review-context-scout.md`); hunter skips harness-runtime-mismatched entries and byte-identical copies of already-committed untested code (`agents/review-risk-hunter.md`); verifier gained both as explicit rejection grounds (`agents/review-finding-verifier.md`, `skills/multi-stage-review/SKILL.md`); the orchestrator `### Notes` clause mandates mirroring ALL suppressed coverage items — scout-excluded, hunter-skipped, or verifier-rejected — with `file_path`, line range, and ground applied (`agents/reviewer-kit.md`, `skills/multi-stage-review/SKILL.md`). Genuine defects in the same code still produce P1/P2 candidates — only the coverage directive is suppressed.
- **Self-review iterations**: this commit was itself BLOCKed twice by the gate it modifies — first for the Status section overclaiming landed scope (reviewer-kit.md Notes mirroring was priced but not landed), then for the mirror enumerating only two of three suppression points (scout exclusions missed). Both defects were real and fixed in-place; the landed text above is the post-review state.
- **C — pending**, tracked as ROADMAP Phase 4a "Per-Item Harness Scoping".
