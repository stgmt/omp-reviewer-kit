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
  await writeFile(path.join(dir, '.omp', 'review-kit', 'run-review.mjs'), await readFile('templates/review-kit/run-review.mjs'));
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

for (const name of ['infra/stage-transcript-stats.mjs', 'domain/context-pack.mjs', 'domain/scout-baseline.mjs', 'domain/hunter-shards.mjs', 'domain/target-policy.mjs', 'infra/target-registry.mjs', 'infra/review-run-records.mjs']) {
  test(`check-layout rejects a tree that lacks src/${name}`, async () => {
    const fx = await layoutFixture();
    try {
      // force: a gate that stopped requiring the file also stops copying it, so the removal must not be the failure.
      await rm(path.join(fx.dir, 'src', ...name.split('/')), { force: true });
      const result = fx.check();
      assert.notEqual(result.status, 0);
      assert.match(failure(result), new RegExp(name.split('/')[1].replace(/\./g, '\\.')));
    } finally {
      await fx.cleanup();
    }
  });
}

for (const file of ['src/domain/superseded-runs.mjs', 'src/infra/process-table.mjs', 'src/application/superseded-run-stopper.mjs', 'scripts/stop-superseded-runs.mjs']) {
  test(`check-layout rejects a tree that lacks ${file}`, async () => {
    // Given: the consistent tree the other cases build
    const fx = await layoutFixture();
    try {
      // When: the file is removed (force: a gate that stopped requiring it also stops copying it, so the removal must not be the failure)
      await rm(path.join(fx.dir, ...file.split('/')), { force: true });
      const result = fx.check();
      // Then: the gate fails and names the file
      assert.notEqual(result.status, 0);
      assert.match(failure(result), new RegExp(file.replace(/[./]/g, (char) => (char === '/' ? '[\\\\/]' : '\\.'))));
    } finally {
      await fx.cleanup();
    }
  });
}

test('check-layout rejects a tree that lacks scripts/review-progress.mjs', async () => {
  const fx = await layoutFixture();
  try {
    await rm(path.join(fx.dir, 'scripts', 'review-progress.mjs'), { force: true });
    const result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /review-progress\.mjs/);
  } finally {
    await fx.cleanup();
  }
});

test('check-layout rejects a vendored runner that is not the thin stub', async () => {
  const fx = await layoutFixture();
  try {
    await fx.edit('.omp/review-kit/run-review.mjs', (text) => `${text}// edited in place\n`);
    const result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /must be identical to templates\/review-kit\/run-review\.mjs/);
  } finally {
    await fx.cleanup();
  }
});

test('check-layout rejects a stub without its marker line', async () => {
  const fx = await layoutFixture();
  try {
    // Both copies change together, so the identity check passes and the stub's own marker guard is what fails.
    const unmarked = (text) => text.replace('// omp-reviewer-kit runner v1.0.0', '// another runner');
    await fx.edit('templates/review-kit/run-review.mjs', unmarked);
    await fx.edit('.omp/review-kit/run-review.mjs', unmarked);
    const result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /its marker line/);
  } finally {
    await fx.cleanup();
  }
});

test('check-layout rejects a stub whose marker does not outrank the algorithm', async () => {
  const fx = await layoutFixture();
  try {
    // The stub claims the algorithm's own version: an installer that predates the stub would then overwrite it with the algorithm.
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const sameVersion = (text) => text.replace('// omp-reviewer-kit runner v1.0.0', `// omp-reviewer-kit runner v${version}`);
    await fx.edit('templates/review-kit/run-review.mjs', sameVersion);
    await fx.edit('.omp/review-kit/run-review.mjs', sameVersion);
    const result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /marker above the algorithm/);
  } finally {
    await fx.cleanup();
  }
});

test('check-layout rejects a stub larger than 4 KB', async () => {
  const fx = await layoutFixture();
  try {
    // Both copies grow together, so the identity check passes and the size guard is what fails.
    const stub = await readFile('templates/review-kit/run-review.mjs', 'utf8');
    const oversized = `${stub}${'/'.repeat(4097 - Buffer.byteLength(stub))}`;
    await fx.edit('templates/review-kit/run-review.mjs', () => oversized);
    await fx.edit('.omp/review-kit/run-review.mjs', () => oversized);
    const result = fx.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /at most 4 KB/);
  } finally {
    await fx.cleanup();
  }
});

test('check-layout rejects a runner without the version marker or with a stale version', async () => {
  const fx = await layoutFixture();
  try {
    const strip = (text) => text.slice(text.indexOf('\n') + 1);
    await fx.edit('scripts/run-review.mjs', strip);
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

test('check-layout rejects a hook template whose marker is missing, stale, or no longer matches its body', async () => {
  const edited = await layoutFixture();
  try {
    await edited.edit('templates/githooks/pre-commit', (text) => text.replace('set -eu', 'set -eu\n# edited after stamping'));
    const result = edited.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /stamp-hook\.mjs/);
  } finally {
    await edited.cleanup();
  }

  const stale = await layoutFixture();
  try {
    await stale.edit('templates/githooks/pre-commit', (text) => text.replace(/hook v\d+\.\d+\.\d+/, 'hook v0.0.1'));
    const result = stale.check();
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /stamp-hook\.mjs/);
  } finally {
    await stale.cleanup();
  }
});
