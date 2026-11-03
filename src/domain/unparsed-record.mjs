// The one shape of a "this source was not analysed" record. Both scans report why a file or the
// adapter produced nothing, and a record that gains a field must gain it in one place: the same
// `{ path, reason }` pair written out at every branch is the data clump the maintainability stage
// flags, and a caller comparing these records depends on every producer agreeing.

/**
 * @param {string} path repository-relative path, or the pseudo-path of an adapter
 * @param {string} reason the documented reason the source was not analysed
 * @returns {{ path: string, reason: string }}
 */
export function unparsedRecord(path, reason) {
  return { path: String(path), reason: String(reason) };
}
