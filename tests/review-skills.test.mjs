import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OmpCliReviewerAdapter } from '../src/infra/omp-cli-reviewer-adapter.mjs';

const prompt = 'review this staged change';
const cwd = process.cwd();
const isWindows = process.platform === 'win32';
const testRoleResolver = () => ({ smol: 'acme/smol-flash:high' });
const result = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });

const PLUGIN_SKILLS = 'multi-stage-review,reality-first-review,range-audit,slop';
const DEFAULT_SKILLS_ARG = `--skills=${PLUGIN_SKILLS},*reviewer-kit*,*review-kit*`;

async function captureSpawnArgs(skillsEnv) {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-skills-args-'));
  const commandPath = path.join(baseDir, isWindows ? 'fake-omp.cmd' : 'fake-omp.sh');
  const argsPath = path.join(baseDir, 'args.txt');
  const command = isWindows
    ? '@echo off\n> "%OMP_REVIEW_TEST_ARGS%" echo %*\necho REVIEW_RESULT=PASS\nexit /b 0\n'
    : '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_REVIEW_TEST_ARGS"\nprintf "REVIEW_RESULT=PASS\\n"\n';
  const previous = {
    command: process.env.OMP_REVIEW_KIT_OMP,
    args: process.env.OMP_REVIEW_TEST_ARGS,
    skills: process.env.OMP_REVIEW_KIT_SKILLS,
  };
  process.env.OMP_REVIEW_KIT_OMP = commandPath;
  process.env.OMP_REVIEW_TEST_ARGS = argsPath;
  if (skillsEnv === undefined) delete process.env.OMP_REVIEW_KIT_SKILLS;
  else process.env.OMP_REVIEW_KIT_SKILLS = skillsEnv;
  try {
    await writeFile(commandPath, command, 'utf8');
    if (!isWindows) await chmod(commandPath, 0o755);
    const review = await OmpCliReviewerAdapter.defaultRunner('probe', cwd, 0);
    assert.equal(review.status, 0, review.stderr);
    return (await readFile(argsPath, 'utf8')).split(/\s+/).filter(Boolean);
  } finally {
    for (const [key, name] of [['command', 'OMP_REVIEW_KIT_OMP'], ['args', 'OMP_REVIEW_TEST_ARGS'], ['skills', 'OMP_REVIEW_KIT_SKILLS']]) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
    await rm(baseDir, { recursive: true, force: true });
  }
}

const skillsArgOf = (args) => args.find((arg) => arg.startsWith('--skills='));

test('review child lists the plugin skills and plugin-named skills by default', async () => {
  const args = await captureSpawnArgs(undefined);

  assert.ok(args.includes(DEFAULT_SKILLS_ARG), args.join(' '));
  assert.ok(!args.includes('--no-skills'));
});

test('OMP_REVIEW_KIT_SKILLS=all restores the full skill catalog in any case and position', async () => {
  for (const value of ['all', 'ALL', ' All ', 'all,custom-*', 'custom-*, ALL']) {
    const args = await captureSpawnArgs(value);

    assert.equal(skillsArgOf(args), undefined, `value: ${value}\n${args.join(' ')}`);
    assert.ok(!args.includes('--no-skills'), `value: ${value}`);
  }
});

test('OMP_REVIEW_KIT_SKILLS adds custom patterns to the plugin skills without duplicates', async () => {
  const args = await captureSpawnArgs(' team-rules-*, payments-domain ,slop,*review* ');

  assert.equal(skillsArgOf(args), `--skills=${PLUGIN_SKILLS},team-rules-*,payments-domain,*review*`, args.join(' '));
});

test('no OMP_REVIEW_KIT_SKILLS value can hide the plugin protocol skills or disable skill discovery', async () => {
  for (const value of [undefined, '', 'none', 'None', 'none,x', 'x', 'nothing-matches-*', 'foo bar', 'a;b', '$(id)', ',,']) {
    const args = await captureSpawnArgs(value);
    const skillsArg = skillsArgOf(args);

    assert.ok(skillsArg, `value: ${String(value)}\n${args.join(' ')}`);
    assert.ok(skillsArg.startsWith(`--skills=${PLUGIN_SKILLS}`), `value: ${String(value)}\n${skillsArg}`);
    assert.ok(!args.includes('--no-skills'), `value: ${String(value)}`);
  }
});

test('an invalid OMP_REVIEW_KIT_SKILLS list falls back to the default patterns', async () => {
  for (const value of ['foo bar', 'a;b', '$(id)', ',,', 'a,b c']) {
    const args = await captureSpawnArgs(value);

    assert.ok(args.includes(DEFAULT_SKILLS_ARG), `value: ${value}\n${args.join(' ')}`);
  }
});

test('review_chain telemetry records the effective skills selection', async () => {
  const previous = process.env.OMP_REVIEW_KIT_SKILLS;
  try {
    for (const [env, expected] of [
      [undefined, `${PLUGIN_SKILLS},*reviewer-kit*,*review-kit*`],
      ['ALL', 'all'],
      ['team-*', `${PLUGIN_SKILLS},team-*`],
    ]) {
      if (env === undefined) delete process.env.OMP_REVIEW_KIT_SKILLS;
      else process.env.OMP_REVIEW_KIT_SKILLS = env;
      const events = [];
      const telemetry = {
        record: async (type, payload) => events.push({ type, payload }),
        updateLastRun: async () => {},
      };
      const adapter = new OmpCliReviewerAdapter({
        runner: async () => result(0, 'REVIEW_RESULT=PASS\n'),
      });

      await adapter.executeReview({ prompt, cwd, telemetry });

      assert.equal(events.find((e) => e.type === 'review_chain').payload.skills, expected);
    }
  } finally {
    if (previous === undefined) delete process.env.OMP_REVIEW_KIT_SKILLS;
    else process.env.OMP_REVIEW_KIT_SKILLS = previous;
  }
});

test('the distributable runner mirrors the adapter skills selection verbatim', async () => {
  const blockOf = (source) => source
    .replace(/\r\n/g, '\n')
    .match(/const REVIEW_PLUGIN_SKILLS[\s\S]*?\nfunction reviewSkillsSelection\(\) \{[\s\S]*?\n\}\n/)?.[0];
  const adapterBlock = blockOf(await readFile('src/infra/omp-cli-reviewer-adapter.mjs', 'utf8'));
  const runnerBlock = blockOf(await readFile('scripts/run-review.mjs', 'utf8'));

  assert.ok(adapterBlock, 'adapter skills block not found');
  assert.equal(runnerBlock, adapterBlock);
});

test('the review child never receives model flags, whatever the legacy model env says', async () => {
  const saved = { model: process.env.OMP_REVIEW_KIT_MODEL, effort: process.env.OMP_REVIEW_KIT_EFFORT };
  process.env.OMP_REVIEW_KIT_MODEL = '@slow';
  process.env.OMP_REVIEW_KIT_EFFORT = 'max';
  try {
    const args = await captureSpawnArgs(undefined);

    for (const flag of ['--model', '--smol', '--slow', '--thinking']) {
      assert.ok(!args.includes(flag), `${flag} must not be passed: ${args.join(' ')}`);
    }
    assert.ok(!args.includes('@slow'));
  } finally {
    for (const [key, name] of [['model', 'OMP_REVIEW_KIT_MODEL'], ['effort', 'OMP_REVIEW_KIT_EFFORT']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});
