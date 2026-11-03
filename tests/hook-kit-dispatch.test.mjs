// Given/When/Then over the hook's dispatch: the kit repository runs its canonical runner, a consumer
// repository runs its vendored copy. Real shell, real files, no mocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'githooks', 'pre-commit');

const fixture = async ({ name, canonical = true, vendored = true }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hook-dispatch-'));
  await mkdir(path.join(root, '.githooks'), { recursive: true });
  await mkdir(path.join(root, '.omp', 'review-kit'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name }));
  await writeFile(path.join(root, '.githooks', 'pre-commit'), await readFile(template, 'utf8'));
  const marker = suffix => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(root, 'which.txt'))}, '${suffix}', 'utf8');\n`;
  if (canonical) await writeFile(path.join(root, 'scripts', 'run-review.mjs'), marker('canonical'));
  if (vendored) await writeFile(path.join(root, '.omp', 'review-kit', 'run-review.mjs'), marker('vendored'));
  return root;
};

const runHook = (root) => spawnSync('sh', [path.join(root, '.githooks', 'pre-commit')], { cwd: root, encoding: 'utf8' });

test('Given the kit repository itself, When the hook runs, Then the canonical runner executes and a stale vendored copy does not', async () => {
  const root = await fixture({ name: 'omp-reviewer-kit' });
  try {
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(path.join(root, 'which.txt'), 'utf8')), 'canonical');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given a consumer repository, When the hook runs, Then the vendored runner executes', async () => {
  const root = await fixture({ name: 'some-consumer' });
  try {
    const result = runHook(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(path.join(root, 'which.txt'), 'utf8')), 'vendored');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
