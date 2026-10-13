import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SubprocessExecutionAdapter as ModularExecutionAdapter } from '../src/infra/subprocess-execution-adapter.mjs';
import { SubprocessExecutionAdapter as RunnerExecutionAdapter } from '../scripts/run-review.mjs';

for (const [name, Adapter] of [['modular', ModularExecutionAdapter], ['runner', RunnerExecutionAdapter]]) {
  test(`Given a ${name} execution command, When it exits normally, Then its status, output and duration are reported`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'omp-execution-'));
    try {
      const script = path.join(dir, 'command.mjs');
      await writeFile(script, "console.log('execution stdout'); console.error('execution stderr'); process.exitCode = 7;\n");

      const result = await new Adapter().run({ command: `"${process.execPath}" "${script}"`, cwd: dir, timeoutMs: 0 });

      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 7);
      assert.equal(result.timedOut, false);
      assert.match(result.stdout, /execution stdout/);
      assert.match(result.stderr, /execution stderr/);
      assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`Given a ${name} command whose child holds stdout open, When execution times out, Then the process tree exits before its natural end`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'omp-execution-timeout-'));
    try {
      const script = path.join(dir, 'command.mjs');
      const completed = path.join(dir, 'completed.txt');
      await writeFile(script, [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(completed)}, 'finished'); }, 15000);`)}], { stdio: 'inherit' });`,
        "child.on('exit', () => process.exit(0));",
      ].join('\n'));
      const started = Date.now();

      const result = await new Adapter().run({ command: `"${process.execPath}" "${script}"`, cwd: dir, timeoutMs: 1000 });

      assert.equal(result.ok, true);
      assert.equal(result.timedOut, true);
      assert.notEqual(result.exitCode, 0);
      assert.ok(Date.now() - started < 10000, 'termination must not wait for the command to finish naturally');
      await assert.rejects(readFile(completed, 'utf8'), { code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`Given a ${name} empty command, When execution is requested, Then it is rejected without spawning`, async () => {
    assert.deepEqual(await new Adapter().run({ command: '   ', cwd: tmpdir() }), { ok: false, error: 'No command specified' });
  });
}
