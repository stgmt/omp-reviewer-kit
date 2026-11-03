import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('marketplace identifies the public plugin', async () => {
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));
  assert.equal(catalog.name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].name, 'omp-reviewer-kit');
  assert.equal(catalog.plugins[0].source, './');
});

test('every version source agrees with package.json, the only place a release number is written by hand', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const catalog = JSON.parse(await readFile('.omp-plugin/marketplace.json', 'utf8'));
  const claudeCatalog = JSON.parse(await readFile('.claude-plugin/marketplace.json', 'utf8'));
  const claudeManifest = JSON.parse(await readFile('claude-plugin/.claude-plugin/plugin.json', 'utf8'));
  const runner = await readFile('scripts/run-review.mjs', 'utf8');

  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.omp.version, pkg.version);
  assert.equal(catalog.plugins[0].version, pkg.version);
  assert.equal(claudeCatalog.plugins[0].version, pkg.version);
  assert.equal(claudeManifest.version, pkg.version);
  assert.equal(/^\/\/ omp-reviewer-kit runner v(\d+\.\d+\.\d+)/.exec(runner)?.[1], pkg.version, 'the runner marker names the release it belongs to');
});


test('release workflow builds immutable attested tag bytes', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /actions\/attest-build-provenance@v3/);
  assert.match(workflow, /git archive/);
  assert.match(workflow, /gh attestation verify/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /RELEASE-IDENTITY\.json/);
  assert.match(workflow, /commit_sha/);
  assert.match(workflow, /package_tree_sha/);
  assert.match(workflow, /git cat-file -t/);
  assert.match(workflow, /--json assets --jq/);
  assert.match(workflow, /ACTUAL_ASSETS/);
  assert.match(workflow, /cmp --silent existing-release\/RELEASE-IDENTITY\.json RELEASE-IDENTITY\.json/);
  assert.doesNotMatch(workflow, /--clobber/);
});
