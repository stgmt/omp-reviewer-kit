import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  EXIT,
  HEAL_BUDGET_MS,
  OMP_PROBE_TIMEOUT_MS,
  PLUGIN_LIST_TIMEOUT_MS,
  PROGRESS_SUMMARY_TIMEOUT_MS,
  STDIN_TIMEOUT_MS,
  assess,
  chooseOmpInstall,
  compareVersions,
  doctor,
  findPlugin,
  installOmp,
  main,
  probeOmp,
  progress,
  readHookInput,
  review,
  run,
  session,
  setup,
  shellVersion,
} from '../claude-plugin/scripts/bridge.mjs';
import { isRunnerNewer, parseRunnerVersion } from '../src/domain/runner-version.mjs';
import { syncTarget } from '../scripts/sync-targets.mjs';

const PLUGIN_DIR = process.cwd();
const WANTED = shellVersion();

// The session tests load the real plugin, whose session start stops live reviews on an older runner.
// Without its own records folder that stop reads the developer's ~/.omp/review-kit-runs.
const savedRunsDir = process.env.OMP_REVIEW_KIT_RUNS_DIR;
const isolatedRunsBase = mkdtempSync(path.join(tmpdir(), 'omp-bridge-runs-'));
process.env.OMP_REVIEW_KIT_RUNS_DIR = path.join(isolatedRunsBase, 'runs');
after(() => {
  if (savedRunsDir === undefined) delete process.env.OMP_REVIEW_KIT_RUNS_DIR;
  else process.env.OMP_REVIEW_KIT_RUNS_DIR = savedRunsDir;
  rmSync(isolatedRunsBase, { recursive: true, force: true });
});

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'omp-bridge-home-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function envFor(home, extra = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, ...extra };
  delete env.OMP_REVIEW_KIT_OMP;
  delete env.OMP_REVIEW_KIT_PLUGIN_DIR;
  delete env.OMP_REVIEW_KIT_PLUGIN_SPEC;
  return Object.assign(env, extra);
}

// Fake process runner: `handlers` map "command arg1 arg2" prefixes to results.
function fakeExec(handlers = {}) {
  const calls = [];
  const exec = (command, args = [], options = {}) => {
    const line = [path.basename(command) === command ? command : (command === process.execPath ? 'node' : command), ...args].join(' ');
    calls.push({ command, args, line, options });
    for (const [prefix, result] of Object.entries(handlers)) {
      if (line.startsWith(prefix)) {
        return { status: 0, stdout: '', stderr: '', ...(typeof result === 'function' ? result(calls) : result) };
      }
    }
    return { status: -1, stdout: '', stderr: 'not found' };
  };
  return Object.assign(exec, { calls });
}

const collect = () => {
  const lines = [];
  return { out: (line) => lines.push(String(line)), err: (line) => lines.push(String(line)), lines };
};

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-bridge-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const healthyExec = () => fakeExec({ 'omp --version': { stdout: 'omp/18.2.11\n' } });
const pluginEnv = (home) => envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: PLUGIN_DIR });

test('Given the shipped Claude shell, Then it contains only the whitelisted files in under 100 KB', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk('claude-plugin');
  let bytes = 0;
  for (const file of files) bytes += (await stat(file)).size;
  assert.deepEqual(
    files.map((file) => path.relative('claude-plugin', file).split(path.sep).join('/')).sort(),
    ['.claude-plugin/plugin.json', 'commands/doctor.md', 'commands/install-omp.md', 'commands/review.md', 'commands/setup.md', 'hooks/hooks.json', 'scripts/bridge.mjs', 'skills/review-progress/SKILL.md'],
  );
  assert.ok(bytes < 100 * 1024, `payload is ${bytes} bytes`);
  const hooks = JSON.parse(await readFile('claude-plugin/hooks/hooks.json', 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /bridge\.mjs" session$/);
  // The hook budget (seconds) must exceed the probes a session run can chain: omp --version, then plugin list.
  const budgetMs = hooks.hooks.SessionStart[0].hooks[0].timeout * 1000;
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].timeout, 30);
  const chained = STDIN_TIMEOUT_MS + OMP_PROBE_TIMEOUT_MS + PLUGIN_LIST_TIMEOUT_MS + HEAL_BUDGET_MS + PROGRESS_SUMMARY_TIMEOUT_MS;
  assert.ok(budgetMs > chained, `${budgetMs} ms must exceed the chained stdin, probe, list, heal and summary budgets (${chained} ms)`);
});

test('Given the slash commands, Then only read-only commands pre-approve node and install-omp asks the user', async () => {
  for (const name of ['review', 'setup', 'doctor']) {
    assert.match(await readFile(`claude-plugin/commands/${name}.md`, 'utf8'), /allowed-tools: Bash\(node:\*\)/);
  }
  const install = await readFile('claude-plugin/commands/install-omp.md', 'utf8');
  assert.doesNotMatch(install, /allowed-tools/);
  assert.match(install, /explicit confirmation/);
  assert.match(await readFile('claude-plugin/commands/review.md', 'utf8'), /bridge\.mjs" review/);
});

test('Version helpers order releases and sort an unparseable side lowest', () => {
  assert.ok(compareVersions('0.17.0', '0.16.9') > 0);
  assert.ok(compareVersions('0.16.0', '0.17.0') < 0);
  assert.equal(compareVersions('1.2.3', 'omp/1.2.3'), 0);
  assert.ok(compareVersions('1.0.0', 'garbage') > 0);
  assert.ok(compareVersions('garbage', '1.0.0') < 0);
});

test('assess reports a missing OMP with the install command and never touches anything', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const exec = fakeExec();
    const result = assess({ env: envFor(home), exec });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems.map((p) => p.code), ['omp-missing']);
    assert.match(result.problems[0].message, /\/omp-reviewer-kit:install-omp/);
    assert.deepEqual(exec.calls.map((c) => c.line), ['omp --version']);
  } finally {
    await cleanup();
  }
});

test('assess distinguishes a missing, an outdated and a current OMP plugin', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const missing = assess({ env: envFor(home), exec: fakeExec({ 'omp --version': { stdout: 'omp/1\n' }, 'omp plugin list': { stdout: '{"npm":[]}' } }) });
    assert.deepEqual(missing.problems.map((p) => p.code), ['plugin-missing']);

    const old = path.join(home, 'old-plugin');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.1.0' }));
    const outdated = assess({ env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: old }), exec: healthyExec() });
    assert.deepEqual(outdated.problems.map((p) => p.code), ['plugin-outdated']);
    assert.match(outdated.problems[0].message, /0\.1\.0/);

    const current = assess({ env: pluginEnv(home), exec: healthyExec() });
    assert.equal(current.ok, true);
    assert.equal(current.plugin.version, WANTED);
  } finally {
    await cleanup();
  }
});

test('findPlugin prefers an explicit dir, then the default user dir, then the omp plugin listing', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const listed = path.join(home, 'listed');
    await mkdir(listed, { recursive: true });
    await writeFile(path.join(listed, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '3.0.0' }));
    const listing = JSON.stringify({ npm: [{ name: 'other', path: PLUGIN_DIR }, { name: 'omp-reviewer-kit', path: listed }] });
    const viaList = findPlugin(envFor(home), 'omp', fakeExec({ 'omp plugin list --json': { stdout: listing } }));
    assert.equal(viaList.version, '3.0.0');

    const userDir = path.join(home, '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '2.0.0' }));
    const exec = fakeExec({ 'omp plugin list --json': { stdout: listing } });
    assert.equal(findPlugin(envFor(home), 'omp', exec).version, '2.0.0');
    assert.equal(exec.calls.length, 0, 'the default dir is found without spawning omp');

    assert.equal(findPlugin(pluginEnv(home), 'omp', exec).dir, PLUGIN_DIR);
    assert.equal(findPlugin(envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: path.join(home, 'nope') }), 'omp', fakeExec({ 'omp plugin list --json': { stdout: 'not json' } })).version, '2.0.0');
  } finally {
    await cleanup();
  }
});

test('chooseOmpInstall prefers the registry package over a remote script', () => {
  const bun = chooseOmpInstall({ exec: fakeExec({ 'bun --version': { stdout: '1.4.1' } }), platform: 'win32' });
  assert.equal(bun.display, 'bun install -g @oh-my-pi/pi-coding-agent');
  const win = chooseOmpInstall({ exec: fakeExec(), platform: 'win32' });
  assert.equal(win.command, 'powershell');
  assert.match(win.display, /irm https:\/\/omp\.sh\/install\.ps1 \| iex/);
  const posix = chooseOmpInstall({ exec: fakeExec(), platform: 'linux' });
  assert.equal(posix.display, 'curl -fsSL https://omp.sh/install | sh');
});

test('install-omp checks first: with OMP and a current plugin it installs nothing', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const exec = healthyExec();
    const sink = collect();
    const code = installOmp({ argv: ['--yes'], env: pluginEnv(home), exec, out: sink.out, err: sink.err });
    assert.equal(code, EXIT.ok);
    assert.match(sink.lines.join('\n'), /already installed \(omp\/18\.2\.11\)/);
    assert.match(sink.lines.join('\n'), /Nothing to install/);
    assert.deepEqual(exec.calls.map((c) => c.line), ['omp --version']);
  } finally {
    await cleanup();
  }
});

test('install-omp without --yes prints the plan for what is missing and changes nothing', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const exec = fakeExec({ 'bun --version': { stdout: '1.4.1' } });
    const sink = collect();
    const code = installOmp({ argv: [], env: envFor(home), exec, platform: 'linux', out: sink.out, err: sink.err });
    assert.equal(code, EXIT.ok);
    const text = sink.lines.join('\n');
    assert.match(text, /OMP: not installed/);
    assert.match(text, /1\. Install OMP: bun install -g @oh-my-pi\/pi-coding-agent/);
    assert.match(text, /2\. Install the OMP plugin: omp plugin install github:stgmt\/omp-reviewer-kit#v/);
    assert.match(text, /only after the user confirmed/);
    assert.ok(exec.calls.every((c) => /--version|plugin list/.test(c.line)), exec.calls.map((c) => c.line).join(' | '));
  } finally {
    await cleanup();
  }
});

test('install-omp with OMP present but an old plugin plans only the plugin step', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const old = path.join(home, 'old');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: '0.1.0' }));
    const sink = collect();
    const code = installOmp({ argv: [], env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: old }), exec: healthyExec(), out: sink.out, err: sink.err });
    assert.equal(code, EXIT.ok);
    const text = sink.lines.join('\n');
    assert.match(text, /older than/);
    assert.doesNotMatch(text, /Install OMP:/);
    assert.match(text, /1\. Install the OMP plugin/);
  } finally {
    await cleanup();
  }
});

test('install-omp --yes installs OMP first, then the plugin pinned to the shell version', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const pluginDir = path.join(home, 'plugin-dir');
    let ompInstalled = false;
    const exec = fakeExec({
      'bun --version': { stdout: '1.4.1' },
      'bun install -g': () => { ompInstalled = true; return {}; },
      'omp --version': () => (ompInstalled ? { stdout: 'omp/18.2.11\n' } : { status: -1 }),
      'omp plugin install': () => {
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: WANTED }));
        return {};
      },
    });
    const sink = collect();
    const env = envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: pluginDir });
    const code = installOmp({ argv: ['--yes'], env, exec, platform: 'linux', out: sink.out, err: sink.err });
    assert.equal(code, EXIT.ok, sink.lines.join('\n'));
    const order = exec.calls.map((c) => c.line);
    const bunAt = order.indexOf('bun install -g @oh-my-pi/pi-coding-agent');
    const pluginAt = order.findIndex((line) => line.startsWith('omp plugin install'));
    assert.ok(bunAt >= 0 && bunAt < pluginAt, order.join(' | '));
    assert.equal(order[pluginAt], `omp plugin install github:stgmt/omp-reviewer-kit#v${WANTED} --force`);
    assert.match(sink.lines.at(-1), /Done: OMP plugin/);
  } finally {
    await cleanup();
  }
});

test('install-omp --yes reports an infrastructure failure when the plugin install does not take effect', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const exec = fakeExec({ 'omp --version': { stdout: 'omp/18.2.11\n' }, 'omp plugin install': { status: 1 } });
    const sink = collect();
    const code = installOmp({ argv: ['--yes'], env: envFor(home), exec, out: sink.out, err: sink.err });
    assert.equal(code, EXIT.infra);
    assert.match(sink.lines.join('\n'), /is not installed after the attempt/);
  } finally {
    await cleanup();
  }
});

test('install-omp --yes never runs the installer when the installation attempt cannot produce omp', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const exec = fakeExec({ 'bun --version': { stdout: '1.4.1' }, 'bun install -g': { status: 1 } });
    const sink = collect();
    const code = installOmp({ argv: ['--yes'], env: envFor(home), exec, platform: 'linux', out: sink.out, err: sink.err });
    assert.equal(code, EXIT.infra);
    assert.match(sink.lines.join('\n'), /did not produce a working omp/);
    assert.ok(!exec.calls.some((c) => c.line.startsWith('omp plugin install')));
  } finally {
    await cleanup();
  }
});

test('install-omp --yes uses an omp found outside PATH after a successful installation', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const bin = path.join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    const known = path.join(bin, process.platform === 'win32' ? 'omp.exe' : 'omp');
    await writeFile(known, '');
    const exec = fakeExec({ 'bun --version': { stdout: '1.4.1' }, 'bun install -g': {} });
    const sink = collect();
    installOmp({ argv: ['--yes'], env: envFor(home), exec, platform: 'linux', out: sink.out, err: sink.err });
    assert.match(sink.lines.join('\n'), /not on PATH in this session/);
    const pluginCall = exec.calls.find((c) => c.args[0] === 'plugin' && c.args[1] === 'install');
    assert.equal(pluginCall.command, known);
  } finally {
    await cleanup();
  }
});

test('SessionStart stays silent when healthy and speaks once when OMP is missing', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const healthy = collect();
    await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} });
    assert.equal(await session({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: healthy.out }), EXIT.ok);
    assert.deepEqual(healthy.lines, []);

    const missing = collect();
    assert.equal(await session({ cwd: repo.dir, env: envFor(home), exec: fakeExec(), out: missing.out }), EXIT.ok);
    assert.equal(missing.lines.length, 1);
    const payload = JSON.parse(missing.lines[0]);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(payload.hookSpecificOutput.additionalContext, /install-omp/);

    const exploding = collect();
    const throwing = () => { throw new Error('boom'); };
    assert.equal(await session({ cwd: repo.dir, env: pluginEnv(home), exec: throwing, out: exploding.out }), EXIT.ok);
    assert.deepEqual(exploding.lines, [], 'a failing diagnostic never breaks the session');
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('SessionStart reports a repository without the hook and points at setup', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const sink = collect();
    await session({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out });
    assert.match(JSON.parse(sink.lines[0]).hookSpecificOutput.additionalContext, /\/omp-reviewer-kit:setup/);
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('setup installs the single hook through the OMP installer, is idempotent, and refuses a foreign hook', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const sink = collect();
    assert.equal(await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out, err: sink.err }), EXIT.ok);
    assert.equal(git(repo.dir, 'config', 'core.hooksPath').trim(), '.githooks');
    const hook = await readFile(path.join(repo.dir, '.githooks', 'pre-commit'), 'utf8');
    assert.equal(hook, await readFile('templates/githooks/pre-commit', 'utf8'));
    assert.equal(await readFile(path.join(repo.dir, '.omp', 'review-kit', 'run-review.mjs'), 'utf8'), await readFile('templates/review-kit/run-review.mjs', 'utf8'));
    assert.equal(await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out, err: sink.err }), EXIT.ok);
    assert.match(sink.lines.at(-1), /already active|active/i);
  } finally {
    await repo.cleanup();
    await cleanup();
  }

  const { home: home2, cleanup: cleanup2 } = await tempHome();
  const foreign = await tempRepo();
  try {
    await mkdir(path.join(foreign.dir, '.githooks'), { recursive: true });
    const foreignHook = '#!/bin/sh\necho foreign\n';
    await writeFile(path.join(foreign.dir, '.githooks', 'pre-commit'), foreignHook);
    git(foreign.dir, 'config', 'core.hooksPath', '.githooks');
    const sink = collect();
    assert.equal(await setup({ cwd: foreign.dir, env: pluginEnv(home2), exec: healthyExec(), out: sink.out, err: sink.err }), EXIT.fail);
    assert.equal(await readFile(path.join(foreign.dir, '.githooks', 'pre-commit'), 'utf8'), foreignHook);
  } finally {
    await foreign.cleanup();
    await cleanup2();
  }
});

test('setup stops with the infrastructure code when OMP is missing', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const sink = collect();
    assert.equal(await setup({ cwd: repo.dir, env: envFor(home), exec: fakeExec(), out: sink.out, err: sink.err }), EXIT.infra);
    await assert.rejects(stat(path.join(repo.dir, '.githooks')));
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('SessionStart shows the progress line only when the reader succeeds', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const summary = 'reviewer-kit: 1 review running in this repository';
    const readerExec = (status) => fakeExec({
      'omp --version': { stdout: 'omp/18.2.11\n' },
      node: { status, stdout: `${summary}\n` },
    });

    const reading = collect();
    assert.equal(await session({ cwd: repo.dir, env: pluginEnv(home), exec: readerExec(0), out: reading.out }), EXIT.ok);
    assert.ok(reading.lines.join('\n').includes(summary));

    const failing = collect();
    assert.equal(await session({ cwd: repo.dir, env: pluginEnv(home), exec: readerExec(1), out: failing.out }), EXIT.ok);
    assert.ok(!failing.lines.join('\n').includes(summary), 'a reader that exits non-zero contributes no line');
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('bridge.mjs routes progress to the installed reader with its arguments, and lists it in the usage line', async () => {
  const { home, cleanup } = await tempHome();
  const plugin = await mkdtemp(path.join(tmpdir(), 'omp-bridge-reader-'));
  try {
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: WANTED }));
    await mkdir(path.join(plugin, 'scripts'), { recursive: true });
    await writeFile(path.join(plugin, 'scripts', 'review-progress.mjs'), [
      'process.stdout.write(`argv:${process.argv.slice(2).join(\',\')}\\n`);',
      'process.exitCode = 2;',
    ].join('\n'));

    const routed = spawnSync(process.execPath, ['claude-plugin/scripts/bridge.mjs', 'progress', '--bogus'], {
      encoding: 'utf8',
      env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: plugin }),
    });
    assert.equal(routed.status, 2);
    assert.match(routed.stdout, /argv:--bogus/);

    const usage = spawnSync(process.execPath, ['claude-plugin/scripts/bridge.mjs', 'nonsense'], {
      encoding: 'utf8',
      env: envFor(home),
    });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /progress \[--mine/);
  } finally {
    await rm(plugin, { recursive: true, force: true });
    await cleanup();
  }
});

test('Given a newer vendored runner, setup keeps it and status marks it newer', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} });
    const runnerPath = path.join(repo.dir, '.omp', 'review-kit', 'run-review.mjs');
    const newer = '// omp-reviewer-kit runner v99.0.0\nconsole.log("newer");\n';
    await writeFile(runnerPath, newer);
    const sink = collect();
    assert.equal(await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out, err: sink.err }), EXIT.ok);
    assert.equal(await readFile(runnerPath, 'utf8'), newer);

    const { PluginInstallerService } = await import('../src/application/installer-service.mjs');
    const state = await new PluginInstallerService().status(repo.dir);
    assert.equal(state.runnerNewer, true);
    assert.equal(state.state, 'active');

    await rm(path.join(repo.dir, '.githooks', 'pre-commit'));
    assert.equal(await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out, err: sink.err }), EXIT.ok);
    assert.equal(await readFile(path.join(repo.dir, '.githooks', 'pre-commit'), 'utf8'), await readFile('templates/githooks/pre-commit', 'utf8'), 'the missing hook is repaired');
    assert.equal(await readFile(runnerPath, 'utf8'), newer, 'repairing the hook must not downgrade the newer runner');

    await writeFile(runnerPath, '// omp-reviewer-kit runner v0.0.1\nold\n');
    await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} });
    assert.equal(await readFile(runnerPath, 'utf8'), await readFile('templates/review-kit/run-review.mjs', 'utf8'), 'an older runner is replaced by the stub');
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('Given a runner newer than the installed release but older than the stub, When setup runs, Then the runner is kept', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} });
    const runnerPath = path.join(repo.dir, '.omp', 'review-kit', 'run-review.mjs');
    // One patch above the installed release: only a comparison with the release algorithm keeps it, a comparison with the stub would not.
    const [major, minor, patch] = JSON.parse(await readFile('package.json', 'utf8')).version.split('.').map(Number);
    const newer = `// omp-reviewer-kit runner v${major}.${minor}.${patch + 1}\nconsole.log("newer patch");\n`;
    await writeFile(runnerPath, newer);
    assert.equal(await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} }), EXIT.ok);
    assert.equal(await readFile(runnerPath, 'utf8'), newer, 'a runner newer than the installed release is never replaced');
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('review executes the repository runner (the file the hook runs) and passes the exit code through', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const sink = collect();
    for (const [nodeStatus, expected] of [[0, EXIT.ok], [1, EXIT.fail]]) {
      const exec = fakeExec({ 'omp --version': { stdout: 'omp/18.2.11\n' }, node: { status: nodeStatus } });
      const code = await review({ cwd: repo.dir, env: pluginEnv(home), exec, err: sink.err });
      assert.equal(code, expected);
      const nodeCall = exec.calls.find((c) => c.command === process.execPath);
      // git reports the long form of 8.3 short temp paths on Windows runners
      assert.equal(realpathSync.native(nodeCall.args[0]), realpathSync.native(path.join(repo.dir, '.omp', 'review-kit', 'run-review.mjs')));
      assert.equal(nodeCall.options.inherit, true);
      assert.equal(nodeCall.options.cwd, repo.dir);
    }
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('review refuses to run without OMP and never starts the runner', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    const exec = fakeExec();
    const sink = collect();
    assert.equal(await review({ cwd: repo.dir, env: envFor(home), exec, err: sink.err }), EXIT.infra);
    assert.ok(!exec.calls.some((c) => c.command === process.execPath));
    assert.match(sink.lines.join('\n'), /install-omp/);
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('doctor fails with the infrastructure code and an actionable line when OMP is missing', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const sink = collect();
    const code = await doctor({ cwd: PLUGIN_DIR, env: envFor(home), exec: fakeExec(), out: sink.out });
    assert.equal(code, EXIT.infra);
    assert.match(sink.lines.join('\n'), /\[FAIL\] OMP \(omp\) is not installed/);
  } finally {
    await cleanup();
  }
});

test('The bridge CLI prints the install plan for a bare machine without executing anything', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const result = spawnSync(process.execPath, ['claude-plugin/scripts/bridge.mjs', 'install-omp'], {
      encoding: 'utf8',
      env: envFor(home, { OMP_REVIEW_KIT_OMP: path.join(home, 'no-such-omp') }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan \(nothing was changed\)/);
    assert.match(result.stdout, /Install OMP:/);
  } finally {
    await cleanup();
  }
});

test('Runner version markers: newer wins, equal or older does not, a missing marker never protects', () => {
  const v = (n) => `// omp-reviewer-kit runner v${n}\nbody\n`;
  assert.deepEqual(parseRunnerVersion(v('1.2.3')), [1, 2, 3]);
  assert.deepEqual(parseRunnerVersion(v('1.2.3').replace('\n', '\r\n')), [1, 2, 3]);
  assert.equal(parseRunnerVersion('// stale runner v0.0.1\n'), null);
  assert.equal(isRunnerNewer(v('0.17.1'), v('0.17.0')), true);
  assert.equal(isRunnerNewer(v('0.17.0'), v('0.17.0')), false);
  assert.equal(isRunnerNewer(v('0.16.9'), v('0.17.0')), false);
  assert.equal(isRunnerNewer(v('1.0.0'), v('0.99.99')), true);
  assert.equal(isRunnerNewer('no marker', v('0.17.0')), false);
  assert.equal(isRunnerNewer(v('0.1.0'), 'canonical without marker'), true);
});

async function foreignHookRepo() {
  const repo = await tempRepo();
  await mkdir(path.join(repo.dir, '.githooks'), { recursive: true });
  await writeFile(path.join(repo.dir, '.githooks', 'pre-commit'), '#!/bin/sh\necho foreign\n');
  git(repo.dir, 'config', 'core.hooksPath', '.githooks');
  return repo;
}

test('SessionStart names a hook conflict together with its reason', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await foreignHookRepo();
  try {
    const sink = collect();
    await session({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out });
    assert.equal(sink.lines.length, 1);
    const context = JSON.parse(sink.lines[0]).hookSpecificOutput.additionalContext;
    assert.match(context, /Review hook conflict: .*pre-commit/);
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('SessionStart repairs a stale vendored runner instead of only reporting it', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} });
    const runner = path.join(repo.dir, '.omp', 'review-kit', 'run-review.mjs');
    await writeFile(runner, '// omp-reviewer-kit runner v0.0.1\nold\n');
    const sink = collect();
    await session({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out });
    assert.deepEqual(sink.lines, [], 'a repaired repository is silent');
    assert.equal(await readFile(runner, 'utf8'), await readFile(path.join(PLUGIN_DIR, 'templates', 'review-kit', 'run-review.mjs'), 'utf8'));
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('SessionStart asks the plugin to refresh registered repositories within the heal budget, and tolerates a plugin without that method', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const refreshing = await stubPlugin(home, `export class PluginInstallerService {
      async refreshAtSessionStart(cwd, options) { (globalThis.__refreshCalls ??= []).push({ cwd, options }); throw new Error('a failing refresh must not break the session'); }
      async status() { return { isGitRepo: true, state: 'stale' }; }
    }\n`);
    globalThis.__refreshCalls = [];
    const sink = collect();
    assert.equal(await session({ cwd: home, env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: refreshing }), exec: healthyExec(), out: sink.out }), EXIT.ok);
    assert.deepEqual(globalThis.__refreshCalls, [{ cwd: home, options: { budgetMs: HEAL_BUDGET_MS } }]);
    assert.match(JSON.parse(sink.lines[0]).hookSpecificOutput.additionalContext, /stale/, 'the diagnosis still runs after a failed refresh');

    const old = path.join(home, 'old-plugin');
    await mkdir(path.join(old, 'src', 'application'), { recursive: true });
    await writeFile(path.join(old, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: WANTED }));
    await writeFile(path.join(old, 'src', 'application', 'installer-service.mjs'), "export class PluginInstallerService { async status() { return { isGitRepo: true, state: 'stale' }; } }\n");
    const legacy = collect();
    assert.equal(await session({ cwd: home, env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: old }), exec: healthyExec(), out: legacy.out }), EXIT.ok);
    assert.match(JSON.parse(legacy.lines[0]).hookSpecificOutput.additionalContext, /stale/);
  } finally {
    delete globalThis.__refreshCalls;
    await cleanup();
  }
});

test('review falls back to the OMP plugin runner when the repository has none, keeping the exit mapping', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await foreignHookRepo();
  try {
    for (const [nodeStatus, expected] of [[0, EXIT.ok], [1, EXIT.fail]]) {
      const exec = fakeExec({ 'omp --version': { stdout: 'omp/18.2.11\n' }, node: { status: nodeStatus } });
      const sink = collect();
      const code = await review({ cwd: repo.dir, env: pluginEnv(home), exec, err: sink.err });
      assert.equal(code, expected);
      const nodeCall = exec.calls.find((c) => c.command === process.execPath);
      assert.equal(nodeCall.args[0], path.join(PLUGIN_DIR, 'scripts', 'run-review.mjs'));
      assert.match(sink.lines.join('\n'), /no vendored runner/);
    }
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('doctor warns when the repository runner is newer than the installed OMP plugin', async () => {
  const { home, cleanup } = await tempHome();
  const repo = await tempRepo();
  try {
    await setup({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: () => {}, err: () => {} });
    await writeFile(path.join(repo.dir, '.omp', 'review-kit', 'run-review.mjs'), '// omp-reviewer-kit runner v99.0.0\nnewer\n');
    const sink = collect();
    const code = await doctor({ cwd: repo.dir, env: pluginEnv(home), exec: healthyExec(), out: sink.out });
    assert.equal(code, EXIT.ok);
    assert.match(sink.lines.join('\n'), /\[WARN\] The repository runner is newer than the installed OMP plugin/);
  } finally {
    await repo.cleanup();
    await cleanup();
  }
});

test('SessionStart adds one line naming the runs the plugin stopped, and says nothing about them when none was stopped', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const stopping = await stubPlugin(home, `export class PluginInstallerService {
      async refreshAtSessionStart() { return { current: null, targets: {}, stopped: [{ runId: 'run-old-1' }, { runId: 'run-old-2' }] }; }
      async status() { return { isGitRepo: true, state: 'active' }; }
    }\n`);
    const sink = collect();
    assert.equal(await session({ cwd: home, env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: stopping }), exec: healthyExec(), out: sink.out }), EXIT.ok);
    assert.equal(sink.lines.length, 1);
    const context = JSON.parse(sink.lines[0]).hookSpecificOutput.additionalContext;
    assert.match(context, /Stopped 2 review\(s\) running on an older runner: run-old-1, run-old-2\./);
    assert.match(context, /commits were blocked; commit again to review on this runner/);

    const quiet = await stubPlugin(home, `export class PluginInstallerService {
      async refreshAtSessionStart() { return { current: null, targets: {}, stopped: [] }; }
      async status() { return { isGitRepo: true, state: 'active' }; }
    }\n`);
    const silent = collect();
    assert.equal(await session({ cwd: home, env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: quiet }), exec: healthyExec(), out: silent.out }), EXIT.ok);
    assert.deepEqual(silent.lines, [], 'nothing stopped and nothing wrong: the hook stays silent');

    const malformed = await stubPlugin(home, `export class PluginInstallerService {
      async refreshAtSessionStart() { return { stopped: 'not a list' }; }
      async status() { return { isGitRepo: true, state: 'active' }; }
    }\n`);
    const ignored = collect();
    assert.equal(await session({ cwd: home, env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: malformed }), exec: healthyExec(), out: ignored.out }), EXIT.ok);
    assert.deepEqual(ignored.lines, []);
  } finally {
    await cleanup();
  }
});

let stubCounter = 0;

async function stubPlugin(home, installerSource) {
  // A fresh folder per call: the ESM loader caches a module by URL, so a reused path keeps the first stub.
  const dir = path.join(home, `stub-plugin-${(stubCounter += 1)}`);
  await mkdir(path.join(dir, 'src', 'application'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'infra'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'omp-reviewer-kit', version: WANTED }));
  await writeFile(
    path.join(dir, 'src', 'application', 'installer-service.mjs'),
    installerSource ?? 'export class PluginInstallerService { async doctor() { return { ok: true, checks: [] }; } async status() { return { isGitRepo: false }; } }\n',
  );
  await writeFile(
    path.join(dir, 'src', 'infra', 'omp-cli-reviewer-adapter.mjs'),
    'export class OmpCliReviewerAdapter { static defaultPreflight() { return globalThis.__bridgeProbe(); } }\n',
  );
  return dir;
}

test('doctor --probe sends one model request and passes only on status 0 with READY', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const dir = await stubPlugin(home);
    const env = envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: dir });
    const cases = [
      [{ status: 0, stdout: 'READY' }, EXIT.ok, /\[OK\] OMP answered a model request\./],
      [{ status: 1, stdout: '' }, EXIT.fail, /\[FAIL\] .*modelRoles/],
      [{ status: 0, stdout: 'nope' }, EXIT.fail, /\[FAIL\] .*modelRoles/],
      [{ status: 1, stdout: 'READY' }, EXIT.fail, /\[FAIL\] .*modelRoles/],
    ];
    for (const [probe, expectedCode, expectedLine] of cases) {
      let calls = 0;
      globalThis.__bridgeProbe = () => { calls += 1; return probe; };
      const sink = collect();
      const code = await doctor({ cwd: home, argv: ['--probe'], env, exec: healthyExec(), out: sink.out });
      assert.equal(calls, 1, 'exactly one model request');
      assert.equal(code, expectedCode, JSON.stringify(probe));
      assert.match(sink.lines.join('\n'), expectedLine);
    }
    globalThis.__bridgeProbe = () => { throw new Error('must not be called without --probe'); };
    assert.equal(await doctor({ cwd: home, argv: [], env, exec: healthyExec(), out: () => {} }), EXIT.ok);
  } finally {
    delete globalThis.__bridgeProbe;
    await cleanup();
  }
});

test('install-omp prints the pinned plugin tag by default and honours OMP_REVIEW_KIT_PLUGIN_SPEC', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const plain = collect();
    installOmp({ argv: [], env: envFor(home), exec: healthyExec(), out: plain.out, err: plain.err });
    assert.match(plain.lines.join('\n'), new RegExp(`omp plugin install github:stgmt/omp-reviewer-kit#v${WANTED.replace(/[.]/g, '[.]')} --force`));

    const custom = collect();
    installOmp({ argv: [], env: envFor(home, { OMP_REVIEW_KIT_PLUGIN_SPEC: 'file:/tmp/kit' }), exec: healthyExec(), out: custom.out, err: custom.err });
    assert.match(custom.lines.join('\n'), /omp plugin install file:\/tmp\/kit --force/);
    assert.doesNotMatch(custom.lines.join('\n'), /#v/);
  } finally {
    await cleanup();
  }
});

test('The bridge CLI rejects an unknown command with a usage line', () => {
  const result = spawnSync(process.execPath, ['claude-plugin/scripts/bridge.mjs', 'frobnicate'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: bridge\.mjs/);
});

test('main turns an unexpected failure into a failure exit and a stderr line', async () => {
  const { home, cleanup } = await tempHome();
  const originalError = console.error;
  const captured = [];
  try {
    const dir = await stubPlugin(home, 'export class PluginInstallerService {{ syntax error\n');
    // node itself answers `--version`, so the OMP probe succeeds and the broken installer is reached.
    const env = envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: dir, OMP_REVIEW_KIT_OMP: process.execPath });
    console.error = (line) => captured.push(String(line));
    const code = await main(['review'], env, home);
    assert.equal(code, EXIT.fail);
    assert.equal(captured.length, 1);
    assert.ok(captured[0].length > 0);
  } finally {
    console.error = originalError;
    await cleanup();
  }
});

test('probeOmp needs a non-empty answer and honours OMP_REVIEW_KIT_OMP', () => {
  const blank = probeOmp({ OMP_REVIEW_KIT_OMP: '' }, fakeExec({ omp: { stdout: '  \n' } }));
  assert.equal(blank.found, false);
  const exec = fakeExec({ '/custom/omp': { stdout: 'omp/9.9.9\n' } });
  const custom = probeOmp({ OMP_REVIEW_KIT_OMP: '/custom/omp' }, exec);
  assert.deepEqual({ found: custom.found, command: custom.command, version: custom.version }, { found: true, command: '/custom/omp', version: 'omp/9.9.9' });
  assert.equal(exec.calls[0].command, '/custom/omp');
});

test('findPlugin ignores a directory whose package.json has another name or cannot be parsed', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const other = path.join(home, 'other');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }));
    assert.equal(findPlugin(envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: other }), 'omp', fakeExec()), null);
    const broken = path.join(home, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'package.json'), '{ not json');
    assert.equal(findPlugin(envFor(home, { OMP_REVIEW_KIT_PLUGIN_DIR: broken }), 'omp', fakeExec()), null);
  } finally {
    await cleanup();
  }
});

test('run wraps a .cmd file through the shell on Windows and passes status and output through', { skip: process.platform !== 'win32' }, async () => {
  const { home, cleanup } = await tempHome();
  try {
    const spaced = path.join(home, 'with space');
    await mkdir(spaced, { recursive: true });
    const script = path.join(spaced, 'fake omp.cmd');
    await writeFile(script, '@echo off\r\necho hello %1\r\nexit /b 3\r\n');
    const result = run(script, ['arg']);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /hello arg/);
  } finally {
    await cleanup();
  }
});

test('The installer status of a directory outside Git is not a repository and carries no newer runner', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { PluginInstallerService } = await import('../src/application/installer-service.mjs');
    const state = await new PluginInstallerService().status(home);
    assert.equal(state.isGitRepo, false);
    assert.equal(state.runnerNewer, false);
  } finally {
    await cleanup();
  }
});

test('sync-targets never rolls a newer vendored runner back', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'omp-sync-newer-'));
  try {
    await mkdir(path.join(repo, '.git'));
    await mkdir(path.join(repo, '.omp', 'review-kit'), { recursive: true });
    const target = path.join(repo, '.omp', 'review-kit', 'run-review.mjs');
    const newer = '// omp-reviewer-kit runner v99.0.0\nnewer\n';
    await writeFile(target, newer);
    const applied = await syncTarget(repo, { apply: true });
    assert.equal(applied.files[0].state, 'newer');
    assert.equal(await readFile(target, 'utf8'), newer);
    assert.equal(applied.files[1].state, 'updated');
    assert.equal(applied.status, 'synced');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
