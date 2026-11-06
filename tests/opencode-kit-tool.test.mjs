import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { createReviewKitTool } from '../opencode/kit-tool.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
const ROOT = realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('Given native OpenCode commands, When a real project is reviewed, Then empty changes skip and an over-budget change blocks without modifying the project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-review-command-'));
  t.after(() => rm(root, REMOVE));
  const previous = new Map(['HOME', 'USERPROFILE', 'OMP_REVIEW_KIT_RUNS_DIR', 'OMP_REVIEW_KIT_REPORTS_DIR', 'OMP_REVIEW_KIT_MAX_DIFF'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; });
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = path.join(root, 'runs');
  process.env.OMP_REVIEW_KIT_REPORTS_DIR = path.join(root, 'reports');
  process.env.OMP_REVIEW_KIT_MAX_DIFF = '1';
  const project = path.join(root, 'project');
  await (await import('node:fs/promises')).mkdir(project);
  git(project, 'init', '-q');
  const tool = createReviewKitTool();
  assert.deepEqual(z.object(tool.args).parse({ operation: 'review' }), { operation: 'review' });
  const empty = JSON.parse(await tool.execute({ operation: 'review' }, { directory: project }));
  assert.equal(empty.exitCode, 0, empty.stderr);
  assert.match(empty.stdout + empty.stderr, /SKIPPED/);
  assert.equal(git(project, 'status', '--porcelain'), '');

  await writeFile(path.join(project, 'one.js'), 'export const one = 1;\n');
  await writeFile(path.join(project, 'two.js'), 'export const two = 2;\n');
  git(project, 'add', 'one.js', 'two.js');
  const before = git(project, 'diff', '--cached', '--binary');
  await assert.rejects(
    tool.execute({ operation: 'review' }, { directory: project }),
    /reviewer-kit command did not complete successfully:.*(?:BLOCK|budget|limit)/i,
  );
  assert.equal(git(project, 'diff', '--cached', '--binary'), before);
  assert.equal(await readFile(path.join(project, 'one.js'), 'utf8'), 'export const one = 1;\n');
  await assert.rejects(readFile(path.join(project, '.githooks', 'pre-commit')), { code: 'ENOENT' });
});

test('Given invalid or cancelled OpenCode commands, When invoked, Then no command starts', async () => {
  const tool = createReviewKitTool();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute({ operation: 'review' }, { directory: os.tmpdir(), abort: controller.signal }), /aborted/i);
  await assert.rejects(tool.execute({ operation: 'unknown' }, { directory: os.tmpdir() }), /Invalid review_kit operation/);
  await assert.rejects(tool.execute({ operation: 'review' }, {}), /project directory/);
});

function fakeChild({ pid, onKill } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => { onKill?.(signal ?? 'SIGTERM'); };
  return child;
}

test('Given each OpenCode command, When it is dispatched, Then it runs the documented script and arguments', async () => {
  const launched = [];
  const spawnImpl = (command, args, options) => {
    launched.push({ command, args, options });
    const child = fakeChild({});
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  const tool = createReviewKitTool({ spawnImpl });
  const directory = os.tmpdir();
  const expected = {
    doctor: ['claude-plugin/scripts/bridge.mjs', 'doctor'],
    setup: ['claude-plugin/scripts/bridge.mjs', 'setup'],
    install_omp_plan: ['claude-plugin/scripts/bridge.mjs', 'install-omp'],
    install_omp_apply: ['claude-plugin/scripts/bridge.mjs', 'install-omp', '--yes'],
  };
  for (const [operation, argv] of Object.entries(expected)) {
    await tool.execute({ operation }, { directory });
    const last = launched.at(-1);
    assert.equal(last.command, 'node');
    assert.equal(last.args[0], realpathSync.native(path.join(ROOT, argv[0])), `${operation} runs its script`);
    assert.deepEqual(last.args.slice(1), argv.slice(1), `${operation} passes exactly its arguments`);
  }
  assert.equal(launched[3].args.includes('--yes'), true, 'only the explicit apply route installs');
  assert.equal(launched[2].args.includes('--yes'), false, 'the plan route stays read-only');
});

test('Given a command that prints more than the limit, When it finishes successfully, Then the tool rejects instead of returning a partial answer', async () => {
  const spawnImpl = () => {
    const child = fakeChild({});
    setImmediate(() => {
      child.stdout.emit('data', Buffer.alloc(300 * 1024, 'x'));
      child.emit('close', 0, null);
    });
    return child;
  };
  const tool = createReviewKitTool({ spawnImpl });
  await assert.rejects(
    tool.execute({ operation: 'doctor' }, { directory: os.tmpdir() }),
    /did not complete successfully:.*"truncated":true/,
  );
});

test('Given a command still running, When the caller aborts it, Then the tool rejects and the child is terminated', async () => {
  const signals = [];
  const child = fakeChild({ pid: 999_999, onKill: signal => signals.push(signal) });
  const tool = createReviewKitTool({ spawnImpl: () => child });
  const controller = new AbortController();
  const pending = tool.execute({ operation: 'doctor' }, { directory: os.tmpdir(), abort: controller.signal });
  // The real child ends when it is terminated; this stand-in reports the same way after the abort.
  const terminating = new Promise(resolve => {
    setTimeout(() => {
      controller.abort();
      setTimeout(() => { child.emit('close', null, 'SIGTERM'); resolve(); }, 400);
    }, 10);
  });
  await assert.rejects(pending, /Command aborted/);
  await terminating;
  if (process.platform !== 'win32') {
    assert.deepEqual(signals.slice(0, 1), ['SIGTERM'], 'the started child is asked to stop');
  }
});
