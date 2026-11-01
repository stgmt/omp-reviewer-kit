// Release preflight: every fact that is knowable before the review runs, checked once, so a release
// enters the review with a frozen diff. It never runs the review and never guesses: it reads the
// version sources, the mutant anchors and the selector hashes, and reports one line per check.
//
// Why this exists: each edit made after a review starts invalidates that review, and each edit to a
// deciding test invalidates its selector. Both were discovered only after a 20-minute review had
// already run. A hash comparison costs milliseconds; the review does not.

import { readFile as readFileFs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { MUTANTS } from './run-mutation-tests.mjs';
import { findStaleMutants } from './mutation-runner.mjs';

/** Version sources that must agree before a release. `field` walks into the parsed document. */
export const VERSION_SOURCES = Object.freeze([
  { file: 'package.json', field: ['version'] },
  { file: 'package.json', field: ['omp', 'version'] },
  { file: '.omp-plugin/marketplace.json', field: ['plugins', 0, 'version'] },
  { file: '.claude-plugin/marketplace.json', field: ['plugins', 0, 'version'] },
  { file: 'claude-plugin/.claude-plugin/plugin.json', field: ['version'] },
]);

const readValue = (document, field) => field.reduce((value, key) => (value == null ? undefined : value[key]), document);

/**
 * Every version source names the same release, and the changelog carries a heading for it.
 *
 * @param {{ readFile?: (file: string) => Promise<string> }} [options]
 * @returns {Promise<{ ok: boolean, version: string|null, problems: string[] }>}
 */
export async function checkVersions({ readFile = file => readFileFs(file, 'utf8') } = {}) {
  const problems = [];
  const seen = [];
  for (const source of VERSION_SOURCES) {
    let document;
    try {
      document = JSON.parse(await readFile(source.file));
    } catch (error) {
      problems.push(`${source.file} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const value = readValue(document, source.field);
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${source.file} ${source.field.join('.')} is missing`);
      continue;
    }
    seen.push({ file: `${source.file} ${source.field.join('.')}`, value });
  }
  const versions = [...new Set(seen.map(entry => entry.value))];
  if (versions.length > 1) {
    problems.push(`version sources disagree: ${seen.map(entry => `${entry.file}=${entry.value}`).join(', ')}`);
  }
  const version = versions.length === 1 ? versions[0] : null;
  if (version) {
    let changelog = '';
    try {
      changelog = await readFile('CHANGELOG.md');
    } catch (error) {
      problems.push(`CHANGELOG.md is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (changelog && !new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
      problems.push(`CHANGELOG.md has no dated "## [${version}]" heading`);
    }
  }
  return { ok: problems.length === 0, version, problems };
}

/**
 * Every curated mutant's `original` matches its target file exactly once. A refactor that moves the
 * anchor makes the gate report an infrastructure error half an hour later instead of here.
 *
 * @param {Array<{ id: string, file: string, original: string }>} mutants
 * @param {{ readFile?: (file: string) => Promise<string> }} [options]
 * @returns {Promise<{ ok: boolean, broken: Array<{ id: string, file: string, matches: number }> }>}
 */
export async function checkAnchors(mutants = MUTANTS, { readFile = file => readFileFs(file, 'utf8') } = {}) {
  const sources = new Map();
  const broken = [];
  for (const mutant of mutants) {
    if (!sources.has(mutant.file)) sources.set(mutant.file, await readFile(mutant.file));
    const source = sources.get(mutant.file).replace(/\r\n/g, '\n');
    const matches = source.split(mutant.original.replace(/\r\n/g, '\n')).length - 1;
    if (matches !== 1) broken.push({ id: mutant.id, file: mutant.file, matches });
  }
  return { ok: broken.length === 0, broken };
}

/**
 * The selectors that no longer fit: a renamed test, an edited deciding test, an edited mutant.
 * This is a hash comparison, so it answers in milliseconds what the gate would discover in minutes.
 *
 * @param {{ mutants?: typeof MUTANTS, selectors: object, root?: string }} options
 * @returns {Promise<{ stale: string[], ok: boolean }>}
 */
export async function checkSelectors({ mutants = MUTANTS, selectors, root = process.cwd(), findStale = findStaleMutants }) {
  const stale = await findStale(mutants, selectors, root);
  return { stale: stale.map(mutant => mutant.id), ok: stale.length === 0 };
}

/** A frozen diff: nothing unstaged outside the reports folder, so a review result stays valid. */
export function checkFrozen({ status }) {
  const pending = String(status)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/(^|[/\\])audit-reports\//.test(line) && !/^[?]{2} audit-reports/.test(line));
  return { ok: pending.length === 0, pending };
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.on('close', code => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function gitStatus(cwd) {
  return new Promise(resolve => {
    const child = spawn('git', ['status', '--porcelain'], { cwd, shell: false });
    let out = '';
    child.stdout?.on('data', chunk => { out += chunk; });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
}

function report(label, ok, detail) {
  const mark = ok ? 'ok' : 'FAIL';
  return `${mark.padEnd(4)} ${label}${detail ? ` - ${detail}` : ''}`;
}

/**
 * @param {{ argv?: string[], cwd?: string, log?: (line: string) => void, readFile?: (file: string) => Promise<string>,
 *   mutants?: typeof MUTANTS, runCommand?: typeof run, status?: () => Promise<string> }} [options]
 * @returns {Promise<number>}
 */
export async function runPreflight({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  log = console.log,
  readFile = file => readFileFs(path.join(cwd, file), 'utf8'),
  mutants = MUTANTS,
  runCommand = run,
  status = () => gitStatus(cwd),
  findStale = findStaleMutants,
} = {}) {
  const recalibrate = argv.includes('--recalibrate');
  const skipTests = argv.includes('--skip-tests');
  const requireFrozen = argv.includes('--require-frozen');
  const lines = [];
  let ok = true;
  const note = (value) => { lines.push(value); log(value); };

  const versions = await checkVersions({ readFile });
  ok &&= versions.ok;
  note(report('versions', versions.ok, versions.ok ? versions.version : versions.problems.join('; ')));

  const anchors = await checkAnchors(mutants, { readFile });
  ok &&= anchors.ok;
  note(report('mutant anchors', anchors.ok, anchors.ok
    ? `${mutants.length} anchors match exactly once`
    : anchors.broken.map(entry => `${entry.id} matches ${entry.matches}x in ${entry.file}`).join('; ')));

  // A review that still has open findings means the diff will change, and every change invalidates
  // the selectors and the calibration this run would prove. Refuse before spending a gate run.
  const frozen = checkFrozen({ status: await status() });
  if (requireFrozen || recalibrate) {
    ok &&= frozen.ok;
    note(report('diff frozen', frozen.ok, frozen.ok
      ? 'no pending change outside the reports folder'
      : `not frozen, recalibration refused: ${frozen.pending.join(' | ')}`));
    if (!frozen.ok) {
      note('release preflight: close the review findings first, then recalibrate and commit the frozen diff');
      return 1;
    }
  } else if (!frozen.ok) {
    note(report('diff frozen', true, `warning: ${frozen.pending.length} pending change(s); recalculate after the review's last finding`));
  }

  let catalog;
  try {
    catalog = JSON.parse(await readFile('scripts/mutation-selectors.json'));
  } catch (error) {
    ok = false;
    note(report('selector catalog', false, `unreadable: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (catalog?.mappings) {
    const selectors = await checkSelectors({ mutants, selectors: catalog.mappings, root: cwd, findStale });
    note(report('selector staleness', selectors.ok, selectors.ok ? 'every selector fits its test bytes' : `${selectors.stale.length} stale: ${selectors.stale.slice(0, 8).join(', ')}${selectors.stale.length > 8 ? ', ...' : ''}`));
    if (!selectors.ok && recalibrate) {
      const code = await runCommand(process.execPath, ['scripts/run-mutation-tests.mjs', '--calibrate-stale'], { cwd });
      const after = code === 0 ? JSON.parse(await readFile('scripts/mutation-selectors.json')) : null;
      const again = after?.mappings ? await checkSelectors({ mutants, selectors: after.mappings, root: cwd, findStale }) : { ok: false, stale: ['calibration failed'] };
      ok &&= code === 0 && again.ok;
      note(report('recalibration', code === 0 && again.ok, code === 0 && again.ok ? 'selectors re-proved and the full catalog certified' : 'the gate did not certify the catalog'));
    } else {
      ok &&= selectors.ok;
    }
  }

  const layout = await runCommand(process.execPath, ['scripts/check-layout.mjs'], { cwd });
  ok &&= layout === 0;
  note(report('layout and versions in the package', layout === 0, layout === 0 ? 'ok' : 'check-layout failed'));

  if (!skipTests) {
    const tests = await runCommand(process.execPath, ['scripts/run-tests.mjs'], { cwd });
    ok &&= tests === 0;
    note(report('test suite', tests === 0, tests === 0 ? 'green' : 'the suite failed'));
  }

  note(ok ? 'release preflight: ready for one review run' : 'release preflight: fix the failures above before the review');
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPreflight();
}
