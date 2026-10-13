export default async function* mutationReporter(source) {
  const ancestry = [];
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:start') {
      ancestry.length = data.nesting;
      ancestry[data.nesting] = data.name;
      continue;
    }
    if (event.type === 'test:summary') {
      yield JSON.stringify({ type: event.type, counts: data.counts, success: data.success }) + '\n';
      continue;
    }
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const error = data.details?.error;
    yield JSON.stringify({ type: event.type, name: data.name, nesting: data.nesting, file: data.file, ancestors: ancestry.slice(0, data.nesting),
      skipped: Boolean(data.skip || data.todo), suite: data.details?.type === 'suite',
      code: error?.code, failureType: error?.failureType, causeCode: error?.cause?.code,
      message: error?.message, durationMs: data.details?.duration_ms }) + '\n';
  }
}
