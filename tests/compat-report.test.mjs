// Given/When/Then over the assignment lines the version census renders. Pure: no filesystem.
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderCompatLines } from '../src/native/compat/report.mjs';

const analysis = {
  schema: 'compat@1',
  status: 'ok',
  coverage: 'full',
  scan: { files: 5, parsed: 5, sites: 6, unparsedTotal: 0, truncated: false, droppedFamilies: 0, elapsedMs: 12 },
  failures: [],
  families: [{
    family: 'product-manifest',
    versions: [
      { version: 'product-manifest/v5', produced: [{ path: 'reel/manifest.py', line: 17 }], consumed: [], listed: [{ path: 'player/player.js', line: 2, table: 'SUPPORTED_VERSIONS' }] },
      { version: 'product-manifest/v8', produced: [], consumed: [{ path: 'reel/repair.py', line: 9, guard: 'compare', constant: 'SCHEMA_V8' }, { path: 'reel/critic.py', line: 9, guard: 'compare', constant: 'SCHEMA_V8' }], listed: [] },
    ],
  }],
  deadVersions: [{
    family: 'product-manifest',
    version: 'product-manifest/v8',
    consumed: [{ path: 'reel/repair.py', line: 9 }, { path: 'reel/critic.py', line: 9 }],
    listed: [],
    reason: 'never-produced-in-snapshot',
  }],
  unproducedVersions: [],
  deadBranches: [],
  tables: [],
};

test('Given a census with a produced, a read and a dead version, When rendered, Then every fact names its sites', () => {
  const text = renderCompatLines(analysis).join('\n');
  assert.match(text, /^Version census \(deterministic scan of 5 file\(s\), 1 family\(ies\), coverage full; evidence, never a finding\):$/m);
  assert.match(text, /^- product-manifest: produced v5 \(reel\/manifest\.py:17\); consumed v8 \(reel\/repair\.py:9, reel\/critic\.py:9\); listed v5 \(player\/player\.js:2\)\.$/m);
  assert.match(text, /^- DEAD product-manifest v8: consumed at reel\/repair\.py:9, reel\/critic\.py:9; no producer of this version exists in the snapshot\.$/m);
});

test('Given a version that an unchanged module still writes, When rendered, Then the row says where the literal lives', () => {
  const text = renderCompatLines({
    ...analysis,
    deadVersions: [],
    unproducedVersions: [{
      family: 'product-manifest',
      version: 'product-manifest/v8',
      consumed: [{ path: 'src/repair.js', line: 1 }],
      listed: [],
      elsewhere: [{ version: 'product-manifest/v8', path: 'src/legacy.js', line: 1 }],
      reason: 'not-produced-by-this-change',
    }],
  }).join('\n');
  assert.match(text, /^- NOT PRODUCED BY THIS CHANGE product-manifest v8: read at src\/repair\.js:1; the literal also appears at src\/legacy\.js:1, outside the changed files\.$/m);
});

test('Given a partial scan, When rendered, Then the limits line states what was not read', () => {
  const text = renderCompatLines({
    ...analysis,
    coverage: 'partial',
    scan: { ...analysis.scan, unparsedTotal: 2, truncated: true, droppedFamilies: 1 },
  }).join('\n');
  assert.match(text, /^- Limits: 2 unparsed file\(s\), scan truncated, 1 family\(ies\) beyond the cap\.$/m);
});

test('Given a failed scan, When rendered, Then the limits line carries the failure message', () => {
  const text = renderCompatLines({
    ...analysis,
    status: 'failed',
    coverage: 'failed',
    families: [],
    deadVersions: [],
    failures: [{ path: null, reason: 'analysis-failed', message: 'boom' }],
  }).join('\n');
  assert.match(text, /^Version census \(deterministic scan failed\): no evidence was produced\.$/m);
  assert.doesNotMatch(text, /no versioned schema literal was found/, 'a failed scan never claims that nothing exists');
  assert.match(text, /^- Limits: scan failed: boom\.$/m);
});

test('Given no versioned literal, When rendered, Then the heading says so with the scanned file count', () => {
  const text = renderCompatLines({ ...analysis, families: [], deadVersions: [] }).join('\n');
  assert.match(text, /no versioned schema literal was found/);
});

test('Given more rows than the line budget, When rendered, Then the section is bounded and points at the artifact', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    family: `format-${index}`,
    versions: [{ version: `format-${index}/v1`, produced: [{ path: 'src/a.js', line: index + 1 }], consumed: [], listed: [] }],
  }));
  const lines = renderCompatLines({ ...analysis, families: many, deadVersions: [] }, { maxLines: 4 });
  assert.equal(lines.length, 4);
  assert.match(lines[3], /more in \.review[\\/]compat\.json/);
});

test('Given no analysis, When rendered, Then there is no block at all', () => {
  assert.deepEqual(renderCompatLines(null), []);
});
