import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('marketplace identifies the public plugin', async () => {
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));
  assert.equal(catalog.name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].source, './');
});
