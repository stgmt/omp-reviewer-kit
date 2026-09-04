---
name: reality-first-review
description: OMP Review Kit methodology for evidence-first code review and project review-skill composition.
---

# Reality-first review

Use this method for every staged change.

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

A finding is blocking only when it is introduced by the staged change, has a concrete impact, and is supported by repository evidence.

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

The `reviewer-kit` orchestrator synthesizes the verified findings from the multi-stage pipeline and finishes with exactly one machine-readable line:

```text
REVIEW_RESULT=PASS
```

or:

```text
REVIEW_RESULT=BLOCK
```
