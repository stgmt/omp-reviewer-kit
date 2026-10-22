# Native OMP task review — index

Requirement: the review kit must enter OMP's native `TaskTool` directly with `agent: reviewer-kit`. Models, roles, effort, overrides, credentials and fallback belong to OMP and the owner's configuration. The kit must not add a model dispatcher, preflight, chain overlay, model pin or provider walk.

## Documents

- [REQUIREMENTS.md](REQUIREMENTS.md): the binding invariants NR-01 to NR-08.
- [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md): the acceptance matrix AT-01 to AT-11. It does not match the current implementation; see STATUS.
- [PLAN.md](PLAN.md): the variants considered and the approved option 2. A decision record, not a status report.
- [STATUS.md](STATUS.md): what is implemented, what was verified and with which boundary, and what is not verified. Read this before claiming anything.
- [native-task-review.feature](native-task-review.feature): a declarative Given / When / Then contract. No suite executes it.
- [MUTATION_RETIREMENT.json](MUTATION_RETIREMENT.json): the ledger of retired mutants (`mutation-retirement@1`), with the reason for each one.

Documents are not acceptance. Acceptance evidence is the test and gate output recorded in STATUS.md.
