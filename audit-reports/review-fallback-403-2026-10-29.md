# Review blocked by a 403 from the requested model, with the task fallback chain never consulted

Date: 2026-10-29. Owner-reported incident: the pre-commit review blocked on
`403 permission_error: OAuth authentication is currently not allowed for this organization`
from `anthropic/claude-haiku-5-5`, while `retry.fallbackChains.task` named five other models.

## Symptom

Three runs in a row (2026-10-27 20:32, 2026-10-28 00:16, 2026-10-28 10:56) ended the same way:

- `session_init` in `Review.jsonl` carried `modelRole: "task"`,
  `resolvedModel: "anthropic/claude-haiku-5-5:medium"` and
  `retryFallback.chain` equal to the configured `task` chain — the chain was installed correctly;
- one assistant message with `stopReason: "error"` and the 403;
- no `model_change` with `resolvedModelIsFallback: true`, no `retry_fallback_applied`;
- the report `~/Documents/omp-reviewer-kit/…/*.md` said
  `reviewer task exit 1`, `reviewer yield missing`, no stage evidence.

## Root cause (OMP 18.12.5, not the kit)

1. `resolveRetryFallbackChainKey` walks model-selector keys before roles
   (`src/session/retry-fallback-chains.ts:450-469`; the role hint is only read at `:490-496`).
   The owner configuration contained `retry.fallbackChains["anthropic/claude-haiku-5-5"]`,
   so the failing selector resolved to that key, not to the reviewer's `subagent:Review`.
2. `retryFallbackChainKeys` returns a single key on the first failure
   (`src/session/turn-recovery.ts:1885-1894`), so the `task` chain was not consulted as a second key.
3. That model-key chain held one entry, `anthropic/claude-haiku-5-5:high`. The cooldown is recorded
   before the walk (`:2818`, walk at `:2820`) and suppression normalizes away the effort suffix
   (`src/config/custom-models.ts:163-180`), so the only candidate was suppressed by the cooldown
   taken for the failing `:medium` selector.
4. `AccountPolicy` without a credential or model switch returns `false` immediately
   (`:2857-2873`): the turn ends instead of retrying the same model.

`AIError.classifyMessage` returns `AccountPolicy|AuthFailed`, `retriable=false` for this error;
`isRetryableError` still admits it at `:1544` because account-scoped denials may succeed on another
credential.

The settings description states the behavior the run hit:
`retry.fallbackChains` — "Model-oriented keys apply whenever that model/provider is active,
regardless of role" (`src/session/settings.ts:841-842`).

## What the kit does

`src/native/task-engine.mjs:12,93` passes `agent: 'reviewer-kit'` with the structural overlay
`{ 'task.structured': true }`; `agents/reviewer-kit.md:5` declares `model: "@task"`. The kit selects
no model and passes no chain (NR-01, NR-02). OMP resolved the `task` role and installed the `task`
chain under `subagent:Review`; the miss is in the resolver's key precedence, which NR-04 says must be
fixed in OMP rather than compensated by the kit.

## Resolution and live proof

The model-key chain was removed from `~/.omp/agent/config.yml` (backup kept next to the file). With
the key gone, resolution returns `subagent:Review` and five candidates.

Live run on 2026-10-29 through `node scripts/run-review.mjs` on a scratch repository:

| task | requested | resolved | fallback |
|---|---|---|---|
| reviewer-kit | `anthropic/claude-haiku-5-5:medium` | `openai-codex/gpt-6-luna:xhigh` | `resolvedModelIsFallback: true` |
| review-context-scout | same | same | same |
| review-risk-hunter | same | same | same |
| review-finding-verifier | same | same | same |

The reviewer transcript records the 403 at `22:21:42.129Z` and
`model_change … role="fallback" … resolvedModelIsFallback=true` at `22:21:42.108Z`; each specialist
transcript records its own transition. All four tasks completed with `exit 0`, the verdict was
`PASS`, and the report printed `Reviewer role/model (OMP resolved): task / openai-codex/gpt-6-luna:xhigh`.

## Residual risks

- Every review still starts on the dead primary and pays one failed request per task.
- `retry.fallbackRevertPolicy` defaults to `cooldown-expiry`, so a session that outlives the
  five-minute cooldown may return to the primary, fail again and fall back again.
- Re-adding a model-selector chain for the model assigned to `modelRoles.task` reintroduces the
  same shadowing; role chains must not be accompanied by model keys for that model.

## Related change

0.23.1 makes this diagnosis visible in the report without reading transcripts:
`Reviewer fallback`, `Reviewer fallback candidates` and `Reviewer provider error`
(`src/native/fallback-evidence.mjs`), plus `review: reviewer fallback=… candidates=…` on stderr.

## Release note

The 0.23.1 commit was made with `--no-verify` at the owner's request, so the pre-commit review did
not gate it. The new report lines are covered by the offline host and evidence tests; a live review
that prints them has not been run, and the live fallback proof above predates the feature.
