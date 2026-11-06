import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../opencode/plugin.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

test('Given OpenCode opens another project, When it reviews a commit, Then it uses that project', async () => {
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-cwd-kit-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oc-cwd-project-'));
  const previous = process.env.OMP_REVIEW_KIT_ROOT;
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'),
      `process.exit(process.cwd() === ${JSON.stringify(project)} ? 1 : 0);\n`, 'utf8');
    process.env.OMP_REVIEW_KIT_ROOT = kitRoot;
    const hooks = await plugin.server({ directory: project });
    await assert.rejects(
      hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m x' } }),
      /blocked this commit/,
    );
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROOT;
    else process.env.OMP_REVIEW_KIT_ROOT = previous;
    await rm(kitRoot, REMOVE);
    await rm(project, REMOVE);
  }
});

test('Given a shell command specifies a workdir, When it reviews a commit, Then it reviews that directory', async () => {
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-workdir-kit-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oc-workdir-project-'));
  const nested = path.join(project, 'nested');
  const previous = process.env.OMP_REVIEW_KIT_ROOT;
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    await mkdir(nested);
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'),
      `process.exit(process.cwd() === ${JSON.stringify(nested)} ? 1 : 0);\n`, 'utf8');
    process.env.OMP_REVIEW_KIT_ROOT = kitRoot;
    const hooks = await plugin.server({ directory: project });
    for (const workdir of ['nested', nested]) {
      await assert.rejects(
        hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m x', workdir } }),
        /blocked this commit/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROOT;
    else process.env.OMP_REVIEW_KIT_ROOT = previous;
    await rm(kitRoot, REMOVE);
    await rm(project, REMOVE);
  }
});

test('Given the OpenCode project no longer exists, When it reviews a commit, Then it blocks the commit', async () => {
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-missing-kit-'));
  const previous = process.env.OMP_REVIEW_KIT_ROOT;
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), 'process.exit(0);\n', 'utf8');
    process.env.OMP_REVIEW_KIT_ROOT = kitRoot;
    const hooks = await plugin.server({ directory: path.join(kitRoot, 'missing') });
    await assert.rejects(
      hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m x' } }),
      /ENOENT/,
    );
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROOT;
    else process.env.OMP_REVIEW_KIT_ROOT = previous;
    await rm(kitRoot, REMOVE);
  }
});
