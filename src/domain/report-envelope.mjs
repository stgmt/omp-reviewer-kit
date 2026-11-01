// The boundary between OMP's yield tool and the review verdict: one payload in, one Markdown report
// out, or a refusal that names the keys that actually arrived. Exactly two shapes are accepted — the
// report string itself and one object wrapping it — so an unusable payload is reported, never guessed.

/** The reasons a payload can be refused, as stable tokens a log line or a record can carry. */
export const ENVELOPE_REASONS = Object.freeze({
  empty: 'empty-payload',
  unsupported: 'unsupported-shape',
  nested: 'nested-payload',
  ambiguous: 'ambiguous-payload',
});

/** Dotted path of a nested object, e.g. `data.data`, so a refusal points at the actual place. */
function nestedPath(key, value) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  return keys.length > 0 ? `${key}.${keys.join('|')}` : key;
}

/**
 * Reads the reviewer's yield payload.
 *
 * Accepted: a non-blank string, or a plain object with exactly one own key whose value is a
 * non-blank string (the single wrapper OMP produced in the 12:18 run). Everything else is refused:
 * a deeper wrapper is `nested-payload`, several string fields are `ambiguous-payload`, and a
 * payload with no string at all is `unsupported-shape`. `observed` names the keys that were found.
 *
 * @param {unknown} payload
 * @returns {{ ok: boolean, markdown: string|null, reason: string|null, observed: string[] }}
 */
export function readReportEnvelope(payload) {
  if (typeof payload === 'string') {
    return payload.trim() === ''
      ? { ok: false, markdown: null, reason: ENVELOPE_REASONS.empty, observed: [] }
      : { ok: true, markdown: payload, reason: null, observed: [] };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, markdown: null, reason: ENVELOPE_REASONS.unsupported, observed: [] };
  }
  const keys = Object.keys(payload);
  const strings = keys.filter(key => typeof payload[key] === 'string' && payload[key].trim() !== '');
  if (strings.length === 1 && keys.length === 1) {
    return { ok: true, markdown: payload[strings[0]], reason: null, observed: strings };
  }
  if (strings.length > 1) {
    return { ok: false, markdown: null, reason: ENVELOPE_REASONS.ambiguous, observed: strings };
  }
  const nested = keys.filter(key => payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key]));
  if (nested.length > 0) {
    return { ok: false, markdown: null, reason: ENVELOPE_REASONS.nested, observed: nested.map(key => nestedPath(key, payload[key])) };
  }
  return { ok: false, markdown: null, reason: ENVELOPE_REASONS.unsupported, observed: keys };
}
