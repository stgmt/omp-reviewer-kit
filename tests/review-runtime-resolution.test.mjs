import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

test('Given a provisioned runtime, When the native engine loads, Then all entries come from that runtime', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-resolution-'));
  t.after(() => rm(root, REMOVE));
  const packageRoot = path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}\n');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@oh-my-pi/pi-coding-agent', version: '1.0.0', type: 'module', exports: { './*': './*.mjs' },
  }));
  const entries = {
    'config/settings': 'Settings',
    'config/model-registry': 'ModelRegistry',
    'sdk': 'discoverAuthStorage',
    'session/session-manager': 'SessionManager',
    'task/index': 'TaskTool',
    'utils/event-bus': 'EventBus',
    'registry/agent-registry': 'MAIN_AGENT_ID',
  };
  for (const [entry, symbol] of Object.entries(entries)) {
    const file = path.join(packageRoot, `${entry}.mjs`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `export const ${symbol} = ${JSON.stringify(`isolated:${symbol}`)};\n`);
  }
  const engine = new URL('../src/native/task-engine.mjs', import.meta.url).href;
  const code = `import {loadOmpEngine} from ${JSON.stringify(engine)}; console.log(JSON.stringify(await loadOmpEngine()));`;
  const child = spawnSync('bun', ['-e', code], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, cwd: root,
    env: { ...process.env, OMP_REVIEW_KIT_RUNTIME_ROOT: root },
  });
  assert.equal(child.status, 0, child.stderr);
  const loaded = JSON.parse(child.stdout);
  for (const symbol of Object.values(entries)) assert.equal(loaded[symbol], `isolated:${symbol}`);
  const incomplete = path.join(root, 'incomplete');
  await mkdir(incomplete);
  await writeFile(path.join(incomplete, 'package.json'), '{}\n');
  const escaped = spawnSync('bun', ['-e', code], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, cwd: root,
    env: { ...process.env, OMP_REVIEW_KIT_RUNTIME_ROOT: incomplete },
  });
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /resolved OMP entry outside the pinned runtime/);
});
