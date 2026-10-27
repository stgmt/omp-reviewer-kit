# Mutation gate: hint-first stale recalibration and wider worker pool (2026-10-23)

Context: 67 stale selectors (44 hook-guard, 14 native-verdict, 9 extension). Stale recalibration ran a full-suite
reference per stale mutant (hook-guard suite ≈ 748 s serial, extension ≈ 565 s), so each `--calibrate-stale` pass
cost tens of minutes, and a Windows EBUSY death earlier discarded the pass's progress. Related documents:
[acceleration plan](mutation-acceleration-plan-2026-10-13.md), [acceleration status](mutation-acceleration-status-2026-10-13.md).

## Change

1. **Hint-first re-prove** (`scripts/mutation-runner.mjs`): on `--calibrate-stale` the recorded selector is passed
   to the gate as a hint, and each stale mutant is first proved by the ordinary focused proof (focused baseline
   green, expected leaf tests executed, deciding assertion failure under the mutant, fresh `testHash` recorded).
   Only when the recorded names no longer decide does the full-suite reference run — unchanged discovery rules.
   The final full-catalog proof phase is unchanged.
2. **Incremental catalog writes**: every proven stale selector is merged into the catalog immediately
   (partial write, `complete: false`), so an interrupted run keeps its proven work; tree deletion goes through
   `removeTree` (`recursive: true, force: true, maxRetries: 20, retryDelay: 250`) against Windows EBUSY/EPERM
   (confirmed by a real scratch-reproduction test).
3. **Worker pool widened via env only**: `OMP_MUTATION_WORKERS=8` on this workstation (default stays 4;
   1–16 validated by the gate).

## Evidence invariants

- The fast-path proof is exactly the ordinary gate's proof class; discovery calibration keeps the full-suite
  reference guarantee.
- All 59 mutants anchored in `scripts/mutation-runner.mjs` were re-verified for unique anchor matches after the
  change.
- `mergeCalibration`, `testHash`/`mutantHash` staleness, exclusive lanes and the full-verdict exit-code semantics
  are unchanged.

## Tests

- `tests/mutation-runner.test.mjs`: hint fast-path (a suite red as a whole proves no full-suite reference ran) and
  a failed-hint fallback that re-discovers the deciding assertion via the reference.
- `tests/run-mutation-tests-cli.test.mjs`: recorded stale selectors reach the calibration as hints.
- `tests/mutation-runner-cleanup.test.mjs`: `removeTree` contract, real Windows EBUSY reproduction, and durability
  of a proven selector across a simulated crash.

## Expected cost

Stale recalibration drops from ~750 s per hook-guard mutant to focused-proved mutants (~1–8 s each; the focused
baseline is shared per recorded name set); the 67-mutant backlog plus the full gate is expected in roughly
10–15 minutes at 8 workers. The measured pass is recorded below once it runs.

## Measured pass (2026-10-23)

`node scripts/run-mutation-tests.mjs --calibrate-stale`, `OMP_MUTATION_WORKERS=8`:

- Stale subset: 59 of 286 mutants → **59/59 killed in 90.1 s** (focused hint proofs; one pass, no interrupted
  retries, catalog kept current).
- Full gate: **286/286 killed in 1133.9 s** (wall), total wall ≈ 20.4 min, exit 0.
- The verified-focused phase is dominated by the hook-guard suites' current heaviness: the 44 hook-guard mutants
  cost 1082 worker-seconds (avg ≈ 24.5 s, max 76 s per focused proof), hook-guard-edges 258 s, claude-bridge 231 s,
  hook-ownership 215 s — these are the edited BDD flows under 8 workers (maxActive 8; computedTotal 3303 s gives a
  parallel efficiency of ≈ 2.9×). Suite-content heaviness, not gate overhead, is now the cost driver; splitting the
  large suites remains the identified follow-up lever.
