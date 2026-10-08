import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  SubprocessGitAdapter,
  VENDORED_KIT_FILES,
  loadCanonicalVendoredFiles,
  runReview as modularRunReview,
} from '../src/index.mjs';
import * as bundle from '../scripts/run-review.mjs';

const RUNNER = '.omp/review-kit/run-review.mjs';
const HOOK = '.githooks/pre-commit';
const RUNNER_BODY = '// omp-reviewer-kit runner v9.9.9\nexport const x = 1;\n';
const HOOK_BODY = '#!/bin/sh\nexec node .omp/review-kit/run-review.mjs\n';
const canonical = () => new Map([[RUNNER, RUNNER_BODY], [HOOK, HOOK_BODY]]);

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const makeRepo = async (files) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-vendored-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
  git(repo, 'add', '-A');
  return repo;
};

const pathsOf = (diff) => [...diff.bytes.toString('utf8').matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);

describe('Feature: the vendored kit files are not part of the reviewed diff', () => {
  for (const [label, Adapter] of [['modular', SubprocessGitAdapter], ['bundled', bundle.SubprocessGitAdapter]]) {
    describe(`(${label})`, () => {
      it('Given a staged runner and hook identical to the canonical copies and a real change, Then only the real change is reviewed', async () => {
        const repo = await makeRepo({ [RUNNER]: RUNNER_BODY, [HOOK]: HOOK_BODY, 'src/a.mjs': 'export const a = 1;\n' });
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.deepEqual(pathsOf(diff), ['src/a.mjs']);
      });

      it('Given only identical vendored files are staged, Then the diff is empty', async () => {
        const repo = await makeRepo({ [RUNNER]: RUNNER_BODY, [HOOK]: HOOK_BODY });
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.equal(diff.isEmpty(), true);
      });

      it('Given a vendored file edited by hand (bytes differ), Then it stays in review', async () => {
        const repo = await makeRepo({ [RUNNER]: `${RUNNER_BODY}export const hacked = true;\n`, [HOOK]: HOOK_BODY });
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.deepEqual(pathsOf(diff), [RUNNER]);
      });

      it('Given CRLF line endings in the staged copy, Then the identical content is still recognised', async () => {
        const repo = await makeRepo({ [HOOK]: HOOK_BODY.replace(/\n/g, '\r\n') });
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.equal(diff.isEmpty(), true);
      });

      it('Given no canonical copy (no plugin, empty map, loader failure, no loader), Then nothing is exempted', async () => {
        const repo = await makeRepo({ [RUNNER]: RUNNER_BODY, [HOOK]: HOOK_BODY });
        const loaders = [
          async () => new Map(),
          async () => { throw new Error('plugin unreadable'); },
          async () => null,
          undefined,
        ];
        for (const vendoredFiles of loaders) {
          const diff = await new Adapter(undefined, { vendoredFiles }).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff).sort(), [HOOK, RUNNER].sort());
        }
      });

      it('Given the hook loses its executable bit with identical bytes, Then the mode change keeps it in review', async () => {
        const repo = await makeRepo({ [HOOK]: HOOK_BODY });
        git(repo, 'update-index', '--chmod=+x', HOOK);
        git(repo, 'commit', '-q', '-m', 'base', '--no-verify');
        git(repo, 'update-index', '--chmod=-x', HOOK);
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.deepEqual(pathsOf(diff), [HOOK]);
        assert.match(diff.bytes.toString('utf8'), /old mode 100755/);
      });

      it('Given a modified vendored file whose new content is canonical and whose mode is unchanged, Then it is excluded', async () => {
        const repo = await makeRepo({ [RUNNER]: '// omp-reviewer-kit runner v0.0.1\n' });
        git(repo, 'commit', '-q', '-m', 'base', '--no-verify');
        await writeFile(path.join(repo, RUNNER), RUNNER_BODY);
        git(repo, 'add', '-A');
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.equal(diff.isEmpty(), true);
      });

      it('Given a symlink staged at a vendored path whose target text equals the canonical bytes, Then it stays in review', async () => {
        const repo = await makeRepo({ 'README.md': 'x\n' });
        const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: HOOK_BODY, encoding: 'utf8' }).stdout.trim();
        git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},${HOOK}`);
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.ok(pathsOf(diff).includes(HOOK));
      });

      it('Given the hook is deleted from the index, Then the deletion stays in review', async () => {
        const repo = await makeRepo({ [HOOK]: HOOK_BODY, 'src/a.mjs': 'export const a = 1;\n' });
        git(repo, 'commit', '-q', '-m', 'base', '--no-verify');
        git(repo, 'rm', '-q', '--cached', HOOK);
        await writeFile(path.join(repo, 'src/a.mjs'), 'export const a = 2;\n');
        git(repo, 'add', 'src/a.mjs');
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.deepEqual(pathsOf(diff).sort(), [HOOK, 'src/a.mjs'].sort());
        assert.match(diff.bytes.toString('utf8'), /deleted file mode/);
      });

      it('Given a similarly named file outside the vendored paths, Then it is reviewed even with identical bytes', async () => {
        const repo = await makeRepo({ 'tools/.githooks/pre-commit': HOOK_BODY, 'docs/run-review.mjs': RUNNER_BODY });
        const diff = await new Adapter(undefined, { vendoredFiles: async () => canonical() }).getStagedDiff(repo);
        assert.deepEqual(pathsOf(diff).sort(), ['docs/run-review.mjs', 'tools/.githooks/pre-commit']);
      });

      it('Given the injected git runner and nothing to exempt, Then the diff call keeps the exact original arguments after one raw listing', async () => {
        const rawListing = ['diff', '--cached', '--raw', '--no-renames', '-z', '--'];
        const calls = [];
        const adapter = new Adapter((args) => { calls.push(args); return Buffer.from(''); });
        await adapter.getStagedDiff('/repo');
        assert.deepEqual(calls, [rawListing, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--']]);

        calls.length = 0;
        await new Adapter((args) => { calls.push(args); return Buffer.from(''); }, { vendoredFiles: async () => new Map() }).getStagedDiff('/repo');
        assert.deepEqual(calls, [rawListing, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--']]);
      });

      describe('the self-hosted runner mirror of the kit repository', () => {
        const SOURCE = 'scripts/run-review.mjs';
        const MIRROR_BODY = '// omp-reviewer-kit runner v9.9.9\nexport const mirrored = 1;\n';

        it('Given the mirror equals the staged source and no canonical copy exists, Then only the source is reviewed', async () => {
          const repo = await makeRepo({ [SOURCE]: MIRROR_BODY, [RUNNER]: MIRROR_BODY, 'src/a.mjs': 'export const a = 1;\n' });
          const diff = await new Adapter(undefined).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff).sort(), [SOURCE, 'src/a.mjs']);
        });

        it('Given the mirror differs from the staged source, Then both stay in review', async () => {
          const repo = await makeRepo({ [SOURCE]: MIRROR_BODY, [RUNNER]: `${MIRROR_BODY}export const extra = 2;\n` });
          const diff = await new Adapter(undefined).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff).sort(), [RUNNER, SOURCE]);
        });

        it('Given the mirror differs from the source only by CRLF line endings, Then it is still exempted', async () => {
          const repo = await makeRepo({ [SOURCE]: MIRROR_BODY, [RUNNER]: MIRROR_BODY.replace(/\n/g, '\r\n') });
          const diff = await new Adapter(undefined).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff), [SOURCE]);
        });

        it('Given the staged source is absent from the index, Then the mirror is reviewed', async () => {
          const repo = await makeRepo({ [RUNNER]: MIRROR_BODY, 'src/a.mjs': 'export const a = 1;\n' });
          const diff = await new Adapter(undefined).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff).sort(), [RUNNER, 'src/a.mjs']);
        });

        it('Given a symlink staged as the mirror whose target text equals the source, Then it stays in review', async () => {
          const repo = await makeRepo({ [SOURCE]: 'target.txt' });
          await mkdir(path.join(repo, '.omp/review-kit'), { recursive: true });
          const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'target.txt', encoding: 'utf8' }).stdout.trim();
          git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},${RUNNER}`);
          const diff = await new Adapter(undefined).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff).sort(), [RUNNER, SOURCE]);
        });

        it('Given a committed mirror modified to equal a modified source with the mode unchanged, Then only the source is reviewed', async () => {
          const repo = await makeRepo({ [SOURCE]: 'old\n', [RUNNER]: 'old\n' });
          git(repo, 'commit', '-q', '-m', 'base');
          await writeFile(path.join(repo, SOURCE), MIRROR_BODY);
          await writeFile(path.join(repo, RUNNER), MIRROR_BODY);
          git(repo, 'add', '-A');
          const diff = await new Adapter(undefined).getStagedDiff(repo);
          assert.deepEqual(pathsOf(diff), [SOURCE]);
        });
      });

      it('Given an unreadable staged blob of a vendored path, Then it is not exempted', async () => {
        const calls = [];
        const adapter = new Adapter((args) => {
          calls.push(args);
          if (args.includes('--raw')) return Buffer.from(`:000000 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} A\0${RUNNER}\0`);
          if (args[0] === 'show') throw new Error('bad object');
          return Buffer.from('');
        }, { vendoredFiles: async () => canonical() });
        await adapter.getStagedDiff('/repo');
        assert.deepEqual(calls.at(-1), ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--']);
      });
    });
  }
});

describe('Feature: canonical vendored files come from the installed kit plugin', () => {
  const makePlugin = async ({ name = 'omp-reviewer-kit', runner = RUNNER_BODY, hook = HOOK_BODY } = {}) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'omp-plugin-'));
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));
    if (runner !== null) await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), runner);
    if (hook !== null) await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), hook);
    return dir;
  };
  const emptyHome = () => mkdtemp(path.join(tmpdir(), 'omp-home-'));

  it('maps the vendored targets to the plugin sources', () => {
    assert.deepEqual(VENDORED_KIT_FILES.map((f) => [f.target, f.source]), [
      [RUNNER, 'scripts/run-review.mjs'],
      [HOOK, 'templates/githooks/pre-commit'],
    ]);
  });

  for (const [label, load] of [['modular', loadCanonicalVendoredFiles], ['bundled', bundle.loadCanonicalVendoredFiles]]) {
    describe(`(${label})`, () => {
      it('reads both files from OMP_REVIEW_KIT_PLUGIN_DIR', async () => {
        const dir = await makePlugin();
        const files = await load({ env: { OMP_REVIEW_KIT_PLUGIN_DIR: dir }, home: await emptyHome() });
        assert.deepEqual([...files.entries()], [[RUNNER, RUNNER_BODY], [HOOK, HOOK_BODY]]);
      });

      it('falls back to the OMP plugin directory under the home folder', async () => {
        const home = await emptyHome();
        const dir = path.join(home, '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit');
        await mkdir(path.join(dir, 'scripts'), { recursive: true });
        await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit' }));
        await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), RUNNER_BODY);
        await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), HOOK_BODY);
        assert.equal((await load({ env: {}, home })).get(RUNNER), RUNNER_BODY);
      });

      it('keeps searching: a foreign or incomplete first candidate falls through to the plugin under the home folder', async () => {
        const home = await emptyHome();
        const dir = path.join(home, '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit');
        await mkdir(path.join(dir, 'scripts'), { recursive: true });
        await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit' }));
        await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), RUNNER_BODY);
        await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), HOOK_BODY);
        for (const first of [await makePlugin({ name: 'other' }), await makePlugin({ hook: null }), path.join(home, 'absent')]) {
          const files = await load({ env: { OMP_REVIEW_KIT_PLUGIN_DIR: first }, home });
          assert.equal(files.size, 2);
          assert.equal(files.get(HOOK), HOOK_BODY);
          assert.equal(files.get(RUNNER), RUNNER_BODY);
        }
      });

      it('returns an empty map for a foreign package, a missing source file, or no plugin at all', async () => {
        const home = await emptyHome();
        assert.equal((await load({ env: { OMP_REVIEW_KIT_PLUGIN_DIR: await makePlugin({ name: 'other' }) }, home })).size, 0);
        assert.equal((await load({ env: { OMP_REVIEW_KIT_PLUGIN_DIR: await makePlugin({ hook: null }) }, home })).size, 0);
        assert.equal((await load({ env: { OMP_REVIEW_KIT_PLUGIN_DIR: path.join(home, 'absent') }, home })).size, 0);
        assert.equal((await load({ env: {}, home })).size, 0);
      });
    });
  }
});

describe('Feature: a commit of only vendored kit files is skipped by the workflow', () => {
  for (const [label, runReview] of [['modular', modularRunReview], ['bundled', bundle.runReview]]) {
    it(`(${label}) Given identical vendored files only, Then the reviewer is not invoked and the run is skipped; a real change is still reviewed`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'omp-plugin-'));
      await mkdir(path.join(dir, 'scripts'), { recursive: true });
      await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit' }));
      await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), RUNNER_BODY);
      await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), HOOK_BODY);
      const vendoredFiles = () => loadCanonicalVendoredFiles({ env: { OMP_REVIEW_KIT_PLUGIN_DIR: dir }, home: dir });
      let invoked = 0;
      const omp = async () => { invoked += 1; return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' }; };
      const logger = { log: () => {}, error: () => {} };

      const only = await makeRepo({ [RUNNER]: RUNNER_BODY, [HOOK]: HOOK_BODY });
      const skipped = await runReview({ cwd: only, vendoredFiles, omp, logger });
      assert.equal(skipped.skipped, true);
      assert.equal(skipped.exitCode, 0);
      assert.equal(invoked, 0);

      const mixed = await makeRepo({ [RUNNER]: RUNNER_BODY, 'src/a.mjs': 'export const a = 1;\n' });
      const reviewed = await runReview({ cwd: mixed, vendoredFiles, omp, logger });
      assert.equal(reviewed.skipped, false);
      assert.ok(invoked >= 1);
    });
  }
});

describe('Feature: the pre-commit entrypoint wires the canonical-file loader', () => {
  it('Given a commit of only identical vendored files, When scripts/run-review.mjs runs as the hook does, Then it exits 0 as skipped without calling OMP', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'omp-plugin-'));
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await mkdir(path.join(dir, 'templates', 'githooks'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit' }));
    await writeFile(path.join(dir, 'scripts', 'run-review.mjs'), RUNNER_BODY);
    await writeFile(path.join(dir, 'templates', 'githooks', 'pre-commit'), HOOK_BODY);
    const repo = await makeRepo({ [RUNNER]: RUNNER_BODY, [HOOK]: HOOK_BODY });
    const result = spawnSync(process.execPath, [path.resolve('scripts/run-review.mjs')], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, OMP_REVIEW_KIT_PLUGIN_DIR: dir, OMP_REVIEW_KIT_OMP: path.join(dir, 'must-not-run') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /SKIPPED: no reviewable staged changes/);
  });
});
