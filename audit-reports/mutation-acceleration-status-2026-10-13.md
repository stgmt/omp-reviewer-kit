# Mutation acceleration — implementation status, 2026-10-13

## Implemented in working tree (not committed/released)

- `scripts/mutation-runner.mjs`: async 4-worker pool, exclusive process/timing lane, one independent copied tree per worker, complete reset verification, per-job scratch and persistent-state overrides, native process-tree stop, strict assertion-based outcome classification, bounded streamed records and timing/concurrency metrics.
- `scripts/mutation-test-reporter.mjs`: native structured test evidence with leaf/suite/skip/error information and ancestor names.
- `scripts/run-mutation-tests.mjs`: original catalog preserved; eight runner-safety mutants added (570 total). `--calibrate` establishes reference/focused correspondence, normal path uses precise mappings. Missing/stale selectors fail, no automatic legacy fallback.
- Deciding error-path tests strengthened with actual no-throw/presence assertions. Mutants that only broke JSON or referenced an absent import were repaired without dropping their IDs or intended changed behavior. Catalog-integrity checks are not kill evidence.
- Installation CLI fixture cannot reach real installers through PATH even if its consent branch is mutated.
- General skill/default routing installed; project skill and release instructions document new defaults.

## Verified

- Integration focused suite: 171 PASS, 0 fail.
- Runner/selection/copied-root tests: real Node 22, 13 PASS, 0 fail.
- Real Node 18: 12 PASS before the added Node22-only ancestry case; native nested selection incompatibility reproduced. Development mutation gate explicitly requires Node22+, matching existing mutation/release CI. Plugin runtime retains Node18 support.
- Old serial release export ultimately logged 562/562 PASS; its wrapper lost control after its hour limit. This is historical evidence, not the new runner proof.
- Full new implementation suite initially 1116 PASS / 44 skipped / 1 fail: copy-list introspection still looked in the old entrypoint. Its contract was migrated to inspect the new helper, with assertions retained. Full suite must be repeated on final bytes.

## Full default gate verified

- Node22.16.0 / Windows: **570/570 killed**, 570 unique IDs, zero survived/timeout/infrastructure/selector-invalid outcomes.
- Immutable input fingerprint: `5d579223184f72acdfcfa0264024dded10853746150dc18945019efeb19edcd5`.
- Wall-clock **973355ms (16m13s)**; setup **1690ms**; aggregate test **1294112ms**, reset **521135ms** (worker sums overlap, not wall-clock components).
- Workers **4**, observed max active **4**; **201 exclusive jobs**. No controlled old/new full-set speedup percentage is claimed.
- Direct exact-index repeat on staged tree `56e630386c39b2b20ef7cec3317d67f6459ba860`: **570/570 killed**, 570 unique IDs, zero blocked outcomes, **751492ms (12m31s)**, max active=4. Aggregate test=1001462ms, reset=434310ms. Fingerprint is identical to the earlier default run. Every returned selector/test hash/ancestry matches the shipped catalog; 570/570 checked.

## Reference and release follow-up

- Frozen discovery calibration processes 567 mutants with full-suite reference and focused tests. Latest observed: 559 results, twelve unresolved assertion gaps in that older snapshot. All twelve have corrected-contract reference/focused proofs from separate frozen runs; discovery has not yet finished.
- A 491-ID discovered-mapping subset passed using the final focused runner: **491/491 PASS**, 885210ms (14m45s), max active=4, setup=1215ms. Aggregate worker test time=1344442ms, reset time=538016ms (sums overlap across workers, not wall-clock components). This is not full-set acceptance or a controlled speedup comparison; reference calibration was running concurrently. The current production catalog contains 570 IDs after additional exclusive/stale-selector/completion-summary safety mutants.
- Corrected contracts/helper mutants: **16/16 calibrated PASS**. Three later progress/environment error contracts: **3/3 calibrated PASS**. All nine current helper-file mutants (eight added plus the moved original isolation mutant): **9/9 calibrated PASS**, 97977ms. That snapshot precedes the final duplicate-leaf accounting regression; final acceptance must use the newer bytes.
- Final distinct contract labels and complete exact-selector artifact: **1118 PASS / 44 skipped / 0 fail**, 1162 tests, 141840ms. Layout: **72 files verified**. Latest runner fixtures: Node22 **13 PASS**, Node18 **12 PASS / 1 intentionally skipped**, both zero failures. Final native offline OMP matrix: **23/23 PASS**, each fixture asserts zero external requests.
- Original full discovery finished: **555/567 killed**, twelve old-snapshot assertion gaps (not falsely counted as kills). Corrected proofs cover those gaps. Current complete catalog has **570 ancestry-bound mappings**, no missing IDs; complete default verification passed as recorded above.
- Late changed-contract reference calibration finished: **131/148 killed**, 17 layout baselines correctly blocked because that run's worker trees were copied before the selector artifact existed. Separate complete-artifact calibration covers those exact 17 IDs: **17/17 PASS**, 55748ms. Combined corrected reference coverage is **148/148**; the raw 148-ID run is not reported as green.
- Active calibration uses an older frozen helper/test version. Its results are mapping-discovery evidence only. The final working implementation needs a new complete focused gate, corrected-mutant reference checks and full tests/layout. Do not claim 567/567 from partial records.

## Still pending

- Final affected-contract reference coverage is complete (148/148 with exact corrected layout proofs). The guarded chain verified unchanged index and exact-index mutation proof, then started the mandatory commit hook: run `2026-10-13T08-23-15-386Z-9e73e3a725fe`. Following that still-active review after the shell task lost its completion tracking; no second commit is started.
- Complete default/exact-index verification is green: 570 unique IDs, no infrastructure failures among kills. Full native ancestry replaced broad historical mappings; batch contracts have distinct source/bundle labels with **5/5 calibrated PASS**.
- Exact-index suite/layout and native offline matrix are green. Cross-platform CI and release remain pending; measured default wall-clock/reset/setup costs are recorded above. No fixed acceleration percentage claimed.
- Commit/release/delivery: not performed. Existing release index intentionally remains unchanged while development occurs; new bytes will require new export/review.
