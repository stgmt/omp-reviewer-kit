// Given/When/Then over the deterministic contract stage: a producer and its consumer are settled by
// calling them. Every case runs real modules written into a temporary snapshot; nothing is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pairUp, probeArguments } from '../src/native/contract/find.mjs';
import { CONTRACT_FILE, contractPolicy, runContractAnalysis, parseFunctions } from '../src/native/contract/analyze.mjs';
import { evaluateReview } from '../src/native/verdict.mjs';

/** The verdict as the review computes it, with the stage's own answer: the seam under test. */
const evaluateReviewForTest = (summary) => evaluateReview({
  reviewer: { exitCode: 0, aborted: false, yieldStatus: 'success', text: 'REVIEW_RESULT=PASS' },
  stages: [
    { agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { test_harness: 'present' } },
    { agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { lane: 'correctness' } },
    { agent: 'review-maintainability', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { candidates: [] } },
    { agent: 'review-finding-verifier', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { confirmed_findings: [], confirmed_coverage_gaps: [] } },
  ],
  profile: 'full',
  lanes: ['correctness'],
  maintainability: { policy: 'block', status: 'analyzed', coverage: 'full', planned: false },
  planned: [],
  contract: {
    policy: summary.policy,
    status: summary.status,
    rejected: summary.pairs.filter(pair => pair.outcome === 'reader-rejects-written-record'),
    probed: summary.pairs.length,
    note: summary.note,
  },
});

const snapshot = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-'));
  await mkdir(path.join(dir, '.review'), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(path.join(dir, name), source);
  }
  await writeFile(path.join(dir, '.review', 'changed-files.txt'), `${Object.keys(files).join('\n')}\n`);
  return dir;
};

const CONTRADICTION = `
export function writeRecord({ id, service = null }) {
  return { schema: 'ledger@1', id, service };
}

export function readRecord(value) {
  if (value.service === null) throw new Error('ledger: service must be a name');
  return value;
}
`;

const HEALTHY = `
export function writeThing({ id, at = new Date().toISOString() }) {
  return { schema: 'thing@1', id, at };
}

export function readThing(value) {
  if (typeof value.at !== 'string') throw new Error('thing: at must be a string');
  return value;
}
`;

test('Given a writer whose default value its own reader rejects, When the stage runs, Then the pair throws and the report names it', async () => {
  const dir = await snapshot({ 'ledger.mjs': CONTRADICTION });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'contract-violated');
    assert.equal(summary.pairs.length, 1);
    const [pair] = summary.pairs;
    assert.equal(pair.outcome, 'reader-rejects-written-record');
    assert.match(pair.error, /service must be a name/);
    assert.match(pair.record, /"service":null/, 'the report quotes the record the reader refused');
    const written = JSON.parse(await readFile(path.join(dir, CONTRACT_FILE), 'utf8'));
    assert.equal(written.schema, 'contract@1');
    assert.equal(written.status, 'contract-violated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a writer and reader that agree, When the stage runs, Then the pair round-trips and nothing is reported as a violation', async () => {
  const dir = await snapshot({ 'thing.mjs': HEALTHY });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'ok');
    assert.equal(summary.pairs[0].outcome, 'round-trip-ok');
    assert.deepEqual(summary.pairs.filter(pair => pair.outcome === 'reader-rejects-written-record'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a changed module with no consumer, When the stage runs, Then it says nothing was checked instead of claiming agreement', async () => {
  const dir = await snapshot({ 'only.mjs': 'export function writeOnly({ id }) { return { id }; }\n' });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'partial', 'a writer without its reader is skipped work, not a clean scan');
    assert.equal(summary.pairs.length, 0);
    assert.match(summary.unproven.join('\n'), /no reader of the same record family/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a module the parser cannot read, When the stage runs, Then the file is reported unparsed and never counted as clean', async () => {
  const dir = await snapshot({ 'broken.mjs': 'export function writeRecord( {{{ {\n' });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'partial', 'a skipped module is not an empty scan');
    assert.equal(summary.unparsedFiles.length, 1);
    assert.match(summary.unparsedFiles[0], /broken\.mjs/);
    assert.match(summary.note, /not agreement/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a writer that throws before producing a record, When the stage runs, Then the pair is unproven, not a violation', async () => {
  const dir = await snapshot({
    'explodes.mjs': `
export function writeBoom({ id }) { throw new Error('no readers here'); }
export function readBoom(value) { return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'partial');
    assert.equal(summary.pairs[0].outcome, 'writer-failed');
    assert.match(summary.note, /could not be settled; that is not agreement/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the stage is switched off, When the review runs, Then nothing is probed and the policy says so', async () => {
  const dir = await snapshot({ 'ledger.mjs': CONTRADICTION });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'off' });
    assert.equal(summary.status, 'off');
    assert.equal(summary.pairs.length, 0);
    assert.equal(contractPolicy({}), 'advisory', 'a heuristic input never blocks a release by default');
    assert.equal(contractPolicy({ OMP_REVIEW_KIT_CONTRACT: 'ADVISORY' }), 'advisory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a paired writer and reader, When the probe builds arguments, Then only the parameters without a default are filled', () => {
  const functions = parseFunctions(CONTRADICTION, 'ledger.mjs');
  const { pairs } = pairUp({ file: 'ledger.mjs', functions });
  assert.equal(pairs.length, 1);
  assert.deepEqual(probeArguments(pairs[0].writerParams), [{ value: { id: 'probe' } }], 'the service default stays the writer\'s own');
});

test('Given a writer whose parameter is itself a destructured object, When the stage runs, Then the pair is unproven instead of being probed with a scalar', async () => {
  const dir = await snapshot({
    'nested.mjs': `
export function writeRecord({ payload: { service } }) { return { service }; }
export function readRecord(value) { if (typeof value.service !== 'string') throw new Error('service'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'partial', 'skipped work is not agreement');
    assert.equal(summary.pairs.length, 0, 'no false rejection is produced');
    assert.match(summary.unproven.join('\n'), /parameter shape is not something the probe can build/);
    assert.match(summary.note, /not agreement/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given more changed paths than the scan budget, When the stage runs, Then the unread paths are reported as skipped work', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-'));
  try {
    await mkdir(path.join(dir, '.review'), { recursive: true });
    const names = Array.from({ length: 45 }, (_, index) => `file-${index}.mjs`);
    for (const name of names) await writeFile(path.join(dir, name), 'export const value = 1;\n');
    await writeFile(path.join(dir, '.review', 'changed-files.txt'), `${names.join('\n')}\n`);
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'partial');
    assert.match(summary.unproven.join('\n'), /beyond the 40-file scan budget/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given one module with two record families, When the stage runs, Then only same-family pairs are probed', async () => {
  const dir = await snapshot({
    'families.mjs': `
export function writeUser({ id }) { return { kind: 'user', id }; }
export function readUser(value) { if (value.kind !== 'user') throw new Error('not a user'); return value; }
export function writeConfig({ key }) { return { kind: 'config', key }; }
export function readConfig(value) { if (value.kind !== 'config') throw new Error('not a config'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'ok', 'cross-family pairs are not a contract');
    assert.deepEqual(summary.pairs.map(pair => `${pair.writer}->${pair.reader}`).sort(), ['writeConfig->readConfig', 'writeUser->readUser']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a required parameter whose domain the name does not ground, When the stage runs, Then the pair is unproven instead of probed with a guess', async () => {
  const dir = await snapshot({
    'flags.mjs': `
export function writeFlag(whatever) { return { whatever }; }
export function readFlag(value) { if (typeof value.whatever !== 'boolean') throw new Error('bool'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'partial');
    assert.equal(summary.pairs.length, 0, 'no invented value reaches the writer');
    assert.match(summary.unproven.join('\n'), /domain is not known/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a reader that needs context beyond the record, When the stage runs, Then the pair is left unsettled', async () => {
  const dir = await snapshot({
    'context.mjs': `
export function writeRecord({ id }) { return { id }; }
export function readRecord(value, options) { if (!options?.strict) throw new Error('options are required'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'partial');
    assert.equal(summary.pairs.length, 0);
    assert.match(summary.unproven.join('\n'), /declares 2 parameter\(s\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a writer that takes a scalar and a destructured object, When the stage runs, Then the declared argument boundaries are kept', async () => {
  const dir = await snapshot({
    'mixed.mjs': `
export function writeRecord(id, { service }) { return { id, service }; }
export function readRecord(value) { if (typeof value.service !== 'string') throw new Error('service'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'ok', 'a second argument is an object, not a scalar');
    assert.equal(summary.pairs[0].outcome, 'round-trip-ok');
    assert.deepEqual(summary.pairs[0].arguments, [{ value: 'probe' }, { value: { service: 'probe' } }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a TSX module the runtime cannot import, When the stage runs, Then the pair is unsettled and named, never counted as agreement', async () => {
  const dir = await snapshot({
    'box.tsx': 'export function writeBox({ id }) { return { id }; }\nexport function readBox(value) { return value; }\n',
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'partial');
    assert.equal(summary.pairs[0].outcome, 'module-failed');
    assert.match(summary.note, /not agreement/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a writer with a defaulted trailing parameter, When the stage runs, Then the writer applies its own default instead of a guessed value', async () => {
  const dir = await snapshot({
    'stamped.mjs': `
export function writeThing(id, at = new Date().toISOString()) { return { id, at }; }
export function readThing(value) { if (typeof value.at !== 'string') throw new Error('at must be a timestamp'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'ok');
    assert.deepEqual(summary.pairs[0].arguments, [{ value: 'probe' }], 'a defaulted tail is omitted so the writer applies its own default');
    assert.equal(summary.pairs[0].outcome, 'round-trip-ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a defaulted parameter followed by a required one, When the stage runs, Then the required slot is still filled and the default still applies', async () => {
  const dir = await snapshot({
    'positional.mjs': `
export function writeRecord(id = 'default', service) { return { id, service }; }
export function readRecord(value) { if (typeof value.service !== 'string') throw new Error('service must be a name'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'ok', 'the required parameter is not dropped by the defaulted one');
    assert.deepEqual(summary.pairs[0].arguments, [{ absent: true }, { value: 'probe' }]);
    assert.equal(summary.pairs[0].outcome, 'round-trip-ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a parameter name that reads as both a number and a string, When the stage runs, Then no domain is invented', async () => {
  const dir = await snapshot({
    'versioned.mjs': `
export function writeVersion(version) { return { version }; }
export function readVersion(value) { if (typeof value.version !== 'string') throw new Error('version must be a string'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'partial');
    assert.equal(summary.pairs.length, 0);
    assert.match(summary.unproven.join('\n'), /domain is not known/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given more writer/reader families than the probe budget, When the stage runs, Then only the budgeted ones are probed and the rest are named', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-'));
  try {
    await mkdir(path.join(dir, '.review'), { recursive: true });
    const families = Array.from({ length: 41 }, (_, index) => `Pair${index}`);
    const source = families.map((name, index) => `export function write${name}({ id }) { return { kind: ${index}, id }; }\nexport function read${name}(value) { if (value.kind !== ${index}) throw new Error('wrong kind'); return value; }`).join('\n');
    await writeFile(path.join(dir, 'many.mjs'), `${source}\n`);
    await writeFile(path.join(dir, '.review', 'changed-files.txt'), 'many.mjs\n');
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.pairs.length, 40, 'the budget is the budget');
    assert.equal(summary.status, 'partial');
    assert.match(summary.unproven.join('\n'), /beyond the 40 budget were not probed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a module that ends the probe process before it answers, When the stage runs, Then the analysis failed instead of passing quietly', async () => {
  const dir = await snapshot({
    'silent.mjs': `
process.exit(0);
export function writeThing({ id }) { return { id }; }
export function readThing(value) { return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'failed');
    assert.match(summary.note, /could not run/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a serialize/parse pair, When the stage runs, Then the alternate verbs are recognised and the rejection is reported', async () => {
  const dir = await snapshot({
    'ledger.mjs': `
export function serializeLedger({ id, service = null }) { return { id, service }; }
export function parseLedger(value) { if (value.service === null) throw new Error('service must be a name'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'contract-violated');
    assert.equal(summary.pairs[0].writer, 'serializeLedger');
    assert.equal(summary.pairs[0].reader, 'parseLedger');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given numeric and boolean required parameters, When the stage runs, Then the probe supplies 1 and true and the round-trip holds', async () => {
  const dir = await snapshot({
    'typed.mjs': `
export function writePort({ port }) { return { port }; }
export function readPort(value) { if (typeof value.port !== 'number') throw new Error('port must be a number'); return value; }
export function writeFlag({ enabled }) { return { enabled }; }
export function readFlag(value) { if (typeof value.enabled !== 'boolean') throw new Error('enabled must be a boolean'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'ok');
    const byWriter = Object.fromEntries(summary.pairs.map(pair => [pair.writer, pair]));
    assert.deepEqual(byWriter.writePort.arguments, [{ value: { port: 1 } }]);
    assert.deepEqual(byWriter.writeFlag.arguments, [{ value: { enabled: true } }]);
    assert.equal(byWriter.writePort.outcome, 'round-trip-ok');
    assert.equal(byWriter.writeFlag.outcome, 'round-trip-ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a build/read pair, When the stage runs, Then the producer verb does not swallow a letter and the rejection is reported', async () => {
  const dir = await snapshot({
    'built.mjs': `
export function buildRecord({ id, service = null }) { return { id, service }; }
export function readRecord(value) { if (value.service === null) throw new Error('service must be a name'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'contract-violated');
    assert.equal(summary.pairs[0].writer, 'buildRecord');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a staged module that logs to stdout, When the stage runs, Then the answer is still read and the rejection is reported', async () => {
  const dir = await snapshot({
    'noisy.mjs': `
export function writeRecord({ id, service = null }) { console.log('writing a record'); return { id, service }; }
export function readRecord(value) { console.log('reading a record'); if (value.service === null) throw new Error('service must be a name'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'contract-violated');
    assert.equal(summary.pairs[0].outcome, 'reader-rejects-written-record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a changed module over the size limit and a missing path, When the stage runs, Then both are reported as skipped work', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-'));
  try {
    await mkdir(path.join(dir, '.review'), { recursive: true });
    const big = `export function writeBig({ id }) { return { id }; }\n// ${'x'.repeat(600 * 1024)}\n`;
    await writeFile(path.join(dir, 'big.mjs'), big);
    await writeFile(path.join(dir, '.review', 'changed-files.txt'), 'big.mjs\ngone.mjs\n');
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'partial');
    assert.match(summary.unproven.join('\n'), /larger than 524288 bytes/);
    assert.match(summary.unproven.join('\n'), /gone\.mjs: unreadable in the snapshot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a changed .js module with a broken pair, When the stage runs, Then the suffix is analysed like any other', async () => {
  const dir = await snapshot({
    'legacy.js': `
export function writeRecord({ id, service = null }) { return { id, service }; }
export function readRecord(value) { if (value.service === null) throw new Error('service must be a name'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'contract-violated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a staged module that blocks during import, When the probe times out, Then the analysis failed instead of hanging', async () => {
  const dir = await snapshot({
    'hang.mjs': `
const until = Date.now() + 60_000;
while (Date.now() < until) { /* a module that never yields */ }
export function writeThing({ id }) { return { id }; }
export function readThing(value) { return value; }
`,
  });
  try {
    const started = Date.now();
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block', OMP_REVIEW_KIT_CONTRACT_TIMEOUT_MS: '400' });
    assert.equal(summary.status, 'failed');
    assert.ok(Date.now() - started < 20_000, 'the probe was cut off, not waited on');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given every recognised verb pair in one module, When the stage runs, Then each pair is discovered and its rejection reported', async () => {
  const dir = await snapshot({
    'aliases.mjs': `
export function encodeFrame({ id, mark = null }) { return { id, mark }; }
export function decodeFrame(value) { if (value.mark === null) throw new Error('mark'); return value; }
export function toJSON({ id, mark = null }) { return { id, mark }; }
export function fromJSON(value) { if (value.mark === null) throw new Error('mark'); return value; }
export function toJsonEntry({ id, mark = null }) { return { id, mark }; }
export function fromJsonEntry(value) { if (value.mark === null) throw new Error('mark'); return value; }
export function makeRecord({ id, mark = null }) { return { id, mark }; }
export function readRecord(value) { if (value.mark === null) throw new Error('mark'); return value; }
export function writeItem({ id, mark = null }) { return { id, mark }; }
export function validateItem(value) { if (value.mark === null) throw new Error('mark'); return value; }
export function writeConfig({ id, mark = null }) { return { id, mark }; }
export function restoreConfig(value) { if (value.mark === null) throw new Error('mark'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    const pairs = summary.pairs.map(pair => `${pair.writer}->${pair.reader}`).sort();
    assert.deepEqual(pairs, [
      'encodeFrame->decodeFrame',
      'makeRecord->readRecord',
      'toJSON->fromJSON',
      'toJsonEntry->fromJsonEntry',
      'writeConfig->restoreConfig',
      'writeItem->validateItem',
    ]);
    assert.equal(summary.status, 'contract-violated');
    assert.equal(summary.pairs.filter(pair => pair.outcome === 'reader-rejects-written-record').length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a reader that is not exported, When the stage runs, Then the pair stays unsettled instead of being rejected', async () => {
  const dir = await snapshot({
    'hidden.mjs': `
export function writeRecord({ id, mark = null }) { return { id, mark }; }
function readRecord(value) { if (value.mark === null) throw new Error('mark'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.notEqual(summary.status, 'contract-violated', 'an unexported reader is not a consumer the probe can call');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a named writer and a named default-exported reader, When the stage runs, Then the reader is invoked through the default binding', async () => {
  const dir = await snapshot({
    'defaults.mjs': `
export function writeRecord({ id, service = null }) { return { id, service }; }
export default function readRecord(value) { if (value.service === null) throw new Error('service must be a name'); return value; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'contract-violated');
    assert.equal(summary.pairs[0].outcome, 'reader-rejects-written-record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given writer and reader exported as arrow-valued variables, When the stage runs, Then both are found and the rejection is reported', async () => {
  const dir = await snapshot({
    'arrows.mjs': `
export const writeRecord = ({ id, service = null }) => ({ id, service });
export const readRecord = value => { if (value.service === null) throw new Error('service must be a name'); return value; };
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'contract-violated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given an unknown non-empty policy value, When the stage runs, Then it stays advisory instead of turning a heuristic into a block', async () => {
  assert.equal(contractPolicy({ OMP_REVIEW_KIT_CONTRACT: 'BLOCK!' }), 'advisory');
  const dir = await snapshot({ 'ledger.mjs': CONTRADICTION });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'blockish' });
    assert.equal(summary.policy, 'advisory');
    assert.equal(summary.status, 'contract-violated');
    const verdict = evaluateReviewForTest(summary);
    assert.equal(verdict.pass, true, 'an unknown value never blocks a commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a reader whose record sits after a defaulted parameter, When the stage runs, Then the pair is unsettled instead of misbound', async () => {
  const dir = await snapshot({
    'shifted.mjs': `
export function writeRecord({ id, service = null }) { return { id, service }; }
export function readRecord(options = {}, record) { if (!record || record.service === null) throw new Error('record'); return record; }
`,
  });
  try {
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' });
    assert.equal(summary.status, 'partial');
    assert.equal(summary.pairs.length, 0, 'the record is never placed in the options slot');
    assert.match(summary.unproven.join('\n'), /cannot be placed in the only slot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the changed-file manifest is missing, When the caller supplies its own paths, Then the stage still analyses them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-'));
  try {
    await mkdir(path.join(dir, '.review'), { recursive: true });
    await writeFile(path.join(dir, 'ledger.mjs'), CONTRADICTION);
    const summary = await runContractAnalysis(dir, { OMP_REVIEW_KIT_CONTRACT: 'block' }, { changedPaths: ['ledger.mjs'] });
    assert.equal(summary.status, 'contract-violated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given the changed-file manifest is missing and no paths are supplied, When the stage runs, Then it fails instead of reporting an empty scan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-kit-contract-'));
  try {
    const summary = await runContractAnalysis(dir);
    assert.equal(summary.status, 'failed');
    assert.match(summary.note, /manifest is unreadable/);
    assert.notEqual(summary.status, 'no-pairs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
