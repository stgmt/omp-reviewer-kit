import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('marketplace identifies the public plugin', async () => {
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));
  assert.equal(catalog.name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].source, './');
});

test('all three version fields remain synchronized at 0.2.0', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));

  assert.equal(pkg.version, '0.2.0');
  assert.equal(pkg.omp.version, '0.2.0');
  assert.equal(catalog.plugins[0].version, '0.2.0');
  assert.equal(pkg.version, pkg.omp.version);
  assert.equal(pkg.version, catalog.plugins[0].version);
});
