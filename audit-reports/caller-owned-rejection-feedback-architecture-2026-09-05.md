# Caller-Owned Review Rejection Feedback Architecture

**Status:** Design only. This document defines the v0.3.0 contract; it does not implement the envelope, parser, or caller integration.

## Decision

The review hook remains a fail-closed gate. On a rejected staged change, the reviewer emits a strict machine-readable rejection envelope for the calling agent, writes the complete reviewer transcript to the existing audit report, and prints only a stable two-line report pointer to stderr. The plugin does not repair files, start another agent turn, retry the commit, or mutate Git state.

The contract name is `review-rejection-envelope@1`.

## Existing evidence and ownership

| Evidence | Current behavior | Design consequence |
|---|---|---|
| `src/application/review-workflow-service.mjs:69-94` | Combines reviewer stdout/stderr, derives the verdict, saves `ReviewReport`, then logs `reviewer-kit BLOCK` followed by the full combined output. | Parsing and signal formatting belong in the application workflow after execution and before logging; the report remains the durable source. |
| `src/domain/review-report.mjs:53-67` | Markdown reports store the staged hash, result, model list, and trimmed raw reviewer output. | The complete envelope and reviewer text remain report-only data. |
| `agents/review-finding-verifier.md:25-60` | The verifier returns structured candidate decisions and confirmed findings; it must not emit verdict markers. | The orchestrator owns final envelope assembly and marker ordering. |
| `agents/reviewer-kit.md:33-57` | Stage 3 is blocking; Stage 4 synthesizes locally; every confirmed finding needs priority, path, line range, behavior, trigger, impact, and evidence; the final marker is solitary. | The envelope is assembled only after Stage 3 and Stage 4 complete. No second synthesis agent is introduced. |
| `scripts/run-review.mjs` and `.omp/review-kit/run-review.mjs` | The distributable and self-hosted runners must remain synchronized. | The parser, report text, and stderr contract must be implemented identically in both runner paths. |
| Installed OMP runtime `omp/18.1.6`: `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/exec/bash-executor.ts:343-610` | `executeBash` returns normal completion separately from cancellation/timeout, preserves streamed output through an output sink, and reports the process exit code. | The hook must finish its report and pointer emission in the existing bash call; it must not depend on a new OMP callback or an interactive UI turn. |

The previously referenced installed path `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/tools/bash.ts:624-755` is not present in the installed `omp/18.1.6` tree. The current equivalent execution contract is the `bash-executor.ts` path cited above. This design does not claim byte equality with the older `17.3.7` source layout.

## Envelope grammar

The envelope is valid only when all of these conditions hold:

1. It is between standalone lines `REVIEW_REJECTION_ENVELOPE_BEGIN` and `REVIEW_REJECTION_ENVELOPE_END`.
2. Exactly one begin line and exactly one end line exist.
3. The envelope occurs before exactly one solitary `REVIEW_RESULT=BLOCK` line.
4. The envelope is one JSON object with no duplicate keys and no unknown fields.
5. `schema` is exactly `review-rejection-envelope@1`.
6. `kind` is exactly `confirmed_findings` or `review_failure`.
7. `diff_hash` is exactly 64 lowercase hexadecimal SHA-256 characters and equals the staged diff identity used for the report.
8. `findings` is an array. It is nonempty for `confirmed_findings` and empty for `review_failure`.
9. A `failure` object is present only for `review_failure`.

The parser rejects malformed JSON, duplicate keys, unknown fields, missing fields, extra fields, invalid marker placement, mismatched hashes, contradictory markers, and any envelope that violates the kind-specific schema. Rejection of the envelope itself remains a BLOCK and is represented by a new valid `kind: review_failure` report envelope when that can be written safely.

## Confirmed-finding schema

For `kind: confirmed_findings`, every finding has exactly these fields:

```json
{
  "finding_id": "correctness-1",
  "priority": "P1",
  "defect_class": "correctness",
  "path": "src/example.mjs",
  "line_start": 42,
  "line_end": 45,
  "verifier_argument": "Repository evidence proving the defect is reachable.",
  "counterexample": "Concrete input or execution sequence that triggers it."
}
```

The invariant is strict: `finding_id` is nonempty and unique within the envelope; `priority` is `P1` or `P2`; `defect_class` is `correctness` or `security`; `path` is repository-relative, uses `/`, is nonempty, and contains neither `../` nor an absolute prefix; `line_start` and `line_end` are positive inclusive integers with `line_start <= line_end`; `verifier_argument` and `counterexample` are nonempty strings.

The envelope intentionally carries the verifier's factual argument and trigger counterexample, not a patch or remediation instruction. The audit report retains the richer stage evidence and raw transcript.

## Review-failure schema

For `kind: review_failure`, `findings` is `[]` and `failure` is exactly:

```json
{
  "code": "missing_verdict_marker",
  "message": "No solitary review verdict marker was emitted."
}
```

Allowed `failure.code` values:

- `execution_failure`
- `missing_verdict_marker`
- `multiple_verdict_markers`
- `missing_rejection_envelope`
- `malformed_rejection_envelope`
- `contradictory_rejection_envelope`

`message` is a nonempty diagnostic string suitable for the audit report and caller triage. It is not printed directly to stderr.

## Output and caller boundary

After the report is successfully written, a BLOCK emits only these two stderr lines, in order:

```text
reviewer-kit BLOCK: <absolute-report-path>
REVIEW_REJECTION_REPORT=<absolute-report-path>
```

The complete reviewer output, envelope, parser diagnostic, and stage details remain in the report. The hook continues to exit with code `1`. PASS retains the existing successful marker behavior and emits no rejection envelope and no rejection-report pointer.

No code path in this design may perform any of the following as a response to BLOCK: automatic edits, `git add`, reset, checkout, commit, re-commit, retry counters, provider retry after a real verdict, a fixer agent, another model turn, `pi.sendMessage`, `session_stop`, recursive `omp -p`, or a second review process. The calling agent owns reading the report, fixing the defect, staging its files, and invoking the commit again.

## Proposed implementation seams

1. Add a strict envelope value object/parser beside the existing verdict parsing. It receives the staged `DiffIdentity` and returns either a validated envelope or a typed parse failure.
2. Extend the orchestrator output contract so Stage 4 emits the exact confirmed-finding fields or a typed review-failure result, while preserving the solitary final verdict marker.
3. Update the application workflow to validate the envelope against the staged hash, save the unchanged full transcript in `ReviewReport`, and route only the two-line pointer to the logger.
4. Apply the same behavior to `scripts/run-review.mjs` and `.omp/review-kit/run-review.mjs`; `npm run check` remains the synchronization gate.
5. Add contract tests for PASS/no envelope, confirmed findings, every failure code, malformed JSON, duplicate/unknown fields, path traversal, invalid ranges, hash mismatch, marker ordering, and exactly-two-line BLOCK stderr. Add no auto-remediation behavior tests.

This is a protocol and planning change only. It does not add publication automation, npm distribution, or a replacement review subsystem.
