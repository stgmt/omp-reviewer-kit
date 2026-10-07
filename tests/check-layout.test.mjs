import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function layoutFixture() {
  const source = await readFile('scripts/check-layout.mjs', 'utf8');
  const listed = (start) => {
    const from = source.indexOf(start);
    return [...source.slice(from, source.indexOf('];', from)).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const required = [...listed('const required'), ...listed('const CLAUDE_PLUGIN_FILES').map((file) => `claude-plugin/${file}`)];
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-layout-gate-'));
  for (const file of required) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), await readFile(file));
  }
  await mkdir(path.join(dir, '.omp', 'review-kit'), { recursive: true });
  await writeFile(path.join(dir, '.omp', 'review-kit', 'run-review.mjs'), await readFile('scripts/run-review.mjs'));
  const check = () => spawnSync(process.execPath, [path.resolve('scripts/check-layout.mjs')], { cwd: dir, encoding: 'utf8' });
  const edit = async (file, mutate) => {
    const target = path.join(dir, file);
    await writeFile(target, mutate(await readFile(target, 'utf8')));
  };
  return { dir, check, edit, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const failure = (result) => `${result.stdout}${result.stderr}`;

test('Given a consistent tree, check-layout passes', async () => {
  const fx = await layoutFixture();
  try {
    assert.equal(fx.check().status, 0, failure(fx.check()));
  } finally {
    await fx.cleanup();
  }
});

for (const name of ['infra/stage-transcript-stats.mjs', 'domain/context-pack.mjs', 'domain/scout-baseline.mjs', 'domain/hunter-shards.mjs', 'domain/target-policy.mjs', 'infra/target-registry.mjs']) {
  test(`check-layout rejects a tree that lacks src/${name}`, async () => {
    const fx = await layoutFixture();
    try {
      await rm(path.join(fx.dir, 'src', ...name.split('/')));
      const result = fx.check();
      assert.notEqual(result.status, 0);
      assert.match(failure(result), new RegExp(name.split('/')[1].replace(/\./g, '\\.')));
    } finally {
      await fx.cleanup();
    }
  });
}

test('check-layout rejects a runner without the version marker or with a stale version', async () => {
  const fx = await layoutFixture();
  try {
    const strip = (text) => text.slice(text.indexOf('\n') + 1);
    await fx.edit('scripts/run-review.mjs', strip);
    await fx.edit('.omp/review-kit/run-review.mjs', strip);
    let result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /must start with "\/\/ omp-reviewer-kit runner v/);
  } finally {
    await fx.cleanup();
  }

  const stale = await layoutFixture();
  try {
    await stale.edit('package.json', (text) => text.replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    const result = stale.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /runner v9\.9\.9/);
  } finally {
    await stale.cleanup();
  }
});

test('check-layout rejects Claude manifest or catalog versions that drift from package.json', async () => {
  const manifest = await layoutFixture();
  try {
    await manifest.edit('claude-plugin/.claude-plugin/plugin.json', (text) => text.replace(/"version": "[^"]+"/, '"version": "0.0.1"'));
    const result = manifest.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /must equal package\.json version/);
  } finally {
    await manifest.cleanup();
  }

  const catalog = await layoutFixture();
  try {
    await catalog.edit('.claude-plugin/marketplace.json', (text) => text.replace(/"version": "[^"]+"/, '"version": "0.0.1"'));
    const result = catalog.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /must equal package\.json version/);
  } finally {
    await catalog.cleanup();
  }
});

test('check-layout rejects a marketplace source that is not the Claude shell directory', async () => {
  const fx = await layoutFixture();
  try {
    await fx.edit('.claude-plugin/marketplace.json', (text) => text.replace('"./claude-plugin"', '"./"'));
    const result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /must point its source at \.\/claude-plugin/);
  } finally {
    await fx.cleanup();
  }
});

test('check-layout rejects an extra file in the Claude shell and an oversized payload', async () => {
  const extra = await layoutFixture();
  try {
    await writeFile(path.join(extra.dir, 'claude-plugin', 'notes.md'), 'stray');
    const result = extra.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /claude-plugin\/ must contain exactly/);
  } finally {
    await extra.cleanup();
  }

  const big = await layoutFixture();
  try {
    await appendFile(path.join(big.dir, 'claude-plugin', 'commands', 'doctor.md'), 'x'.repeat(100 * 1024));
    const result = big.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /the limit is 102400/);
  } finally {
    await big.cleanup();
  }
});
