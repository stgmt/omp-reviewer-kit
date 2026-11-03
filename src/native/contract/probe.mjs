// One child process that loads the module the pair lives in and walks the producer/consumer contract:
// build a record with the writer's own defaults (the probe supplies only the parameters that have no
// default), hand it to the reader, and report what happened. A thrown error is the observation; the
// absence of one means the pair agrees on the record the writer actually produces.
//
// Nothing here is inferred from source text: the call happens, in a real process, on the staged copy,
// with the arguments the parent grounded from the signature. The child never invents a value.
// Input is one JSON document on stdin, the answer one JSON document on stdout. The probe can crash —
// a crashing module is reported as such, never as agreement.

import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const describeError = (error) => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
};

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const results = [];
  for (const pair of request.pairs ?? []) {
    const modulePath = isAbsolute(pair.file) ? pair.file : resolve(request.root, pair.file);
    let module;
    try {
      module = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      results.push({ ...pair, outcome: 'module-failed', error: describeError(error) });
      continue;
    }
    const writer = module[pair.writerExport ?? pair.writer];
    const reader = module[pair.readerExport ?? pair.reader];
    if (typeof writer !== 'function' || typeof reader !== 'function') {
      results.push({ ...pair, outcome: 'not-exported', error: `${pair.writer}/${pair.reader} are not both exported functions` });
      continue;
    }
    let record;
    try {
      if (!Array.isArray(pair.arguments)) {
        results.push({ ...pair, outcome: 'not-probed', error: 'the parent sent no arguments for this pair' });
        continue;
      }
      // A slot the parent marked absent becomes `undefined`, so the writer's own default applies.
      record = await writer(...pair.arguments.map(slot => (slot && slot.absent === true ? undefined : slot?.value)));
    } catch (error) {
      results.push({ ...pair, outcome: 'writer-failed', error: describeError(error) });
      continue;
    }
    try {
      await reader(record);
      results.push({ ...pair, outcome: 'round-trip-ok', record: summarize(record) });
    } catch (error) {
      results.push({ ...pair, outcome: 'reader-rejects-written-record', error: describeError(error), record: summarize(record) });
    }
  }
  // The answer goes to the file the parent named, never to stdout: a staged module is free to log,
  // and those lines would otherwise be indistinguishable from the probe's own answer.
  const answer = JSON.stringify({ results });
  if (request.answerFile) writeFileSync(request.answerFile, answer, 'utf8');
  else process.stdout.write(`${answer}\n`);
}

/** The record as JSON, bounded: the report quotes what the reader was handed, not a whole object. */
function summarize(record) {
  try {
    const text = JSON.stringify(record);
    return text === undefined ? String(record) : text.slice(0, 400);
  } catch {
    return '[unserializable]';
  }
}

main().catch((error) => {
  const answer = JSON.stringify({ failed: String(error) });
  try {
    if (process.env.OMP_CONTRACT_ANSWER_FILE) writeFileSync(process.env.OMP_CONTRACT_ANSWER_FILE, answer, 'utf8');
    else process.stdout.write(`${answer}\n`);
  } catch {
    process.exitCode = 1;
  }
  process.exitCode = 1;
});
