---
description: Run the shared OMP TaskTool review on the currently staged changes.
agent: review-result
---

Call the loaded kit plugin's `review_kit` tool with `operation: "review"` and report the returned runner output verbatim. Do not substitute a native agent analysis, infer PASS from missing output, or claim native OpenCode text controls commits. The repository's existing commit guard remains authoritative and is not altered or bypassed.