# Native task review — status

Date: 2026-10-22. Branch `feat/hook-guard-0.22.0`, base commit `96bcf71`, merged with `origin/main` (PRs #33 and #34) in merge commit `e2e6ad5`. That merge was made with `--no-verify` at the owner's explicit request, so the review did not run on it. The release commit was made with `--no-verify` at the owner's request, so the review hook did not run on it. The hook's last run on this tree BLOCKed with six confirmed coverage gaps (no findings); targeted tests now cover them. **Not tagged, installed or delivered.**

## Design as implemented

- The review enters OMP's native `TaskTool` with `agent: reviewer-kit`. The entry point is the kit's own Bun host, `src/native/native-host.mjs`, with `src/native/task-engine.mjs` calling `TaskTool.create` and `TaskTool.execute` from the pinned library `@oh-my-pi/pi-coding-agent` 18.12.5.
- There is no OMP source patch, no fork, and no `omp -p --model @task` launch. The earlier fork checkout (`Temp/omp-native-task`, tag `v18.12.2`) is no longer used, and its `upstream/` and `verification/` folders were removed from this repository.
- The kit adds no model dispatcher, preflight, chain overlay, model pin, provider walk, or whole-review retry. The only settings overlay is the structural `task.structured: true`.
- Owner decision to confirm: the approved option 2 in `PLAN.md` describes an OMP-owned entry point. The shipped entry point lives in the kit and calls OMP's exported `TaskTool` without any change to OMP. Whether that satisfies "OMP-owned" in `REQUIREMENTS.md` is the owner's call; this document does not decide it.

## Verified (local, this working tree)

| Check | Result | Boundary |
|---|---|---|
| `npm test` (clean export of the staged index, after the merge, before the review round) | 396 tests, 387 pass, 0 fail, 9 skipped, exit 0 |
| Targeted tests for the review round's six coverage gaps (five touched test files) | 83 tests, 80 pass, 3 skipped | Full `npm test` and mutation gate not re-run on this tree | Opt-in and platform skips are not proof of live behavior |
| `npm run check` (clean export) | layout ok, 65 files verified | Vendored stub, hook marker and layout |
| `npm run test:mutation` (clean export, `--calibrate-stale`, after the merge) | 286/286 killed by a deciding assertion, 619.3 s, exit 0 | The curated catalog; no survivor, no infrastructure error |
| Hook E2E offline cases (`tests/e2e-native-hook.test.mjs`) | nothing staged → `review: SKIPPED (no staged changes)`, exit 0; Bun missing → real `git commit` refused with `review: BLOCK (bun is required …)`, HEAD unchanged | Real git and the real installed hook; no mocks |
| Hook E2E live case (`OMP_REVIEW_KIT_LIVE_E2E=1`) | a real `git commit` → exit 0, `review: PASS`, report contains `# reviewer-kit review: PASS`; 131.6 s | Owner's OMP configuration; one review on a small change; roughly $0.02 at haiku-class pricing |
| Mutation catalog | 286 mutants; three `audit-range` mutants are ported from PR #33 and the commit-guard attached-value mutant is new in this release | See the gate line below |

Live spend so far: about $0.08 across earlier scratch runs plus about $0.02 for the PASS above.

**Mutation gate (earlier run, before the merge):** PASSED. `node scripts/run-mutation-tests.mjs --calibrate-stale` on 2026-10-22 recalibrated the 29 stale mutants of the changed test files, each killed by a deciding assertion, and the full gate then killed 281/281 in 390.6 s with exit 0. The first calibration had 8 survivors (`native-verdict-reviewer-exit-ignored`, `native-yield-other-field-decoded`, `native-yield-first-yield-used`, `native-stage-structure-erased`, `native-stage-aborted-erased`, `native-assignment-profile-fixed`, `native-snapshot-hash-not-of-diff`, `native-host-host-error-passes`); deciding tests were added in `tests/native-verdict.test.mjs`, `tests/native-yield.test.mjs`, `tests/native-assignment.test.mjs`, `tests/native-snapshot.test.mjs` and `tests/e2e-native-hook.test.mjs`. The clean export of the staged index after the merge (`_release-export-0.22.0d`: `bun install --frozen-lockfile`, then `npm test`, `npm run check`, `node scripts/run-mutation-tests.mjs --calibrate-stale`) also passed: `npm test` 396 tests, 387 pass, 0 fail, 9 skipped; `npm run check` layout ok (65 files); the catalog 286/286 killed in 619.3 s, exit 0. Calibration left `scripts/mutation-selectors.json` unchanged.

**Pre-commit review round (2026-10-22).** The first commit attempt was blocked by the review hook (exit 1, HEAD unchanged). Its report found one confirmed P2 and thirteen coverage gaps. The P2 was real: the verdict counted hunter completions instead of planned lanes, so `OMP_REVIEW_KIT_LANES=correctness,security` could pass with no security hunter. The fix makes each hunter report its lane (`lane` in its output schema) and requires one completed hunter per planned lane; `native-verdict-lane-identity-ignored` covers it. The coverage gaps were addressed with deciding tests in `tests/native-task-engine.test.mjs`, `tests/native-review.test.mjs`, `tests/native-host.test.mjs`, `tests/native-file-class.test.mjs`, `tests/native-report-store.test.mjs` and `tests/native-snapshot.test.mjs`, plus three injection seams (the import in `loadOmpEngine`, the export step in `materializeStagedSnapshot`, and the review step in `main`). One gap was rejected by the reviewer and is not a gap (`removeSnapshot`), and one reviewer expectation was wrong (`LICENSE` is `data`, not `executable`; the test asserts the real behavior). The release commit goes through the review hook after the clean export above.

## Not verified

- **Live BLOCK exit code.** `src/native/native-host.mjs` returns `verdict.pass ? 0 : 1`, and `tests/native-host.test.mjs` pins exit 1 on BLOCK offline. The live case exercised only PASS; a live BLOCK has not been run.
- **Fallback to a configured model (NR-04).** The requirement asks for proof that the first eligible fallback runs, and it names Luna. The fork's fallback fixture is not part of this design and was not re-run against unpatched OMP 18.12.5. Not verified.
- **Owner override provenance.** A configured role override is not tested end to end. Not verified.
- **Full profile with the security lane, and the `spec-docs` profile, live.** Not run live.
- **Plugin-directory install.** `omp plugin install` followed by `bun install --cwd ~/.omp/plugins/node_modules/omp-reviewer-kit` has not been run. Bun does not run install scripts, so the library is not present until that command runs. Not verified.
- **Owner state (AT-09).** The fork's read-only store API was removed with the fork. The direct path makes no extra writes beyond what OMP's own TaskTool does, but that has not been checked against the owner's WAL/OAuth profile. AT-09 stays open.
- **Node 18 and 20.** Removed from CI because the suite loads the Bun library. Not verified on those versions.
- **Audit CLI model pin.** `scripts/audit-range.mjs --llm` launches `omp -p --model ${OMP_REVIEW_KIT_MODEL ?? '@slow'}`. This is a kit-side model choice outside the review gate, left unchanged by this release.

## Removed in this release

The model dispatcher, preflight, chain overlay and reader, model re-emit, whole-review reruns, the verdict cache, delta rounds, the context pack, hunter shards, the batch gate and its retries, the rejection envelope, run telemetry and records, the progress commands and superseded-run stop, pre-review check execution, the scout scope planner, and every model and chain environment setting. Details are in `README.md` under "Removed in 0.22.0".

## Coverage-gate precision (2026-10-27, unreleased)

The pre-commit gate used to block a commit for any changed executable behavior without a covering test, with no impact floor and a repo-global `test_harness`. On the owner's corpus that produced 123 coverage-only BLOCKs, including test helpers, BDD steps, seed tooling and UI text (`audit-reports/coverage-gate-test-demand-2026-10-27.md`).

- The scout `coverage_map` now carries `file_class` and a per-entry `test_harness`.
- Hunter `coverage_gaps` and verifier `confirmed_coverage_gaps` carry `severity` (`blocking` | `advisory`), `impact`, `file_class`, and `test_harness`.
- `src/native/verdict.mjs` blocks only a gap that claims `blocking` with a non-empty impact, is not in a `test`-class file (read from `.review/file-classes.json`), has no `test_harness: "absent"`, and fails while the scout reports a runnable harness. Legacy gaps without the new fields keep the old fail-closed behavior.
- Advisory, `test`-class and harness-absent gaps go to `### Notes`, never to `### Required test coverage`.

Verification: the offline verdict, snapshot and review suites pin the new filter; the layout test pins the new schema fields and prompt phrases. `npm test` passed with 450 tests (440 pass, 0 fail, 10 skipped), `npm run check` passed with 65 files, and `node scripts/run-mutation-tests.mjs --calibrate-stale` calibrated 1 stale selector and then killed 292/292 curated mutants (exit 0, 561.6 s, 8 workers). A live review under the new prompt contract has not been run.

The commits that land this change and the 0.23.0 release bump were made with `--no-verify` at the owner's explicit request. The hook could not review them: OMP resolved the reviewer to `anthropic/claude-haiku-5-5`, and every configured fallback is an Anthropic model, while the provider returned `403 permission_error: OAuth authentication is currently not allowed for this organization`. The 2026-10-27 07:07, 07:08 and 20:32 runs and the 2026-10-28 10:56 run all failed this way before any agent content ran. The change is therefore verified offline only.

## 2026-11-10 — host-driven stages and the review journal (variant 1)

Owner approval: «делай вариант 1» for the journal and host-driven stages, then «1 обход. 2 комить пуш доставляй релиз в гитхаб и везде на пк» for the spec-file bypass, the commit and the release.

Design as implemented: `src/native/native-review.mjs` computes the review key, reads the journal, then runs the stage plan from `src/native/stage-pipeline.mjs` through `createStageRunner` (`src/native/task-engine.mjs`): scout, one hunter per lane, the maintainability stage when planned, the verifier, then one synthesis task with `agent: reviewer-kit`. `agents/reviewer-kit.md` is now the synthesizer only — no `spawns`, no `task` tool. The journal lives under `<home>/.omp/review-kit-journal/<key>/` (`src/infra/review-journal-store.mjs`); the key is in NR-09.

Verified locally on 2026-11-10:

| Check | Result |
|---|---|
| `npm test` | 1013 tests, 1003 pass, 0 fail |
| `npm run check` | layout ok, 105 files verified |
| Mutation selectors touched by this change | re-proved with focused gate runs (`[KILLED]`): 3 anchors changed by the verdict/stage-evidence edits, 8 decided by the rewritten layout test, 1 by the test-runner journal isolation |
| Live resume (`E:/tmp/review-probe`, 5 staged paths) | run killed on the hunter; rerun logged `stage review-context-scout reused (journal)` and continued at the hunter |
| Live full cycle (`E:/tmp/review-cycle`, 1 executable path) | scout 50s/82k, hunter 59s/54k, verifier 2m42s/61k, synthesis → BLOCK, record `blocked 5m55s` |
| Live reuse of that verdict | same staged bytes: `journal hit`, `blocked 194ms`, same report text, no model call |
| Changed index tree | staging one more file produced `journal miss` with a new key and a full run |
| Junk in the index | `git add -f debug.log` under `*.log` changed `git write-tree` and `stagedIgnoredPaths` named the path |
| Lane persistence (the false-block fix) | journal stage entry carries `lane: correctness`; run records now carry `journalKey`, `treeOid`, `journalHit`, `ignoredStagedPaths` |

### Review round on this tree (0.31.0)

The hook reviewed the release diff through the new host-driven pipeline (39 staged paths, 43m51s: scout 2m02s/305k, hunter 26m43s/350k, maintainability 11m24s/1354k, verifier 2m46s/207k, synthesis 53s/108k) and BLOCKed with two P2 findings and one blocking coverage gap. All three are fixed in the same release:

1. `pruneJournals` removed any directory under the journal root, so a shared `OMP_REVIEW_KIT_JOURNAL_DIR` could lose unrelated data. It now prunes only directories whose `journal.json` parses with this kit's schema, and a test pins that a foreign folder survives.
2. `configFingerprint` ignored the maintainability analysis configuration, so a verdict decided under looser thresholds could answer a review run under tighter ones. The resolved analysis config is now part of the key, with a test that a threshold change and an insertion-order change behave differently.
3. The stage order of the real host plan had no test. `tests/native-stage-order.test.mjs` records the runner calls of a real `runNativeReview` and pins `scout → hunter → maintainability → verifier → synthesis` for `full`, and the verifier condition for `spec-docs` with and without a candidate.

Scout quality note: the stage listed two paths that do not exist (`src/native/native-review-analysis.mjs`, `src/native/native-review-telemetry.mjs`); the verifier did not challenge the list. The finding set itself was correct.

Boundaries: the mutation gate was not run over the whole catalog on this tree (only the stale selectors were re-proved); the review hook had not yet run on this diff at the time of writing; `ACCEPTANCE_CRITERIA.md` still describes the fork-era matrix.

## Documents

- `REQUIREMENTS.md` remains the binding requirement. Its wording was written for an OMP-owned entry point; see the owner decision above.
- `ACCEPTANCE_CRITERIA.md` lists AT-01 to AT-11. Several of those tests and evidence files belonged to the fork and are not present. The matrix does not match this implementation and has not been re-baselined.
- `PLAN.md` is the decision record for the variants. Its status line describes the implementation that was approved, not the final state.
- `native-task-review.feature` is declarative; no suite executes it.
- `MUTATION_RETIREMENT.json` (`mutation-retirement@1`) lists the 807 retired mutants of the earlier catalog with the reason each one was retired.
