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

## Documents

- `REQUIREMENTS.md` remains the binding requirement. Its wording was written for an OMP-owned entry point; see the owner decision above.
- `ACCEPTANCE_CRITERIA.md` lists AT-01 to AT-11. Several of those tests and evidence files belonged to the fork and are not present. The matrix does not match this implementation and has not been re-baselined.
- `PLAN.md` is the decision record for the variants. Its status line describes the implementation that was approved, not the final state.
- `native-task-review.feature` is declarative; no suite executes it.
- `MUTATION_RETIREMENT.json` (`mutation-retirement@1`) lists the 807 retired mutants of the earlier catalog with the reason each one was retired.
