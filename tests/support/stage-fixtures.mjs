// One definition of a completed native stage result and of a passing reviewer yield, shared by the
// suite. These are the shapes `evaluateReview` reads; a change to one of them must reach every test
// that builds a review, and a single owner is what makes that mechanical instead of six-file work.

/**
 * @param {string} agent
 * @param {object} data
 * @param {{ role?: string|null, model?: string|null, durationMs?: number, tokens?: number, requests?: number }} [extra]
 * @returns {object}
 */
export function completed(agent, data, extra = {}) {
  return {
    agent,
    exitCode: 0,
    aborted: false,
    structuredStatus: 'valid',
    data,
    ...extra,
  };
}

/**
 * @param {string} [text]
 * @returns {{ exitCode: number, aborted: boolean, yieldStatus: string, text: string }}
 */
export function reviewerPass(text = '## Review\n\nREVIEW_RESULT=PASS') {
  return { exitCode: 0, aborted: false, yieldStatus: 'success', text };
}
