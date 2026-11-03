// The one way the kit parses JavaScript and TypeScript. Both scans read the same dialects: the
// plugin set of the file's extension first, then one documented second attempt, with the same parser
// options. Two copies of this rule drift the moment one of them learns a new dialect, so there is
// one copy and each scan keeps only what is its own — which units a file contributes.

/** Extensions the JavaScript adapter owns, with the Babel plugins each dialect needs. */
export const JS_EXTENSIONS = new Map([
  ['.mjs', ['jsx', 'decorators-legacy']],
  ['.cjs', ['jsx', 'decorators-legacy']],
  ['.js', ['jsx', 'decorators-legacy']],
  ['.jsx', ['jsx', 'decorators-legacy']],
  ['.ts', ['typescript']],
  ['.mts', ['typescript']],
  ['.cts', ['typescript']],
  ['.tsx', ['typescript', 'jsx']],
]);

/** The second attempt a dialect the first plugin set rejects gets. */
export const SECOND_ATTEMPT = ['typescript', 'jsx', 'decorators-legacy'];

/**
 * Parses one file with the plugins of its extension and, when that set is rejected, with the one
 * documented fallback. A file both attempts reject is `null`, never a silently empty syntax tree.
 *
 * @param {{ relative: string, source: string, plugins: string[], parser: { parse: Function } }} input
 * @returns {object|null} the Babel file, or null when neither dialect parsed it
 */
export function parseJavaScript({ source, plugins, parser }) {
  for (const attempt of [plugins, SECOND_ATTEMPT]) {
    try {
      return parser.parse(source, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: false,
        plugins: attempt,
      });
    } catch {
      continue;
    }
  }
  return null;
}
