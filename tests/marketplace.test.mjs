import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('marketplace identifies the public plugin', async () => {
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));
  assert.equal(catalog.name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].source, './');
});

test('all three version fields remain synchronized at 0.3.0', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));

  assert.equal(pkg.version, '0.3.0');
  assert.equal(pkg.omp.version, '0.3.0');
  assert.equal(catalog.plugins[0].version, '0.3.0');
  assert.equal(pkg.version, pkg.omp.version);
  assert.equal(pkg.version, catalog.plugins[0].version);
});


test('release workflow builds immutable attested tag bytes', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /actions\/attest-build-provenance@v3/);
  assert.match(workflow, /git archive/);
  assert.match(workflow, /gh attestation verify/);
  assert.match(workflow, /gh release download/);
  assert.doesNotMatch(workflow, /--clobber/);
});
