import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  // Runs the real --llm spawn against a fake OMP and returns the argv and stdin it received.
  async function runFakeLlm(envOverrides = {}) {
    const fakeDir = await mkdtemp(path.join(tmpdir(), 'omp-range-llm-'));
    try {
      const isWindows = process.platform === 'win32';
      const fakeOmp = path.join(fakeDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
      const argsPath = path.join(fakeDir, 'args.txt');
      const stdinPath = path.join(fakeDir, 'stdin.txt');
      const script = isWindows
        ? '@echo off\n> "%AUDIT_RANGE_TEST_ARGS%" echo %*\nmore > "%AUDIT_RANGE_TEST_STDIN%"\nexit /b 0\n'
        : '#!/bin/sh\nprintf "%s\\n" "$@" > "$AUDIT_RANGE_TEST_ARGS"\ncat > "$AUDIT_RANGE_TEST_STDIN"\n';
      await writeFile(fakeOmp, script, 'utf8');
      if (!isWindows) await chmod(fakeOmp, 0o755);

      const env = {
        ...process.env,
        OMP_REVIEW_KIT_OMP: fakeOmp,
        OMP_REVIEW_KIT_MODEL: '@bogus',
        AUDIT_RANGE_TEST_ARGS: argsPath,
        AUDIT_RANGE_TEST_STDIN: stdinPath,
        ...envOverrides,
      };
      for (const [key, value] of Object.entries(envOverrides)) {
        if (value === undefined) delete env[key];
      }
      const res = spawnSync(process.execPath, [scriptPath, 'HEAD~3..HEAD', '--llm'], {
        cwd: tempRepo,
        encoding: 'utf8',
        windowsHide: true,
        env,
      });

      assert.equal(res.status, 0, res.stderr);
      const args = (await readFile(argsPath, 'utf8')).split(/\s+/).filter(Boolean);
      const prompt = await readFile(stdinPath, 'utf8');
      return { args, prompt };
    } finally {
      await rm(fakeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  it('runs review-range-auditor through the default OMP role with no model flag', async () => {
    const { args, prompt } = await runFakeLlm();

    assert.deepEqual(args, ['-p', '--no-session'], `OMP argv must carry no model pin: ${args.join(' ')}`);
    assert.match(prompt, /agent "review-range-auditor"/);
    assert.match(prompt, /Make the task call without a model field/);
    assert.match(prompt, /HEAD~3\.\.HEAD/);
  });

  it('falls back to cmd.exe for the Windows wrapper when ComSpec is unset', { skip: process.platform !== 'win32' && 'Windows .cmd wrapper only' }, async () => {
    const { args } = await runFakeLlm({ ComSpec: undefined });

    assert.deepEqual(args, ['-p', '--no-session']);
  });

  it('reports a failed OMP launch on stderr and exits 1', () => {
    const res = spawnSync(process.execPath, [scriptPath, 'HEAD~3..HEAD', '--llm'], {
      cwd: tempRepo,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, OMP_REVIEW_KIT_OMP: path.join(tempRepo, 'no-such-omp') },
    });

    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /Failed to launch OMP for range audit/);
  });
});
