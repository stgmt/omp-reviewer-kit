// Given/When/Then over the process-tree termination the mutation runner uses for a timed-out mutant.
// Real child processes; nothing about the operating system is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../src/infra/process-tree.mjs';

const POSIX = process.platform !== 'win32';
const TIMEOUT_MS = 30000;

function exited(proc) {
  return new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once('close', () => resolve());
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitUntil(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return condition();
}

function firstLine(stream) {
  return new Promise(resolve => {
    let text = '';
    const onData = chunk => {
      text += chunk;
      if (text.includes('\n')) {
        stream.off('data', onData);
        resolve(text.split('\n')[0]);
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
  });
}

test('Given a child that started a grandchild, When its tree is terminated, Then the grandchild is gone too', { timeout: TIMEOUT_MS }, async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(grandchild.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  // A detached child leads its own process group on POSIX; taskkill /T walks the tree on Windows.
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: POSIX });
  const grandchild = Number(await firstLine(proc.stdout));
  assert.equal(alive(grandchild), true, 'the grandchild runs before termination');
  await terminateProcessTree(proc);
  await exited(proc);
  assert.equal(await waitUntil(() => !alive(grandchild)), true, 'the grandchild is terminated with its parent');
});

test('Given a child that ignores SIGTERM, When its tree is terminated, Then it ends by SIGKILL', { skip: POSIX ? false : 'POSIX signals only', timeout: TIMEOUT_MS }, async () => {
  const proc = spawn('/bin/sh', ['-c', "trap '' TERM; echo ready; sleep 30"], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  assert.equal(await firstLine(proc.stdout), 'ready', 'the shell has installed its SIGTERM trap');
  await terminateProcessTree(proc);
  await exited(proc);
  assert.equal(proc.signalCode, 'SIGKILL', 'SIGTERM is ignored, so only the escalation ends the child');
});

test('Given a child that has already exited, When its tree is terminated, Then only SIGTERM is sent and no escalation follows', { skip: POSIX ? false : 'POSIX signals only', timeout: TIMEOUT_MS }, async t => {
  const proc = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: true });
  await exited(proc);
  const realKill = process.kill;
  const sent = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    sent.push(signal);
    return realKill.call(process, pid, signal);
  });
  await terminateProcessTree(proc);
  assert.deepEqual(sent, ['SIGTERM']);
});
