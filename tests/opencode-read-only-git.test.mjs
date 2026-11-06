import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { createReadOnlyGitTool } from '../opencode/read-only-git.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

const repos = [];
const tool = createReadOnlyGitTool();
const toolContext = directory => ({ directory });

function cleanGitEnv() {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return env;
}

function git(directory, ...args) {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: cleanGitEnv(),
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `git ${args.join(' ')} could not start`);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createRepo() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-git-tool-'));
  repos.push(directory);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'Read-only Tool Test');
  git(directory, 'config', 'user.email', 'read-only-tool@example.invalid');
  await writeFile(path.join(directory, '.gitattributes'), 'tracked.txt diff=hostile\n');
  await writeFile(path.join(directory, 'tracked.txt'), 'first version\n');
  git(directory, 'add', '.gitattributes', 'tracked.txt');
  git(directory, 'commit', '-m', 'Initial committed version');
  const first = git(directory, 'rev-parse', 'HEAD');

  await writeFile(path.join(directory, 'tracked.txt'), 'second version\n');
  git(directory, 'add', 'tracked.txt');
  git(directory, 'commit', '-m', 'Second committed version');
  const second = git(directory, 'rev-parse', 'HEAD');

  await writeFile(path.join(directory, 'tracked.txt'), 'staged version\n');
  git(directory, 'add', 'tracked.txt');
  await writeFile(path.join(directory, 'tracked.txt'), 'working tree version\n');
  return { directory, first, second };
}

function quoteForGitShell(value) {
  let shellPath = value;
  if (process.platform === 'win32') {
    const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(value);
    if (drivePath) shellPath = `/${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll('\\', '/')}`;
  }
  return `'${shellPath.replaceAll("'", "'\\''")}'`;
}

after(async () => {
  await Promise.all(repos.map(directory => rm(directory, REMOVE)));
});

describe('OpenCode read-only Git tool', () => {
  it('exposes a Zod object shape accepted by OpenCode', () => {
    const openCodeArgsSchema = z.object(tool.args);
    assert.deepEqual(openCodeArgsSchema.parse({ operation: 'status' }), { operation: 'status' });
    assert.throws(() => openCodeArgsSchema.parse({ operation: 'not-a-git-operation' }));
    assert.deepEqual(
      openCodeArgsSchema.parse({ operation: 'diff_staged', names_only: true }),
      { operation: 'diff_staged', names_only: true },
    );
    assert.deepEqual(
      openCodeArgsSchema.parse({ operation: 'show_staged', path: 'tracked.txt' }),
      { operation: 'show_staged', path: 'tracked.txt' },
    );
    assert.throws(() => openCodeArgsSchema.parse({ operation: 'diff_range', names_only: 'yes' }));
  });

  it('reads actual staged changes, commit history, commit details, ranges, and file contents', async () => {
    const { directory, first, second } = await createRepo();
    const context = toolContext(directory);

    const status = await tool.execute({ operation: 'status' }, context);
    assert.match(status, /MM tracked\.txt/);

    const staged = await tool.execute({ operation: 'diff_staged' }, context);
    assert.match(staged, /\+staged version/);
    assert.match(staged, /-second version/);
    const stagedNames = await tool.execute({ operation: 'diff_staged', names_only: true }, context);
    assert.equal(stagedNames, 'tracked.txt\n');
    const headFile = await tool.execute({ operation: 'show_file', revision: second, path: 'tracked.txt' }, context);
    const stagedFile = await tool.execute({ operation: 'show_staged', path: 'tracked.txt' }, context);
    const workingFile = await readFile(path.join(directory, 'tracked.txt'), 'utf8');
    assert.equal(headFile, 'second version\n');
    assert.equal(stagedFile, 'staged version\n');
    assert.equal(workingFile, 'working tree version\n');
    await assert.rejects(tool.execute({ operation: 'show_staged' }, context), /Invalid review_git arguments/);

    const log = await tool.execute({ operation: 'log', limit: 2 }, context);
    assert.match(log, /Second committed version/);
    assert.match(log, /Initial committed version/);

    const show = await tool.execute({ operation: 'show', revision: second }, context);
    assert.match(show, /Second committed version/);
    assert.match(show, /\+second version/);

    const range = await tool.execute({ operation: 'diff_range', base: first, head: second }, context);
    assert.match(range, /\+second version/);
    assert.match(range, /-first version/);
    const rangeNames = await tool.execute({ operation: 'diff_range', base: first, head: second, names_only: true }, context);
    assert.equal(rangeNames, 'tracked.txt\n');

    const oldFile = await tool.execute({ operation: 'show_file', revision: first, path: 'tracked.txt' }, context);
    assert.equal(oldFile, 'first version\n');
  });

  it('ignores hostile Git config and inherited GIT environment, and treats hostile arguments as data', async () => {
    const { directory } = await createRepo();
    const decoy = await createRepo();
    git(decoy.directory, 'reset', '--hard', 'HEAD');
    const marker = path.join(directory, '.git', 'command-ran');
    const script = path.join(directory, '.git', 'hostile.mjs');
    await writeFile(script, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'executed');\n");
    const hostileCommand = [process.execPath, script, marker].map(quoteForGitShell).join(' ');

    git(directory, 'config', 'core.fsmonitor', hostileCommand);
    git(directory, 'config', 'core.pager', hostileCommand);
    git(directory, 'config', 'diff.external', hostileCommand);
    git(directory, 'config', 'diff.hostile.textconv', hostileCommand);

    const indexPath = path.join(directory, '.git', 'index');
    const indexBefore = await readFile(indexPath);
    const envKeys = [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_PAGER',
    ];
    const previous = new Map(envKeys.map(key => [key, process.env[key]]));
    const redirectedIndex = path.join(directory, '.git', 'redirected-index');

    try {
      process.env.GIT_DIR = path.join(decoy.directory, '.git');
      process.env.GIT_WORK_TREE = decoy.directory;
      process.env.GIT_INDEX_FILE = redirectedIndex;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
      process.env.GIT_CONFIG_VALUE_0 = hostileCommand;
      process.env.GIT_PAGER = hostileCommand;

      const status = await tool.execute({ operation: 'status' }, toolContext(directory));
      assert.match(status, /MM tracked\.txt/);
      assert.doesNotMatch(status, /Initial committed version/);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }


    const context = toolContext(directory);
    await tool.execute({ operation: 'diff_staged' }, context);
    await tool.execute({ operation: 'show', revision: 'HEAD' }, context);
    await tool.execute({ operation: 'diff_range', base: 'HEAD~1', head: 'HEAD' }, context);

    assert.equal(await readFile(marker).then(() => true, () => false), false, 'configured external commands must not run');
    assert.deepEqual(await readFile(indexPath), indexBefore, 'read-only inspection must not update the index');
    assert.equal(await readFile(redirectedIndex).then(() => true, () => false), false);

    const outputMarker = path.join(directory, '.git', 'output-injection');
    const optionPath = outputMarker.replaceAll('\\', '/');
    await tool.execute({ operation: 'diff_staged', path: `--output=${optionPath}` }, context);
    assert.equal(await readFile(outputMarker).then(() => true, () => false), false, 'a leading path option must stay a literal path');

    await assert.rejects(
      tool.execute({ operation: 'show', revision: '--exec=touch' }, context),
      /Invalid review_git arguments/,
    );
    await assert.rejects(
      tool.execute({ operation: 'show_file', revision: 'HEAD', path: '../../outside.txt' }, context),
      /Invalid review_git arguments/,
    );
    await assert.rejects(
      tool.execute({ operation: 'diff_range', base: 'HEAD', head: '-c' }, context),
      /Invalid review_git arguments/,
    );
    assert.equal(await readFile(marker).then(() => true, () => false), false);
    assert.deepEqual(await readFile(indexPath), indexBefore);
  });

  it('reports an already-aborted call and a non-repository directory explicitly', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tool.execute({ operation: 'status' }, { directory: os.tmpdir(), abort: controller.signal }),
      /Git operation aborted/,
    );

    const directory = await mkdtemp(path.join(os.tmpdir(), 'review-git-tool-not-repo-'));
    try {
      await assert.rejects(
        tool.execute({ operation: 'status' }, toolContext(directory)),
        /not a git repository/i,
      );
    } finally {
      await rm(directory, REMOVE);
    }
  });

  it('caps real Git output and aborts a running child explicitly', async () => {
    const { directory } = await createRepo();
    await writeFile(path.join(directory, 'large.txt'), `${'x'.repeat(160 * 1024)}\n`);
    git(directory, 'add', 'large.txt');

    await assert.rejects(
      tool.execute({ operation: 'diff_staged', path: 'large.txt' }, toolContext(directory)),
      /Git output exceeded 131072 bytes/,
    );
    const largeNames = await tool.execute({ operation: 'diff_staged', path: 'large.txt', names_only: true }, toolContext(directory));
    assert.equal(largeNames, 'large.txt\n');

    const controller = new AbortController();
    const pending = tool.execute({ operation: 'status' }, { directory, abort: controller.signal });
    controller.abort();
    await assert.rejects(pending, /Git operation aborted/);
  });

  it('bounds a Git process that never answers and terminates the child', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.signals = [];
    // A child that ignores the polite signal and only dies when it is killed outright.
    child.kill = signal => {
      child.signals.push(signal ?? 'SIGTERM');
      if ((signal ?? 'SIGTERM') === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL'));
    };
    const bounded = createReadOnlyGitTool({ spawnImpl: () => child, timeoutMs: 60 });
    let guard;
    const unanswered = new Promise((resolve, reject) => {
      guard = setTimeout(() => reject(new Error('the Git call was never bounded')), 3_000);
    });
    try {
      await assert.rejects(
        Promise.race([bounded.execute({ operation: 'status' }, toolContext(os.tmpdir())), unanswered]),
        /Git operation timed out after 60 ms/,
      );
      assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'], 'the stalled child is asked to stop, then killed');
    } finally {
      clearTimeout(guard);
    }
  });

});
