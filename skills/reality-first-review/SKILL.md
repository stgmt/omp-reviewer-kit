---
name: reality-first-review
description: OMP Review Kit methodology for evidence-first code review and project review-skill composition.
---

# Reality-first review

Use this method for every staged change.
The dispatcher provides an absolute staged snapshot directory. Read source files, tests, and fixtures from that snapshot only; use the repository working tree only for read-only Git metadata, caller discovery, and selected skill discovery. Treat the snapshot as the authoritative review input so unstaged worktree content cannot influence findings. The staged diff itself is materialized at `<snapshot>/.review/diff.patch` and the changed-file list at `<snapshot>/.review/changed-files.txt` — read them as files instead of running `git diff` or `git show` for review content.

## Review contract

Review the current staged change, not an imagined implementation and not unrelated old work.
Execution of review stages follows the `multi-stage-review` protocol: context discovery, parallel correctness and security risk hunting, adversarial verification, and orchestrator synthesis.

1. Establish the actual input: repository, staged paths, staged diff, and relevant consumers.
2. Find the owner of each changed rule or fact.
3. Follow the value from input through validation to side effect and result.
4. Treat absence, defaults, failure, and refusal as observable values.
5. Check irreversible actions before they happen.
6. Check that equal inputs produce equal decisions where the contract requires it.
7. Check types and structures for impossible states.
8. Check every caller and consumer at the boundary.
9. Check the new success path, not only the new rejection path.
10. Require a test that would fail without the change when behavior changed.
For correctness review, inspect focused tests and record concrete test evidence. Missing tests or unnecessary code are not separate defect classes; report them only when a reachable P1/P2 correctness impact is proven, using the existing `correctness` or `security` envelope categories.

## The sixteen review rules

- Prove reality before changing code.
- Model meaning directly.
- Give each rule one owner.
- Make consumers ask the owner instead of duplicating facts.
- Preserve the real protection when relaxing a prohibition.
- Treat absence and defaults as values.
- Validate before irreversible side effects.
- Keep equal inputs deterministic where required.
- Treat rule changes as migrations.
- Delete concepts that carry no meaning.
- Test the new path, not only the new refusal.
- Make tests prove the behavior change.
- Use types and structures to prohibit nonsense states.
- Never maintain two truths.
- Prefer the simplest correct design over historical shape.
- Verify the complete path: input, values, validation, side effect, result.

## Anti-neuroslop contract

A green check is weak evidence. A green check proven able to go red is strong evidence. Apply this contract to every staged check, assertion, recorded number, and status claim.

### The six neuroslop forms
1. An assertion that cannot fail — it verifies what is true by construction.
2. A check that inspected nothing — an empty file list, a pattern with zero matches.
3. A stub returning exactly the value that is then asserted.
4. A closed/done status carrying command output that no longer runs.
5. A recorded number produced by a different command than the one recorded.
6. A green run in an environment that does not match the declared one.

### The red question
For every staged check ask: "what would have to break in the tree for this check to fail?" If the answer is "nothing" or "unknown", that is a finding, even when the surrounding code is correct.

### Self-tool rule
Any query you wrote yourself that returned zero matches cannot support a conclusion until you count the units it inspected, find a known-positive case in the tree, and show the query matches it. A check that cannot be shown to see anything has proven nothing.

### Vacuum checklist
For every staged check of the form "the list of violations is empty":
- count the inspected units with your own query;
- find at least one known-positive case and show it is legitimately outside the checked zone;
- state what happens when the directory is missing or renamed — an empty list silently green, or an error?

### Triage
Separate three things and never merge them:
- a lie — the record contradicts the tree;
- a stale record — it was true, the code moved on;
- a disclosed gap — the author named it themselves. A disclosed gap is still a gap, but it raises trust in the report; never punish it harder than a hidden one.

### Blocking and non-blocking
Blocking (confirmed finding, `correctness` or `security`): a check closing a task that no longer runs; green reproducible only in an undeclared environment; an assertion weakened or deleted to go green; an acceptance criterion with no executable coverage while marked closed; a measurement replaced by a verdict where the protocol requires a number.
Non-blocking (report under `### Notes`): a stale record with intact code; a check command that suppresses its own output; a showcase test on a stub when the same contract is proven on a real object elsewhere; a disclosed gap with a named owner.

### Reviewer anti-patterns
- Reading a diff and writing "looks correct" — a diff carries no information about execution.
- Accepting a number because it is plausible — plausibility is what neuroslop looks like.
- Stopping at the first finding — the first finding is usually the cheapest.
- Confusing "I found nothing" with "there is nothing" — first prove the check can find anything.
- Punishing a disclosed gap harder than a hidden one — that teaches the next author to stay silent.
- Checking only what the report names — the interesting part is what it does not name.
- Not verifying your own tool — see the self-tool rule.
- Running a destructive command for a prettier output — dry runs, build-without-run, and history answer almost everything.

## Anti-parasitic architecture contract

Treat self-referential control infrastructure as a correctness defect, not as a style preference. The five owned defect forms are:

- micro-CLIs that replace direct calls to an existing domain service;
- local PKI or trust stores where no separate trust boundary exists;
- file inboxes or process exit codes that replace a framework's native pause and persistence mechanism;
- process receipts that replace tests of observable product behavior;
- indiscriminate command capture that duplicates existing logging without a domain requirement.

Confirm such a candidate as `P2` correctness only when both facts are proven from repository or declared-framework evidence:

1. an existing repository or framework mechanism directly solves the same responsibility;
2. the staged layer adds no product capability and serves only its own control process.

Ownership cost, process boundaries, storage growth, and token usage describe impact; they are not a third confirmation condition. If either fact is absent, record the candidate as `rejected` or `not_proven`. Do not apply this rule to a Port/Adapter or Template Method that adds a real capability, a public CLI that is a product boundary, or cryptography that protects a genuinely remote untrusted payload.

## Project review skills

OMP supplies the available skills. Do not scan `.omp/skills` manually and do not create a second registry.

Before judging the change:

1. inspect the available skill descriptions;
2. select project or user skills relevant to the changed paths and behavior;
3. read only those selected skills;
4. apply their rules without copying them into this skill;
5. report the skills actually used.

Use existing OMP fields such as `description`, `globs`, and `alwaysApply` to determine relevance. A project skill owns its subject matter; this skill owns the review method.

## Finding contract

A finding is blocking only when it is introduced by the staged change, has a concrete impact, and is supported by repository evidence. Every finding must name the observation that demonstrates it — a code path, a command, a query with its inspected-unit count, or a step sequence. A finding whose only support is a reading impression is an opinion and must not block.

Every finding includes:

- priority;
- file path;
- line or range;
- observed behavior;
- expected behavior;
- minimal explanation of impact;
- evidence or reproduction path.

Do not report guesses as defects. If evidence is missing, say `not proven` and keep it separate from blocking findings.

## Final result

The report also contains `### Verified-OK`, listing paths, tests, caller checks, and invariants actually verified; it does not convert unresolved findings into approval.

The `reviewer-kit` orchestrator synthesizes the verified findings from the multi-stage pipeline. A BLOCK must carry exactly one `review-rejection-envelope@1` between standalone `REVIEW_REJECTION_ENVELOPE_BEGIN` and `REVIEW_REJECTION_ENVELOPE_END` lines immediately before the verdict. Confirmed findings use only `correctness` or `security`; a stage failure uses the `execution_failure` code and a non-empty diagnostic message. PASS carries no envelope. The response finishes with exactly one machine-readable line:

```text
REVIEW_RESULT=PASS
```

or:

```text
REVIEW_RESULT=BLOCK
```