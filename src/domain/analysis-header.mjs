// The identity header every analysis artifact carries: its schema name, the diff it describes and
// the policy that governed it. Two artifacts (maintainability and reuse) are read by the same
// orchestrator, so a change to what identifies them must not require finding every builder.

/**
 * @param {{ schema: string, diffHash: string, policy: string }} input
 * @returns {{ schema: string, diffHash: string, policy: string }}
 */
export function analysisHeader({ schema, diffHash, policy }) {
  return { schema, diffHash, policy };
}
