// One shape for "these lines of this file": the span every scan reports and every caller slices by.
// Two producers (the maintainability extractor and the reuse scanner) and their consumers agree on
// the field names, so a span is described in one place instead of at each construction site.

/**
 * @param {number} lineStart first line of the span, 1-based
 * @param {number} lineEnd last line of the span, 1-based
 * @returns {{ lineStart: number, lineEnd: number }}
 */
export function sourceSpan(lineStart, lineEnd) {
  const start = Number.isFinite(lineStart) ? lineStart : 1;
  return { lineStart: start, lineEnd: Number.isFinite(lineEnd) ? lineEnd : start };
}
