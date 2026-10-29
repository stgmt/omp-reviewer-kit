// Read-only fallback evidence from OMP's own reviewer session log. The log records the chain OMP
// installed for the reviewer task and the provider errors that ended a turn; nothing here is
// derived from the owner's configuration, and nothing here changes the verdict. The purpose is the
// one question a failed review cannot answer by itself: did OMP move the reviewer off its requested
// model, and if not, what ended the task.

import { readFile } from 'node:fs/promises';

/**
 * @typedef {{ chainLength: number|null, errors: string[] }} FallbackEvidence
 */

/**
 * Reads the reviewer session log. A log that cannot be read is unknown evidence, never a claim that
 * no fallback existed.
 *
 * @param {string|null|undefined} file
 * @returns {Promise<FallbackEvidence|null>}
 */
export async function readFallbackEvidence(file) {
  if (!file) return null;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return parseFallbackEvidence(text);
}

/**
 * Extracts the installed fallback chain and the provider errors from OMP's JSONL event log. A line
 * that is not JSON (a truncated tail) is skipped; the rest of the log still answers the question.
 *
 * @param {string} text
 * @returns {FallbackEvidence}
 */
export function parseFallbackEvidence(text) {
  let chainLength = null;
  const errors = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const chain = record?.retryFallback?.chain;
    if (chainLength === null && record?.type === 'session_init' && Array.isArray(chain)) {
      chainLength = chain.length;
    }
    const message = record?.type === 'message' ? record.message : undefined;
    if (message?.role === 'assistant' && message.stopReason === 'error') {
      const error = summarizeProviderError(message.errorMessage);
      if (error && !errors.includes(error)) errors.push(error);
    }
  }
  return { chainLength, errors };
}

/**
 * One bounded line: the status and the provider's own message, collapsed to a single line so it
 * fits a report header. The request id and the rest of the body are dropped by the cut.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function summarizeProviderError(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
