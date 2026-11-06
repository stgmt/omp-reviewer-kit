---
description: Run the diagnostic anti-neuroslop audit over a commit range.
agent: review-range-auditor
---

Audit exactly the commit range and any suspicion report supplied in `$ARGUMENTS`. Require a `<base>..<head>` range; if it is absent or ambiguous, report that the range cannot be audited rather than silently selecting one. This is diagnostic only and is not a commit gate. Do not emit `REVIEW_RESULT=...`.