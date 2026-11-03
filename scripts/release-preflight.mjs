// Release preflight: every fact that is knowable before the review runs, checked once, so a release
// enters the review with a frozen diff. It never runs the review and never guesses: it reads the
// version sources, the mutant anchors and the selector hashes, and reports one line per check.
//
// Why this exists: each edit made after a review starts invalidates that review, and each edit to a
// deciding test invalidates its selector. Both were discovered only after a 20-minute review had
// already run. A hash comparison costs milliseconds; the review does not.

import { readFile as readFileFs, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { MUTANTS } from './run-mutation-tests.mjs';
import { findStaleMutants } from './mutation-runner.mjs';
import { createCertificate, describeCertificate, gateRun, isUsableCertificate } from '../src/domain/mutation-certificate.mjs';
import { pruneCertificates, readCertificate, writeCertificate } from '../src/infra/mutation-certificate-store.mjs';

/** Version sources that must agree before a release. `field` walks into the parsed document. */
/** The file the gate process loads its curated mutants from. */
export const MUTANT_CATALOG_FILE = 'scripts/run-mutation-tests.mjs';

/** The gate's own output: it rewrites this file when it recalibrates, so it is not a certified byte. */
export const SELECTOR_CATALOG_FILE = 'scripts/mutation-selectors.json';

/** Reports are written by tooling, never reviewed, and never part of a certificate. */
const REPORTS_DIR = 'audit-reports';

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

/**
 * The bytes a gate run certifies: every mutant target and every deciding test. The selector catalog
 * is the gate's own output and is deliberately not part of it. If a review finding edits one of
 * these files while the gate runs, the verdict certifies bytes that no longer exist.
 *
 * @param {{ mutants: Array<{ file: string, testFile: string }>, readFile: (file: string) => Promise<string> }} options
 * @returns {Promise<string>}
 */
export async function gateFingerprint({ mutants, readFile }) {
  const files = [...new Set(mutants.flatMap(mutant => [mutant.file, mutant.testFile]))].sort();
  const hash = createHash('sha256');
  // What the gate executes, not only what it reads: a mutant added or edited mid-run changes the set.
  const definitions = [...new Set(mutants
    .map(mutant => [mutant.id, mutant.file, mutant.testFile, mutant.original, mutant.replacement].join('\u0000')))].sort();
  hash.update(JSON.stringify(definitions));
  // The child gate loads the catalog from disk, not from this process's import: certify those bytes too.
  try {
    hash.update((await readFile(MUTANT_CATALOG_FILE)).replace(/\r\n/g, '\n'));
  } catch {
    hash.update(':catalog-missing');
  }
  for (const file of files) {
    hash.update(file);
    try {
      hash.update((await readFile(file)).replace(/\r\n/g, '\n'));
    } catch {
      hash.update(':missing');
    }
  }
  return hash.digest('hex');
}

/**
 * Content hash of the whole working tree: `git write-tree` through a throwaway index, so the digest
 * is the same before and after the release commit, and any edit anywhere changes it. The gate's own
 * output and the reports folder are excluded, because the gate rewrites the former during the very
 * run that is being certified and the latter is never reviewed. `null` when git cannot produce a
 * tree — the caller then refuses to reuse a certificate instead of guessing.
 *
 * @param {{ cwd?: string, capture?: typeof capture }} [options]
 * @returns {Promise<string|null>}
 */
export async function workingTreeHash({ cwd = process.cwd(), capture: captureFn = capture, exclude = [SELECTOR_CATALOG_FILE, REPORTS_DIR] } = {}) {
  const index = path.join(tmpdir(), `review-kit-index-${process.pid}-${Date.now().toString(36)}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const pathspecs = ['.', ...exclude.map(entry => `:(exclude)${entry}`)];
  try {
    const added = await captureFn('git', ['add', '-A', '--', ...pathspecs], { cwd, env });
    if (added.code !== 0) return null;
    const tree = await captureFn('git', ['write-tree'], { cwd, env });
    if (tree.code !== 0) return null;
    const value = tree.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  } finally {
    await rm(index, { force: true }).catch(() => {});
  }
}

/**
 * The bytes a gate run certifies, complete: the catalog and the files the gate executes, plus a hash
 * of everything else in the tree, because a deciding test also imports modules that are not targets.
 *
 * @param {{ mutants: Array<{ file: string, testFile: string }>, readFile: (file: string) => Promise<string>, treeHash: string }} options
 * @returns {Promise<string>}
 */
export async function treeFingerprint({ mutants, readFile, treeHash }) {
  const gate = await gateFingerprint({ mutants, readFile });
  const hash = createHash('sha256').update(gate).update('\u0000').update(String(treeHash));
  // The catalog names the deciding tests, so a repointed selector is another proof input — even
  // though the gate writes this file itself while it runs.
  try {
    hash.update((await readFile(SELECTOR_CATALOG_FILE)).replace(/\r\n/g, '\n'));
  } catch {
    hash.update(':catalog-missing');
  }
  return hash.digest('hex');
}

/**
 * A frozen diff: nothing half-applied. The index may carry the release (that is the diff under
 * review); what must not exist is an unstaged modification or an untracked file, because both mean a
 * finding is still being written while the gate would be proving the bytes it started from. The
 * reports folder and the gate's own selector catalog are never part of the reviewed diff.
 */
export function checkFrozen({ status }) {
  const pending = String(status)
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.length > 0)
    .filter((line) => {
      // `XY path`: the path starts after the two status columns and one separator.
      const path = line.slice(3).replace(/^"|"$/g, '');
      if (path.startsWith(`${REPORTS_DIR}/`)) return false;
      if (path === SELECTOR_CATALOG_FILE) return false;
      // Y is the worktree column. A space there means the change lives only in the index.
      const code = line.slice(0, 2);
      const worktree = code.length === 2 ? code[1] : ' ';
      return worktree !== ' ' || code === '??';
    });
  return { ok: pending.length === 0, pending };
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.on('close', code => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Same runner, but the output is captured instead of streamed: used to hash the tree. */
function capture(command, args, { cwd, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', error => resolve({ code: 1, stdout, stderr: String(error) }));
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
  treeHash = () => workingTreeHash({ cwd }),
  readCert = digest => readCertificate(digest),
  writeCert = certificate => writeCertificate(certificate),
  pruneCert = () => pruneCertificates(),
  now = () => Date.now(),
} = {}) {
  const recalibrate = argv.includes('--recalibrate');
  // A gate run proves bytes; a tree with unstaged or untracked work is not a stable set of bytes, and
  // the proof would be worthless the moment the finding under the cursor is saved.
  const requireFrozen = argv.includes('--require-frozen') || recalibrate;
  const skipTests = argv.includes('--skip-tests');
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

  const frozen = checkFrozen({ status: await status() });
  if (requireFrozen) {
    ok &&= frozen.ok;
    note(report('diff frozen', frozen.ok, frozen.ok
      ? 'nothing unstaged or untracked outside the reports and the gate catalog'
      : `pending: ${frozen.pending.join(' | ')}`));
    if (requireFrozen && !frozen.ok) {
      note('release preflight: the diff is not frozen, so nothing was calibrated or committed');
      return 1;
    }
  } else if (!frozen.ok) {
    note(report('diff frozen', true, `warning: ${frozen.pending.length} pending change(s) - run the gate only after the review's last finding`));
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
    if (recalibrate) {
      // The gate proves the catalog for one byte state. A certificate is that proof; without one the
      // run happens once here, and a second preflight on the same bytes answers in milliseconds.
      // Movement is judged by the tree hash: it covers every tracked file, and the only files a run
      // may legitimately change are the reports and the selector catalog, both excluded from it.
      const tree = await treeHash();
      if (tree === null) {
        // Without a hash of the current bytes there is no way to tell whether the gate proved the
        // release or a copy that has already moved. Certifying is impossible; saying so is not.
        ok = false;
        note(report('mutation certificate', false, 'the working tree could not be hashed, so no gate run can be certified'));
        note('release preflight: fix the tree hashing (git index/object store) before recalibrating');
        return 1;
      }
      const digest = await treeFingerprint({ mutants, readFile, treeHash: tree });
      const cached = await readCert(digest);
      const reusable = isUsableCertificate(cached, { digest, mutants: mutants.length });
      if (reusable) {
        note(report('mutation certificate', true, `${describeCertificate(cached, now())}; the gate is not run again on these bytes`));
      } else {
        const started = now();
        const code = await runCommand(process.execPath, ['scripts/run-mutation-tests.mjs', '--calibrate-stale'], { cwd });
        const durationMs = now() - started;
        // The gate rewrites its selector catalog while it runs, so the movement check compares the
        // tree only; the catalog is read again afterwards, into the digest that is stored.
        const afterTree = await treeHash();
        if (afterTree === null) {
          ok = false;
          note(report('gate snapshot', false, 'the tree could not be hashed after the gate run, so the verdict cannot be tied to the current bytes'));
          return 1;
        }
        // Fresh reads: this digest must see the bytes as they are after the run, not as they were.
        const after = await treeFingerprint({ mutants, readFile, treeHash: afterTree });
        // A run certifies the bytes it started from. If a review finding is still being applied, the
        // bytes move under the run and its verdict would certify nothing: report that instead.
        if (afterTree !== tree) {
          ok = false;
          note(report('gate snapshot', false, 'the gate run changed the certified bytes; its verdict does not certify the current tree - rerun once the review findings are closed'));
          return 1;
        }
        note(report('gate snapshot', true, 'the bytes did not move during the gate run'));
        const catalogAfter = code === 0 ? JSON.parse(await readFile('scripts/mutation-selectors.json')) : null;
        const again = catalogAfter?.mappings ? await checkSelectors({ mutants, selectors: catalogAfter.mappings, root: cwd, findStale }) : { ok: false, stale: ['calibration failed'] };
        ok &&= code === 0 && again.ok;
        note(report('recalibration', code === 0 && again.ok, code === 0 && again.ok ? 'selectors re-proved and the full catalog certified' : 'the gate did not certify the catalog'));
        if (code === 0 && again.ok) {
          const stored = createCertificate(gateRun({ digest: after, mutants: mutants.length, durationMs }), { createdAt: new Date(now()).toISOString() });
          try {
            await writeCert(stored);
            await pruneCert().catch(() => 0);
            note(report('mutation certificate', true, `${describeCertificate(stored, now())}; stored for these bytes`));
          } catch (error) {
            // Fail-open: the run passed, and the next preflight simply runs the gate again.
            note(report('mutation certificate', true, `the proof was not stored (${error instanceof Error ? error.message : String(error)}); the next preflight runs the gate again`));
          }
        }
      }
      note('note: the mutation gate runs once, on the frozen diff after the review. A review round in progress is not a reason to recalibrate, and every edit to a deciding test, a mutant target or the catalog invalidates this certificate.');
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
