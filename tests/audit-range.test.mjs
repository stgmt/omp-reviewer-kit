import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('Feature: Commit-Range Audit CLI (scripts/audit-range.mjs)', () => {
  let tempRepo;
  const scriptPath = path.resolve('scripts/audit-range.mjs');

  before(async () => {
    tempRepo = await mkdtemp(path.join(tmpdir(), 'omp-range-audit-'));
    const git = (args) => {
      const res = spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8', windowsHide: true });
      assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
      return res;
    };

    git(['init']);
    git(['config', 'user.name', 'Audit Test']);
    git(['config', 'user.email', 'audit@test.local']);

    // Commit 0: initial base
    await writeFile(path.join(tempRepo, 'README.md'), '# Initial\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'Initial base commit']);

    // Commit 1: add test file with 3 asserts
    await mkdir(path.join(tempRepo, 'tests'), { recursive: true });
    await writeFile(path.join(tempRepo, 'tests/feature.test.mjs'), 'assert.equal(1, 1);\nassert.equal(2, 2);\nassert.equal(3, 3);\n');
    await writeFile(path.join(tempRepo, 'tests/legacy.test.mjs'), 'assert.ok(true);\n');
    git(['add', '.']);
    git(['commit', '-m', 'Add test files']);

    // Commit 2: weaken asserts in tests/feature.test.mjs (remove 2 asserts)
    await writeFile(path.join(tempRepo, 'tests/feature.test.mjs'), 'assert.equal(1, 1);\n');
    git(['add', 'tests/feature.test.mjs']);
    git(['commit', '-m', 'Weaken asserts in tests/feature.test.mjs']);

    // Commit 3: delete tests/legacy.test.mjs
    git(['rm', 'tests/legacy.test.mjs']);
    git(['commit', '-m', 'Remove legacy test file']);

    // Commit 4: clean non-test edit
    await writeFile(path.join(tempRepo, 'README.md'), '# Updated Readme\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'Update docs']);
  });

  after(async () => {
    if (tempRepo) {
      await rm(tempRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('generates markdown report with per-commit map and aggregate flags', () => {
    const res = spawnSync(process.execPath, [scriptPath, 'HEAD~3..HEAD'], {
      cwd: tempRepo,
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(res.status, 0, res.stderr);
    const output = res.stdout;

    assert.match(output, /# Range audit: HEAD~3\.\.HEAD/);
    assert.match(output, /## Per-commit suspicion map/);
    assert.match(output, /## Aggregate flags/);

    // Weaken asserts commit should be reported
    assert.ok(output.includes('Weaken asserts in tests/feature.test.mjs'));
    assert.ok(output.includes('assert lines +0/-2 (net -2)'));

    // Deleted test file commit should be reported
    assert.match(output, /Remove legacy test file/);
    assert.match(output, /deleted test file/);

    // Aggregate flags should identify both files
    assert.match(output, /Files with net negative assert delta:.*tests[\/\\]feature\.test\.mjs/);
    assert.match(output, /Deleted test files:.*tests[\/\\]legacy\.test\.mjs/);
  });

  it('outputs valid json structure with --json flag', () => {
    const res = spawnSync(process.execPath, [scriptPath, 'HEAD~3..HEAD', '--json'], {
      cwd: tempRepo,
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);

    assert.equal(parsed.range, 'HEAD~3..HEAD');
    assert.ok(Array.isArray(parsed.commits));
    assert.equal(parsed.commits.length, 3);
    assert.ok(parsed.aggregate);
    assert.ok(Array.isArray(parsed.aggregate.deletedTestFiles));
    assert.ok(parsed.aggregate.deletedTestFiles.includes('tests/legacy.test.mjs'));
  });

  it('exits with code 2 for invalid range or missing range argument', () => {
    const resMissing = spawnSync(process.execPath, [scriptPath], {
      cwd: tempRepo,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(resMissing.status, 2);
    assert.ok(resMissing.stderr.includes('Usage: node scripts/audit-range.mjs'));

    const resInvalid = spawnSync(process.execPath, [scriptPath, 'nonexistent..badref'], {
      cwd: tempRepo,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(resInvalid.status, 2);
    assert.match(resInvalid.stderr, /Invalid git revision range/);
  });
});
