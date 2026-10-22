// Staged snapshot: the exact index content of the repository, exported to a temporary directory,
// with the review inputs under `.review/`. Every stage reads source from this directory, never
// from the working tree. Git runs with line-ending conversion off, so the files equal the blobs.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyChangedPaths, reviewProfileFor, riskLanesFor } from '../domain/file-class.mjs';
import { sanitizePromptToken } from '../domain/prompt-token.mjs';
import { isTestPath } from '../domain/suspicion-map.mjs';
import { loadCanonicalVendoredFiles } from '../infra/vendored-kit-files.mjs';

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 512 * 1024 * 1024;
const RESERVED_DIR = '.review/';

/**
 * @param {string} repo
 * @param {string[]} args
 * @returns {Promise<Buffer>}
 */
async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
    cwd: repo,
    encoding: 'buffer',
    maxBuffer: GIT_BUFFER,
  });
  return stdout;
}

/**
 * Staged modes by path (stage 0 entries of the index).
 *
 * @param {string} repo
 * @returns {Promise<Map<string, string>>}
 */
async function stagedModes(repo) {
  const out = await git(repo, ['ls-files', '-s', '-z']);
  const modes = new Map();
  for (const record of out.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , stage] = record.slice(0, tab).split(' ');
    if (stage === '0') modes.set(record.slice(tab + 1), mode);
  }
  return modes;
}

/**
 * Vendored kit files that are staged byte-identical (line endings normalised) to the installed
 * plugin's canonical copy are the review plugin itself, not the committer's work, so they are
 * left out of the review. Any problem reading the canonical copy exempts nothing.
 *
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string[]>}
 */
async function vendoredExemptions(repo, env) {
  const canonical = await loadCanonicalVendoredFiles({ env });
  const exempt = [];
  for (const [target, content] of canonical) {
    let staged;
    try {
      staged = (await git(repo, ['show', `:${target}`])).toString('utf8');
    } catch {
      continue;
    }
    if (staged.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) exempt.push(target);
  }
  return exempt;
}

/**
 * The staged diff exactly as the review hashes it, and the changed paths it names.
 *
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ diff: Buffer, paths: string[] }>}
 */
export async function readStagedChange(repo, env = process.env) {
  const exempt = await vendoredExemptions(repo, env);
  const pathspec = ['--', '.', ...exempt.map(file => `:(exclude,literal)${file}`)];
  const diff = await git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', ...pathspec]);
  if (diff.length === 0) return { diff, paths: [] };
  const names = await git(repo, ['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '-z', ...pathspec]);
  const paths = names.toString('utf8').split('\0').filter(Boolean);
  return { diff, paths };
}

/**
 * Exports the staged index into a fresh temporary directory and writes the review inputs.
 *
 * @param {{
 *   repo: string,
 *   parentDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   checkoutIndex?: (repo: string, dir: string) => Promise<void>,
 * }} input `checkoutIndex` is the export step; it defaults to `git checkout-index` into `dir`.
 * @returns {Promise<null|{
 *   dir: string,
 *   diffHash: string,
 *   profile: 'full'|'spec-docs',
 *   lanes: string[],
 *   changedPaths: string[],
 * }>} null when nothing is staged
 */
export async function materializeStagedSnapshot({ repo, parentDir, env = process.env, checkoutIndex = exportIndex }) {
  const { diff, paths } = await readStagedChange(repo, env);
  if (diff.length === 0) return null;
  const reserved = paths.find(file => file === '.review' || file.startsWith(RESERVED_DIR));
  if (reserved) throw new Error(`staged path ${reserved} collides with the reserved .review/ directory`);

  const dir = await mkdtemp(path.join(parentDir, 'staged-'));
  try {
    await checkoutIndex(repo, dir);

    const modes = await stagedModes(repo);
    const entries = classifyChangedPaths(paths, file => isTestPath(file), modes);
    const profile = reviewProfileFor(entries);
    const lanes = riskLanesFor(profile, env);
    const diffHash = createHash('sha256').update(diff).digest('hex');

    const review = path.join(dir, '.review');
    await mkdir(review, { recursive: true });
    await writeFile(path.join(review, 'diff.patch'), diff);
    // One manifest line per path: a name with a newline or a bidi mark is escaped, never split or forged.
    await writeFile(path.join(review, 'changed-files.txt'), `${paths.map(file => sanitizePromptToken(file)).join('\n')}\n`, 'utf8');
    await writeFile(
      path.join(review, 'file-classes.json'),
      `${JSON.stringify({ profile, files: entries.map(entry => ({ path: entry.path, fileClass: entry.fileClass })) }, null, 2)}\n`,
      'utf8',
    );
    return { dir, diffHash, profile, lanes, changedPaths: paths };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Writes the staged index into `dir` with `git checkout-index`.
 *
 * @param {string} repo
 * @param {string} dir
 */
async function exportIndex(repo, dir) {
  await git(repo, ['checkout-index', '-a', `--prefix=${toGitPrefix(dir)}/`]);
}

/** Git accepts forward slashes on every platform, including Windows drive paths. */
function toGitPrefix(dir) {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * @param {string} dir
 */
export async function removeSnapshot(dir) {
  await rm(dir, { recursive: true, force: true });
}
