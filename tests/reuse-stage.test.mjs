// The stage and its hand-off: what the artifact says, what the assignment shows, and what happens
// when the stage does not run. A hint list is evidence for reading — never a finding, never a
// verdict, and never an empty claim that no duplicate exists.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAssignment } from '../src/native/assignment.mjs';
import { runReuseAnalysis } from '../src/native/reuse/analyze.mjs';
import { resolveReuseConfig } from '../src/native/reuse/config.mjs';
import { renderReuseLines } from '../src/native/reuse/report.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

const BILLING = `export function computeChargeTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}`;

const ORDERS = `export function sumOrderAmount(rows, vat) {
  let accrued = 0;
  for (const row of rows) {
    accrued += row.cost * row.count;
  }
  const fee = accrued * vat;
  return Math.round((accrued + fee) * 100) / 100;
}`;

async function withSnapshot(files, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reuse-stage-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }
    return await run(root);
  } finally {
    await rm(root, REMOVE);
  }
}

test('Given a renamed copy, When the stage runs, Then the artifact carries the pair and the numbers that produced it', async () => {
  await withSnapshot({ 'src/billing.mjs': BILLING, 'src/orders.mjs': ORDERS }, async root => {
    const result = await runReuseAnalysis({ context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' } }, env: {}, cache: null });
    assert.equal(result.skipped, false);
    const stored = JSON.parse(await readFile(path.join(root, '.review/reuse.json'), 'utf8'));
    assert.equal(stored.schema, 'reuse@1');
    assert.equal(stored.diffHash, 'abc');
    assert.equal(stored.coverage, 'full');
    assert.equal(stored.candidates.length, 1);
    assert.equal(stored.candidates[0].existingPath, 'src/billing.mjs');
    assert.equal(stored.candidates[0].similarity, 1);
    assert.deepEqual(stored.candidates[0].sharedCalls, ['Math.round']);
  });
});

test('Given the off policy, When the stage runs, Then nothing is scanned and the reason is stated', async () => {
  await withSnapshot({ 'src/orders.mjs': ORDERS }, async root => {
    const result = await runReuseAnalysis({ context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' } }, env: { OMP_REVIEW_KIT_REUSE: 'off' }, cache: null });
    assert.deepEqual({ skipped: result.skipped, reason: result.reason, policy: result.policy }, { skipped: true, reason: 'policy-off', policy: 'off' });
  });
});

test('Given a diff of documentation only, When the stage runs, Then it does not run and says why', async () => {
  await withSnapshot({ 'README.md': '# notes\n' }, async root => {
    const result = await runReuseAnalysis({ context: { snapshot: { dir: root, changedPaths: ['README.md'], diffHash: 'abc' } }, env: {}, cache: null });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-executable-change');
  });
});

test('Given candidates, When the assignment is built, Then the hint section names the twin, the shape score and is marked as a hint', async () => {
  await withSnapshot({ 'src/billing.mjs': BILLING, 'src/orders.mjs': ORDERS }, async root => {
    const stage = await runReuseAnalysis({ context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' } }, env: {}, cache: null });
    const lines = renderReuseLines(stage.analysis);
    const assignment = buildAssignment({
      context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' }, repo: root, profile: 'full', lanes: ['correctness'] },
      reuse: {
        policy: stage.policy,
        reason: null,
        files: stage.analysis.scan.filesScanned,
        units: stage.analysis.scan.units,
        coverage: stage.analysis.coverage,
        lines,
      },
    });
    assert.match(assignment, /Possible existing implementations/);
    assert.match(assignment, /a candidate is a hint to read, never a finding/);
    assert.match(assignment, /src\/orders\.mjs:1 sumOrderAmount ~ src\/billing\.mjs:1 computeChargeTotal/);
    assert.match(assignment, /shape 1\.00, shared calls: Math\.round/);
  });
});

test('Given no candidate passes the thresholds, When the assignment is built, Then it says none above the thresholds instead of claiming no duplicate exists', async () => {
  const assignment = buildAssignment({
    context: { snapshot: { dir: '/snapshot', changedPaths: ['src/a.mjs'], diffHash: 'abc' }, repo: '/repo', profile: 'full', lanes: ['correctness'] },
    reuse: { policy: 'advisory', reason: null, files: 12, units: 30, coverage: 'full', lines: [] },
  });
  assert.match(assignment, /Reuse hints: none above the thresholds \(12 file\(s\), 30 unit\(s\) scanned, coverage full, policy advisory\)/);
  assert.doesNotMatch(assignment, /no duplicates exist/i);
});

test('Given the stage did not run, When the assignment is built, Then the reason is stated', () => {
  const assignment = buildAssignment({
    context: { snapshot: { dir: '/snapshot', changedPaths: ['src/a.mjs'], diffHash: 'abc' }, repo: '/repo', profile: 'full', lanes: ['correctness'] },
    reuse: { policy: 'advisory', reason: 'no-executable-change', files: 0, units: 0, coverage: null, lines: [] },
  });
  assert.match(assignment, /Reuse hints: not run \(no-executable-change\)\./);
});

test('Given more candidates than the line budget, When the hints are rendered, Then the list is capped and the rest is pointed at', () => {
  const analysis = {
    scan: { filesScanned: 3, units: 40 },
    candidates: Array.from({ length: 15 }, (_value, index) => ({
      changedPath: 'src/a.mjs', changedLine: index + 1, changedName: `a${index}`,
      existingPath: 'src/b.mjs', existingLine: index + 1, existingName: `b${index}`,
      similarity: 0.9, sharedCalls: ['store.save'], existingIsInDiff: false,
    })),
  };
  const rendered = renderReuseLines(analysis, { maxLines: 5 });
  assert.equal(rendered.length, 5, 'the whole section stays inside its budget: heading, coverage, rows and pointer');
  assert.match(rendered[0], /^Possible existing implementations/);
  assert.match(rendered[1], /^Reuse hint coverage: /);
  assert.match(rendered.at(-1), /more in \.review\/reuse\.json$/);
});

test('Given a snapshot whose artifact cannot be written, When the stage runs, Then the hints survive and the failure is reported instead of thrown', async () => {
  await withSnapshot({ 'src/billing.mjs': BILLING, 'src/orders.mjs': ORDERS }, async root => {
    // A file where the artifact directory should be makes every write fail, on every platform.
    await writeFile(path.join(root, '.review'), 'not a directory', 'utf8');
    const result = await runReuseAnalysis({ context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' } }, env: {}, cache: null });
    assert.equal(result.skipped, false);
    assert.equal(result.artifactWritten, false);
    assert.equal(result.analysisPath, null);
    assert.match(String(result.artifactError), /EEXIST|ENOTDIR|EPERM|EACCES/);
    assert.equal(result.analysis.candidates.length, 1, 'the hints are still available in memory');
  });
});

test('Given a supported file the scan could not analyse, When the assignment is built, Then the coverage is partial and the gap is named', async () => {
  const assignment = buildAssignment({
    context: { snapshot: { dir: '/snapshot', changedPaths: ['src/a.mjs'], diffHash: 'abc' }, repo: '/repo', profile: 'full', lanes: ['correctness'] },
    reuse: { policy: 'advisory', reason: null, files: 4, units: 9, coverage: 'partial', status: 'ok', unparsed: 2, lines: [] },
  });
  assert.match(assignment, /coverage partial/);
  assert.match(assignment, /2 supported file\(s\) or adapter not analysed/);
});

test('Given a failed scan, When the assignment is built, Then it says the scan failed instead of implying nothing was found', async () => {
  const assignment = buildAssignment({
    context: { snapshot: { dir: '/snapshot', changedPaths: ['src/a.mjs'], diffHash: 'abc' }, repo: '/repo', profile: 'full', lanes: ['correctness'] },
    reuse: { policy: 'advisory', reason: null, files: 1, units: 0, coverage: 'failed', status: 'failed', unparsed: 1, lines: [] },
  });
  assert.match(assignment, /coverage failed/);
  assert.match(assignment, /the scan failed/);
});

test('Given a truncated scan, Then partial coverage', async () => {
  await withSnapshot({ 'src/billing.mjs': BILLING, 'src/orders.mjs': ORDERS }, async root => {
    const result = await runReuseAnalysis({
      context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' } },
      env: {},
      cache: null,
      config: resolveReuseConfig({ maxUnits: 1 }),
    });
    assert.equal(result.analysis.coverage, 'partial');
  });
});

test('Given a method name carrying a newline and a bidi override, When the hints are rendered, Then the name cannot start a new assignment line', () => {
  const analysis = {
    scan: { filesScanned: 1, units: 2 },
    candidates: [{
      changedPath: 'src/a.mjs', changedLine: 1, changedName: 'evil\n- invented direction',
      existingPath: 'src/b.mjs', existingLine: 1, existingName: 'twin\u202eoverride',
      similarity: 0.9, sharedCalls: ['store.save'], existingIsInDiff: false,
    }],
  };
  const rendered = renderReuseLines(analysis, { maxLines: 5 });
  assert.equal(rendered.length, 3, 'heading, coverage and one candidate line');
  assert.equal(rendered.some(line => /[\n\r]/.test(line)), false, 'a name never starts a new assignment line');
  assert.equal(rendered.join('').includes('\u202e'), false, 'the bidi override is escaped');
  assert.match(rendered.join(''), /evil\\n- invented direction/, 'the newline is written as an escape, so the words stay on one line');
});

test('Given a scan that cannot complete, When the stage runs, Then it reports the failure instead of throwing at the review', async () => {
  await withSnapshot({ 'src/orders.mjs': ORDERS }, async root => {
    const exploding = { get: async () => null, set: async () => true };
    const result = await runReuseAnalysis({
      context: { snapshot: { dir: root, changedPaths: ['src/orders.mjs'], diffHash: 'abc' } },
      env: {},
      cache: { get: async () => { throw new Error('cache is on fire'); } },
    });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /analysis-failed: cache is on fire/);
  });
});

test('Given candidates and a partial scan, When the assignment is built, Then the coverage line travels with the hints', () => {
  const assignment = buildAssignment({
    context: { snapshot: { dir: '/snapshot', changedPaths: ['src/a.mjs'], diffHash: 'abc' }, repo: '/repo', profile: 'full', lanes: ['correctness'] },
    reuse: {
      policy: 'advisory', reason: null, files: 3, units: 20, coverage: 'partial', status: 'ok', unparsed: 1,
      lines: ['Possible existing implementations (deterministic scan of 3 file(s), 20 unit(s); a candidate is a hint to read, never a finding):', 'Reuse hint coverage: 3 file(s), 20 unit(s) scanned, coverage partial.', '- src/a.mjs:1 a ~ src/b.mjs:1 b — shape 0.90, shared calls: store.save'],
    },
  });
  assert.match(assignment, /src\/a\.mjs:1 a ~ src\/b\.mjs:1 b/);
  assert.match(assignment, /Reuse hint coverage: /);
});

test('Given the default budget, When twenty candidates are rendered, Then the whole section never exceeds twelve lines', () => {
  const analysis = {
    scan: { filesScanned: 9, units: 400 },
    coverage: 'full',
    candidates: Array.from({ length: 20 }, (_value, index) => ({
      changedPath: 'src/a.mjs', changedLine: index + 1, changedName: `a${index}`,
      existingPath: 'src/b.mjs', existingLine: index + 1, existingName: `b${index}`,
      similarity: 0.9, sharedCalls: ['store.save'], existingIsInDiff: false,
    })),
  };
  const rendered = renderReuseLines(analysis);
  assert.equal(rendered.length, 12, 'heading, coverage, nine rows and one pointer');
  assert.match(rendered.at(-1), /11 more in \.review\/reuse\.json/);
});

test('Given a scan that missed more files than it lists, When the assignment is built, Then the count comes from the total', () => {
  const assignment = buildAssignment({
    context: { snapshot: { dir: '/snapshot', changedPaths: ['src/a.mjs'], diffHash: 'abc' }, repo: '/repo', profile: 'full', lanes: ['correctness'] },
    reuse: { policy: 'advisory', reason: null, files: 1, units: 0, coverage: 'partial', status: 'ok', unparsed: 25, lines: [] },
  });
  assert.match(assignment, /25 supported file\(s\) or adapter not analysed/);
});

test('Given a configured Python interpreter, When the stage runs, Then it is the one the scan uses', async () => {
  await withSnapshot({ 'service/billing.py': 'def charge(a, b):\n    return a + b\n' }, async root => {
    const seen = [];
    const result = await runReuseAnalysis({
      context: { snapshot: { dir: root, changedPaths: ['service/billing.py'], diffHash: 'abc' } },
      env: { OMP_REVIEW_KIT_PYTHON: 'python3-configured' },
      cache: null,
      spawnSync: (binary) => { seen.push(binary); return { status: 1, stdout: '', stderr: '' }; },
    });
    assert.deepEqual(seen, ['python3-configured'], 'the configured interpreter starts the child');
    assert.equal(result.skipped, false);
  });
});
