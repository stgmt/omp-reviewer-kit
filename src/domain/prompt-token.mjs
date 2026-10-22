// Prompt-safe rendering of a path or token: control and invisible characters are escaped so a
// file name cannot inject terminal escapes or spoof path lists in prompts and log lines.
/**
 * Escapes control characters in attacker-controllable text (staged file paths)
 * before it is rendered into instruction lines. Filenames may legally contain
 * newlines and other control bytes; unescaped they could forge prompt lines
 * such as a fake `Review profile for this diff:` directive.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizePromptToken(value) {
  if (typeof value !== 'string') return '';
  // C0 + DEL + full C1 range, NEL/CSI included as named members of it;
  // Unicode line/paragraph separators; bidi marks (embeddings, overrides,
  // isolates); zero-width and word-joiner characters; variation selectors;
  // TAG characters (U+E0000-E007F, supplement U+E0100-E01EF) and deprecated
  // format marks (ALM U+061C, Mongolian FVS U+180E); BOM. Legal filename
  // bytes that can inject terminal escapes or spoof path lists must never
  // reach prompts/log lines raw.
  return value.replace(/[\x00-\x1f\x7f-\x9f\u00ad\u034f\u070f\u061c\u17b4-\u17b5\u180e\u2028\u2029\u202a-\u202e\u200b-\u200f\u2060-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u115f-\u1160\u3164\uffa0\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    switch (cp) {
      case 0x0a: return '\\n';
      case 0x0d: return '\\r';
      case 0x09: return '\\t';
      default: return cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\u{${cp.toString(16)}}`;
    }
  });
}
