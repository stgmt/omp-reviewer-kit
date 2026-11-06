import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const engine = new URL('../src/native/task-engine.mjs', import.meta.url).href;

test('Given the installed OMP library and no runtime override, When the native engine loads, Then it initializes real settings and a session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-real-engine-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  delete env.OMP_REVIEW_KIT_RUNTIME_ROOT;
  const code = `import {loadOmpEngine} from ${JSON.stringify(engine)}; const value = await loadOmpEngine(); const settings = await value.Settings.init({cwd: process.argv[1]}); const session = value.SessionManager.create(process.argv[1]); await session.setSessionName('isolated review', 'auto'); console.log(JSON.stringify({name:session.getSessionName(), settings:typeof settings.overlay, exports:Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item]))}));`;
  const child = spawnSync('bun', ['-e', code, root], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.name, 'isolated review');
  assert.equal(result.settings, 'function');
  const actual = result.exports;
  for (const name of ['Settings', 'ModelRegistry', 'discoverAuthStorage', 'SessionManager', 'TaskTool', 'EventBus']) {
    assert.notEqual(actual[name], 'undefined', `${name} must load from the installed OMP package`);
  }
  assert.equal(typeof actual.MAIN_AGENT_ID, 'string');
});
