import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

test('Given an installed OMP library and a stale inherited runtime, When the launcher starts the real engine, Then it uses the installed library', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-stale-runtime-'));
  t.after(() => rm(root, REMOVE));
  for (const directory of ['scripts', 'src/infra', 'src/native', 'node_modules/@oh-my-pi', 'project']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const file of ['scripts/run-review.mjs', 'src/infra/main-module.mjs', 'src/infra/ensure-review-runtime.mjs']) {
    await copyFile(path.join(kitRoot, file), path.join(root, file));
  }
  await copyFile(path.join(kitRoot, 'package.json'), path.join(root, 'package.json'));
  await symlink(path.join(kitRoot, 'node_modules', '@oh-my-pi', 'pi-coding-agent'), path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent'), 'junction');
  const engine = new URL('../src/native/task-engine.mjs', import.meta.url).href;
  await writeFile(path.join(root, 'src', 'native', 'native-host.mjs'),
    `import {loadOmpEngine} from ${JSON.stringify(engine)}; const engine = await loadOmpEngine(); await engine.Settings.init({cwd: process.cwd()}); const session = engine.SessionManager.create(process.cwd()); await session.setSessionName('installed engine', 'auto'); console.log(session.getSessionName());\n`);
  const project = path.join(root, 'project');
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-review.mjs'), project], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, OMP_REVIEW_KIT_RUNTIME_ROOT: path.join(root, 'stale-runtime') },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'installed engine');
});
