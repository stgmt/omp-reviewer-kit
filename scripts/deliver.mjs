#!/usr/bin/env node
// One command to move every host that runs this kit to the current release. A host is updated through
// its own versioned link — OMP's marketplace entry, Claude Code's marketplace — and repositories need
// nothing at all: their hook carries the hook *format*, not the release, so a new release leaves it
// byte-identical. That is why this script has no repository step: the absence of one is the feature.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A hook that names any release — not only this one — is the coupling this change removed, so the check
// is a shape, never a comparison with the version being delivered.
const RELEASE_MARKER = /^# omp-reviewer-kit hook v\d+\.\d+\.\d+ body-sha256:/m;

/**
 * Runs one CLI command. `absent` means the executable is not on this machine; `failed` means it is
 * there and did not answer. A broken host must never be reported as a skipped one.
 *
 * @param {(command: string, args: string[]) => string} execFile prints stdout and throws on failure
 * @param {string} command
 * @param {string[]} args
 * @returns {{ state: 'ok'|'absent'|'failed', output: string }}
 */
export function probe(execFile, command, args) {
  try {
    return { state: 'ok', output: String(execFile(command, args) ?? '').trim() };
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    const output = String(error?.stdout ?? error?.message ?? error).trim();
    return { state: code === 'ENOENT' ? 'absent' : 'failed', output };
  }
}

/**
 * @param {{
 *   version: string,
 *   template: string,
 *   execFile?: (command: string, args: string[]) => string,
 * }} options
 * @returns {Array<{ host: string, ok: boolean, detail: string }>}
 */
export function deliver({ version, template, execFile = (command, args) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  const results = [];
  const add = (host, ok, detail) => results.push({ host, ok, detail });

  // OMP: the marketplace entry carries the version, so `upgrade` moves it — scoped to this kit, because
  // an unscoped upgrade would move every unrelated marketplace plugin on the host.
  const omp = probe(execFile, 'omp', ['--version']);
  if (omp.state === 'absent') {
    add('OMP', true, 'not installed on this machine; skipped');
  } else if (omp.state === 'failed') {
    add('OMP', false, `installed but not answering: ${omp.output.split('\n')[0] || 'no output'}`);
  } else {
    const upgrade = probe(execFile, 'omp', ['plugin', 'upgrade', 'omp-reviewer-kit']);
    const listed = probe(execFile, 'omp', ['plugin', 'list']);
    const installed = listed.state === 'ok' && listed.output.includes(`omp-reviewer-kit@${version}`);
    add('OMP', upgrade.state === 'ok' && installed,
      installed ? `omp-reviewer-kit@${version}` : `${upgrade.output || 'not installed at this version'}`);
  }

  // Claude Code: `update` re-reads the marketplace, which points at the repository that tags releases.
  const claude = probe(execFile, 'claude', ['--version']);
  if (claude.state === 'absent') {
    add('Claude Code', true, 'not installed on this machine; skipped');
  } else if (claude.state === 'failed') {
    add('Claude Code', false, `installed but not answering: ${claude.output.split('\n')[0] || 'no output'}`);
  } else {
    const update = probe(execFile, 'claude', ['plugin', 'update', 'omp-reviewer-kit@omp-reviewer-kit']);
    add('Claude Code', update.state === 'ok', update.output.split('\n')[0] || 'updated');
  }

  // Repositories: nothing to do, and that is checked rather than assumed.
  const carriesRelease = RELEASE_MARKER.test(template);
  add('repository hooks', !carriesRelease, carriesRelease
    ? 'the hook template names a release; delivering one would rewrite every repository'
    : 'the hook template names the hook format only, so a release changes nothing in a repository');

  return results;
}

/**
 * The exit code of a delivery run: zero only when every host checked out.
 *
 * @param {Array<{ ok: boolean }>} results
 * @returns {0|1}
 */
export function exitCodeFor(results) {
  return results.every(result => result.ok) ? 0 : 1;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const template = readFileSync(path.join(root, 'templates', 'githooks', 'pre-commit'), 'utf8');
  const results = deliver({ version, template });
  for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.host} - ${result.detail}`);
  const failed = results.filter(result => !result.ok);
  console.log(`\ndelivered ${version}: ${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = exitCodeFor(results);
}
