#!/usr/bin/env node
// Claude Code shell for omp-reviewer-kit. It owns no review logic: the runner,
// the hook installer and the hook template all come from the OMP plugin, so
// the git hook of a repository has exactly one owner (PluginInstallerService).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'omp-reviewer-kit';
const PLUGIN_REPO = 'github:stgmt/omp-reviewer-kit';
const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
export const EXIT = Object.freeze({ ok: 0, fail: 1, infra: 2 });
// The SessionStart hook budget in hooks.json must cover both probes it can run in sequence.
export const OMP_PROBE_TIMEOUT_MS = 5000;
export const PLUGIN_LIST_TIMEOUT_MS = 15000;

const SETUP_HINT = 'Run /omp-reviewer-kit:install-omp.';

export function shellVersion(root = SHELL_ROOT) {
  return JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @returns {number} negative, zero or positive; an unparseable side sorts lowest */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

const homeOf = (env) => env.USERPROFILE || env.HOME || os.homedir();
const ompCommandOf = (env) => env.OMP_REVIEW_KIT_OMP || 'omp';

export function run(command, args, { cwd, timeout, env, inherit = false } = {}) {
  const wrapper = process.platform === 'win32' && /[.](cmd|bat)$/i.test(command);
  const exec = wrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const execArgs = wrapper ? ['/d', '/c', 'call', command, ...args] : args;
  const result = spawnSync(exec, execArgs, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    stdio: inherit ? 'inherit' : 'pipe',
  });
  return { status: result.status ?? (result.error ? -1 : 1), stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function knownOmpLocations(env) {
  const home = homeOf(env);
  const names = process.platform === 'win32' ? ['omp.exe', 'omp.cmd'] : ['omp'];
  return [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')]
    .flatMap((dir) => names.map((name) => path.join(dir, name)))
    .filter((file) => existsSync(file));
}

export function probeOmp(env = process.env, exec = run) {
  const command = ompCommandOf(env);
  const result = exec(command, ['--version'], { timeout: OMP_PROBE_TIMEOUT_MS, env });
  if (result.status === 0 && result.stdout.trim()) {
    return { found: true, command, version: result.stdout.trim() };
  }
  return { found: false, command, version: null };
}

function readPluginDir(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.name === PLUGIN_NAME && pkg.version ? { dir, version: String(pkg.version) } : null;
  } catch {
    return null;
  }
}

/** Locates the installed OMP plugin: explicit dir, default user dir, then `omp plugin list --json`. */
export function findPlugin(env = process.env, ompCommand = ompCommandOf(env), exec = run) {
  const direct = [env.OMP_REVIEW_KIT_PLUGIN_DIR, path.join(homeOf(env), '.omp', 'plugins', 'node_modules', PLUGIN_NAME)]
    .filter(Boolean);
  for (const dir of direct) {
    const found = readPluginDir(dir);
    if (found) return found;
  }
  const listed = exec(ompCommand, ['plugin', 'list', '--json'], { timeout: PLUGIN_LIST_TIMEOUT_MS, env });
  if (listed.status !== 0) return null;
  try {
    const parsed = JSON.parse(listed.stdout);
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
    for (const entry of entries) {
      if (entry && entry.name === PLUGIN_NAME && entry.path) {
        const found = readPluginDir(entry.path);
        if (found) return found;
      }
    }
  } catch {
    // unparseable listing: treated as not installed
  }
  return null;
}

/** Checks everything the shell needs from OMP. Never installs or changes anything. */
export function assess({ env = process.env, exec = run, root = SHELL_ROOT } = {}) {
  const wanted = shellVersion(root);
  const omp = probeOmp(env, exec);
  const problems = [];
  let plugin = null;
  if (!omp.found) {
    problems.push({
      code: 'omp-missing',
      message: `OMP (omp) is not installed or not on PATH; the review runs on OMP. ${SETUP_HINT}`,
    });
  } else {
    plugin = findPlugin(env, omp.command, exec);
    if (!plugin) {
      problems.push({ code: 'plugin-missing', message: `The OMP plugin ${PLUGIN_NAME} is not installed. ${SETUP_HINT}` });
    } else if (compareVersions(plugin.version, wanted) < 0) {
      problems.push({
        code: 'plugin-outdated',
        message: `OMP plugin ${PLUGIN_NAME} ${plugin.version} is older than this Claude plugin (${wanted}). ${SETUP_HINT}`,
      });
    }
  }
  return { omp, plugin, wanted, problems, ok: problems.length === 0 };
}

async function loadInstaller(plugin) {
  const url = pathToFileURL(path.join(plugin.dir, 'src', 'application', 'installer-service.mjs')).href;
  const mod = await import(url);
  return new mod.PluginInstallerService();
}

function repoProblem(status) {
  if (!status.isGitRepo) return null;
  if (status.state === 'conflict') return `Review hook conflict: ${status.conflictReason}`;
  if (status.state === 'inactive') return 'The review hook is not installed in this repository. Run /omp-reviewer-kit:setup.';
  if (status.state === 'stale') return 'The review hook or runner in this repository is stale. Run /omp-reviewer-kit:setup.';
  return null;
}

async function collectProblems(cwd, assessment) {
  const messages = assessment.problems.map((p) => p.message);
  if (assessment.ok) {
    const installer = await loadInstaller(assessment.plugin);
    const message = repoProblem(await installer.status(cwd));
    if (message) messages.push(message);
  }
  return messages;
}

/** SessionStart hook: silent when healthy, one context message otherwise. Never fails the session. */
export async function session({ cwd, env = process.env, exec = run, root = SHELL_ROOT, out = console.log } = {}) {
  try {
    const messages = await collectProblems(cwd, assess({ env, exec, root }));
    if (messages.length) {
      out(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `omp-reviewer-kit: ${messages.join(' ')}`,
        },
      }));
    }
  } catch {
    // a diagnostic hook must never break the session
  }
  return EXIT.ok;
}

export async function setup({ cwd, env = process.env, exec = run, root = SHELL_ROOT, out = console.log, err = console.error } = {}) {
  const assessment = assess({ env, exec, root });
  if (!assessment.ok) {
    for (const problem of assessment.problems) err(problem.message);
    return EXIT.infra;
  }
  const installer = await loadInstaller(assessment.plugin);
  let result;
  try {
    result = await installer.setup(cwd);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return EXIT.fail;
  }
  (result.success ? out : err)(result.message);
  return result.success ? EXIT.ok : EXIT.fail;
}

export async function review({ cwd, env = process.env, exec = run, root = SHELL_ROOT, err = console.error } = {}) {
  const assessment = assess({ env, exec, root });
  if (!assessment.ok) {
    for (const problem of assessment.problems) err(problem.message);
    return EXIT.infra;
  }
  const installer = await loadInstaller(assessment.plugin);
  let repoRoot;
  try {
    const result = await installer.setup(cwd);
    repoRoot = result.repoRoot;
    if (!result.success) err(`setup: ${result.message}`);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return EXIT.fail;
  }
  // The same file the git hook executes, so /review and the commit agree on the runner version.
  const repoRunner = path.join(repoRoot, '.omp', 'review-kit', 'run-review.mjs');
  let runner = repoRunner;
  if (!existsSync(repoRunner)) {
    runner = path.join(assessment.plugin.dir, 'scripts', 'run-review.mjs');
    err('The repository has no vendored runner (hook not installed); using the OMP plugin runner directly.');
  }
  const result = exec(process.execPath, [runner], { cwd, env, inherit: true });
  return result.status === 0 ? EXIT.ok : EXIT.fail;
}

export async function doctor({ cwd, argv = [], env = process.env, exec = run, root = SHELL_ROOT, out = console.log } = {}) {
  const assessment = assess({ env, exec, root });
  const lines = [];
  lines.push({ status: 'OK', text: `Claude plugin ${assessment.wanted}` });
  for (const problem of assessment.problems) lines.push({ status: 'FAIL', text: problem.message });
  if (assessment.ok) {
    lines.push({ status: 'OK', text: `OMP ${assessment.omp.version}; plugin ${assessment.plugin.version}` });
    const installer = await loadInstaller(assessment.plugin);
    const report = await installer.doctor(cwd);
    for (const check of report.checks) lines.push({ status: check.status, text: `${check.name}: ${check.message}` });
    const state = await installer.status(cwd);
    if (state.isGitRepo && state.runnerNewer) {
      lines.push({ status: 'WARN', text: 'The repository runner is newer than the installed OMP plugin; it is kept as is.' });
    }
    if (argv.includes('--probe')) {
      const adapter = await import(pathToFileURL(path.join(assessment.plugin.dir, 'src', 'infra', 'omp-cli-reviewer-adapter.mjs')).href);
      const probe = await adapter.OmpCliReviewerAdapter.defaultPreflight(cwd, 90000);
      const ok = probe.status === 0 && /READY/.test(probe.stdout ?? '');
      lines.push({
        status: ok ? 'OK' : 'FAIL',
        text: ok
          ? 'OMP answered a model request.'
          : 'OMP could not get an answer from its default model; check the login and modelRoles / retry.fallbackChains in ~/.omp/agent/config.yml.',
      });
    }
  }
  for (const line of lines) out(`[${line.status}] ${line.text}`);
  const failed = lines.some((line) => line.status === 'FAIL');
  return failed ? (assessment.ok ? EXIT.fail : EXIT.infra) : EXIT.ok;
}

/** How OMP would be installed on this machine, preferring the registry package over a remote script. */
export function chooseOmpInstall({ env = process.env, exec = run, platform = process.platform } = {}) {
  if (exec('bun', ['--version'], { timeout: OMP_PROBE_TIMEOUT_MS, env }).status === 0) {
    return { label: 'bun', command: 'bun', args: ['install', '-g', OMP_PACKAGE], display: `bun install -g ${OMP_PACKAGE}` };
  }
  if (platform === 'win32') {
    const script = 'irm https://omp.sh/install.ps1 | iex';
    return { label: 'powershell', command: 'powershell', args: ['-NoProfile', '-Command', script], display: `powershell -NoProfile -Command "${script}"` };
  }
  const script = 'curl -fsSL https://omp.sh/install | sh';
  return { label: 'curl', command: 'sh', args: ['-c', script], display: script };
}

export function pluginSpec(env, root = SHELL_ROOT) {
  return env.OMP_REVIEW_KIT_PLUGIN_SPEC || `${PLUGIN_REPO}#v${shellVersion(root)}`;
}

/**
 * Checks what is already installed, then installs only what is missing. Without --yes it
 * prints the plan and changes nothing; the slash command carries no tool pre-approval so
 * Claude Code asks the user before the --yes run.
 */
export function installOmp({ argv = [], env = process.env, exec = run, root = SHELL_ROOT, platform = process.platform, out = console.log, err = console.error } = {}) {
  const confirmed = argv.includes('--yes');
  const wanted = shellVersion(root);
  let omp = probeOmp(env, exec);
  let plugin = omp.found ? findPlugin(env, omp.command, exec) : null;
  const ompMissing = !omp.found;
  const pluginOk = Boolean(plugin) && compareVersions(plugin.version, wanted) >= 0;

  out(`OMP: ${omp.found ? `already installed (${omp.version})` : 'not installed'}`);
  out(`OMP plugin ${PLUGIN_NAME}: ${plugin ? `${plugin.version}${pluginOk ? ' (up to date)' : ` (older than ${wanted})`}` : 'not installed'}`);
  if (!ompMissing && pluginOk) {
    out('Nothing to install. Next: /omp-reviewer-kit:setup, then make sure OMP has a working login and model.');
    return EXIT.ok;
  }

  const method = ompMissing ? chooseOmpInstall({ env, exec, platform }) : null;
  const spec = pluginSpec(env, root);
  if (!confirmed) {
    out('Plan (nothing was changed):');
    if (method) out(`  1. Install OMP: ${method.display}`);
    out(`  ${method ? '2' : '1'}. Install the OMP plugin: omp plugin install ${spec} --force`);
    out('Re-run with --yes only after the user confirmed this plan.');
    return EXIT.ok;
  }

  if (method) {
    out(`Installing OMP: ${method.display}`);
    const installed = exec(method.command, method.args, { env, inherit: true });
    omp = probeOmp(env, exec);
    if (!omp.found) {
      const known = knownOmpLocations(env)[0];
      if (installed.status === 0 && known) {
        omp = { found: true, command: known, version: 'installed' };
        out(`OMP was installed at ${known} but is not on PATH in this session; restart the terminal afterwards.`);
      } else {
        err('OMP installation did not produce a working omp executable. Install it manually and re-run.');
        return EXIT.infra;
      }
    }
  }

  out(`Installing the OMP plugin: omp plugin install ${spec} --force`);
  const result = exec(omp.command, ['plugin', 'install', spec, '--force'], { env, inherit: true });
  plugin = result.status === 0 ? findPlugin(env, omp.command, exec) : null;
  if (!plugin || compareVersions(plugin.version, wanted) < 0) {
    err(`The OMP plugin ${PLUGIN_NAME} >= ${wanted} is not installed after the attempt.`);
    return EXIT.infra;
  }
  out(`Done: OMP plugin ${plugin.version}. Next: log in and configure a model in OMP (run omp once), then /omp-reviewer-kit:setup.`);
  return EXIT.ok;
}

export async function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  try {
    return await dispatch(command, rest, env, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.fail;
  }
}

async function dispatch(command, rest, env, cwd) {
  switch (command) {
    case 'session': return session({ cwd, env });
    case 'setup': return setup({ cwd, env });
    case 'review': return review({ cwd, env });
    case 'doctor': return doctor({ cwd, env, argv: rest });
    case 'install-omp': return installOmp({ argv: rest, env });
    default:
      console.error('usage: bridge.mjs <session|setup|review|doctor [--probe]|install-omp [--yes]>');
      return EXIT.fail;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
