---
name: range-audit
description: Audit a Git commit range for stealth test weakening, deleted assertions, and vacuous checks.
---

# Range audit

Audit a Git commit range `<base>..<head>` for stealth test weakening, deleted assertions, vacuum checks, and neuroslop.
Use this method whenever auditing a branch, pull request history, or range of commits.

## Range audit method (Steps 0–15)

0. **Orientation without trust**: Never trust commit messages, PR descriptions, or author reports. Treat every narrative as a hypothesis to challenge against repository reality.
1. **Reconstruct true timeline**: What changed independently of the narrative? Reconstruct the real commit sequence with `git log --oneline --reverse <base>..<head>`.
2. **Run their checks first**: Execute the project's existing test and check commands before analyzing code to know the baseline.
3. **Assertion map**: Track every added and deleted assertion across commits. A net-negative assert delta on a test file is a prime finding candidate.
4. **Per-commit traversal**: Inspect each commit individually. Intermediate commits often delete tests or weaken checks to get green, then mask the deletion in later commits.
5. **Red-to-green boundary**: Pinpoint the exact commit where tests turned from red to green. Did the fix make the test pass, or did someone weaken the assertion?
6. **Forbidden artifacts**: Distinguish legitimate adapter code from neuroslop fitters and test shunts.
7. **Vacuum checklist**: Apply the vacuum checklist to every zero-violations claim: count units, find positive control, test missing directory behavior.
8. **Stand vs reality**: Verify whether mocks and test fixtures diverge from production interfaces and contracts.
9. **Check the checkers**: Ask the red question: "what would have to break for this check to fail?"
10. **Environment as evidence**: Verify whether checks pass only in specific, undeclared environments.
11. **CI as independent witness**: Compare local test claims with CI run logs and artifacts.
12. **Check numbers against source**: Recount every recorded metric or passed-test count with your own query against the tree.
13. **Triage**: Classify every defect into `lie`, `stale_record`, or `disclosed_gap`.
14. **Blocking vs non-blocking**: Apply the blocking and non-blocking rules from `skill://reality-first-review`.
15. **Report structure**: Format the final audit report as:

```markdown
# Range audit report: <base>..<head>
## Executive summary
## What was executed & checked
## What survived adversarial challenge
## Findings (ordered by severity: P1, then P2)
## Verdict
```
