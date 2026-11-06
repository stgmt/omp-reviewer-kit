import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
const version = '91.83.17';
const packages = ['@oh-my-pi/pi-coding-agent', '@babel/parser'];
const provisioner = new URL('../src/infra/ensure-review-runtime.mjs', import.meta.url).href;

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('Given a fresh host install, When dependencies are provisioned concurrently, Then one pinned cache is reused without writing to the project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-runtime-test-'));
  t.after(() => rm(root, REMOVE));
  const kit = path.join(root, 'kit');
  const home = path.join(root, 'home');
  await mkdir(kit);
  await mkdir(home);
  const archives = new Map();
  for (const [index, name] of packages.entries()) {
    for (const packageVersion of [version, '91.83.18']) {
      const source = path.join(root, `source-${index}-${packageVersion}`);
      await mkdir(path.join(source, 'package'), { recursive: true });
      await writeFile(path.join(source, 'package', 'package.json'), JSON.stringify({ name, version: packageVersion, main: 'index.js' }));
      if (name === '@babel/parser') {
        await copyFile(new URL('../node_modules/@babel/parser/lib/index.js', import.meta.url), path.join(source, 'package', 'index.js'));
      } else {
        await writeFile(path.join(source, 'package', 'index.js'), 'module.exports = {};\n');
      }
      const archive = path.join(root, `package-${index}-${packageVersion}.tgz`);
      const packed = spawnSync('tar', ['-czf', archive, '-C', source, 'package'], { encoding: 'utf8', windowsHide: true });
      assert.equal(packed.status, 0, packed.stderr);
      archives.set(`${name}@${packageVersion}`, await readFile(archive));
    }
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const tar = /^\/tar\/(\d+)\/([^/]+)$/.exec(pathname);
    if (tar) {
      const data = archives.get(`${packages[Number(tar[1])]}@${tar[2]}`);
      if (!data) { response.writeHead(404).end(); return; }
      response.writeHead(200).end(data);
      return;
    }
    const name = packages.find(value => pathname === `/${value}`);
    if (!name) { response.writeHead(404).end(); return; }
    const versions = Object.fromEntries([version, '91.83.18'].map(packageVersion => {
      const data = archives.get(`${name}@${packageVersion}`);
      const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;
      const tarball = `http://127.0.0.1:${server.address().port}/tar/${packages.indexOf(name)}/${packageVersion}`;
      return [packageVersion, { name, version: packageVersion, dist: { tarball, integrity } }];
    }));
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name, 'dist-tags': { latest: version }, versions,
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, BUN_CONFIG_REGISTRY: registry, NO_PROXY: '127.0.0.1,localhost' };
  await writeFile(path.join(kit, 'package.json'), JSON.stringify({ name: 'runtime-fixture', private: true, dependencies: Object.fromEntries(packages.map(name => [name, version])) }));
  const lock = await run('bun', ['install', '--lockfile-only', '--ignore-scripts', '--cwd', kit], { cwd: root, env });
  assert.equal(lock.status, 0, lock.stderr);
  const code = `import { ensureReviewRuntime } from ${JSON.stringify(provisioner)};\n`
    + `try { console.log(ensureReviewRuntime({ kitRoot: process.argv[1], home: process.argv[2], repoRoot: process.argv[3], bun: 'bun', bunVersion: 'fixture' })); }\n`
    + `catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const launch = cache => run(process.execPath, ['--input-type=module', '-e', code, kit, home, kit], {
    cwd: root, env: { ...env, BUN_INSTALL_CACHE_DIR: path.join(root, cache) },
  });
  const attempts = await Promise.all([launch('bun-cache-1'), launch('bun-cache-2')]);
  for (const result of attempts) assert.equal(result.status, 0, result.stderr);
  const destination = attempts[0].stdout.trim();
  assert.equal(attempts[1].stdout.trim(), destination);
  for (const name of packages) {
    const installed = JSON.parse(await readFile(path.join(destination, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
    assert.equal(installed.version, version);
  }
  assert.deepEqual((await readdir(path.join(home, '.omp', 'review-kit-runtime'))).filter(name => name.startsWith('.install-')), []);
  await assert.rejects(readFile(path.join(kit, 'node_modules', '@babel', 'parser', 'package.json')), { code: 'ENOENT' });
  const defaultHomeCode = `import { ensureReviewRuntime } from ${JSON.stringify(provisioner)};\n`
    + `try { console.log(ensureReviewRuntime({ kitRoot: process.argv[1], repoRoot: process.argv[1], bun: 'bun', bunVersion: 'fixture' })); }\n`
    + `catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const defaultHome = await run(process.execPath, ['--input-type=module', '-e', defaultHomeCode, kit], { cwd: root, env });
  assert.equal(defaultHome.status, 0, defaultHome.stderr);
  assert.equal(defaultHome.stdout.trim(), destination);

  const lockfile = await readFile(path.join(kit, 'bun.lock'), 'utf8');
  await writeFile(path.join(kit, 'bun.lock'), `${lockfile}\n`);
  const changedLock = await launch('bun-cache-changed-lock');
  assert.equal(changedLock.status, 0, changedLock.stderr);
  assert.notEqual(changedLock.stdout.trim(), destination);
  await writeFile(path.join(kit, 'bun.lock'), lockfile);

  const manifest = JSON.parse(await readFile(path.join(kit, 'package.json'), 'utf8'));
  for (const name of packages) {
    const dependencies = { ...manifest.dependencies };
    delete dependencies[name];
    await writeFile(path.join(kit, 'package.json'), JSON.stringify({ ...manifest, dependencies }));
    const missing = await launch('bun-cache-missing-dependency');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no pinned runtime dependencies/);
  }
  const mismatchedHome = path.join(root, 'mismatched-home');
  await mkdir(mismatchedHome);
  await writeFile(path.join(kit, 'package.json'), JSON.stringify({
    ...manifest, dependencies: { ...manifest.dependencies, '@babel/parser': '91.83.18' },
  }));
  const mismatch = await run(process.execPath, ['--input-type=module', '-e', code, kit, mismatchedHome, kit], { cwd: root, env });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /dependency installation failed/);
  assert.deepEqual(await readdir(path.join(mismatchedHome, '.omp', 'review-kit-runtime')), []);

  const scriptHome = path.join(root, 'script-home');
  const marker = path.join(root, 'postinstall-marker');
  await mkdir(scriptHome);
  await writeFile(path.join(kit, 'package.json'), JSON.stringify({
    ...manifest, scripts: { postinstall: `node -e "require('fs').writeFileSync(process.env.RUNTIME_MARKER,'executed')"` },
  }));
  const noScripts = await run(process.execPath, ['--input-type=module', '-e', code, kit, scriptHome, kit], {
    cwd: root, env: { ...env, RUNTIME_MARKER: marker },
  });
  assert.equal(noScripts.status, 0, noScripts.stderr);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(path.join(kit, 'package.json'), JSON.stringify(manifest));
  const bunVersion = await run('bun', ['--version'], { cwd: root, env });
  assert.equal(bunVersion.status, 0, bunVersion.stderr);
  const launcherCode = code.replace("bunVersion: 'fixture'", `bunVersion: ${JSON.stringify(bunVersion.stdout.trim())}`);
  const launcherRuntime = await run(process.execPath, ['--input-type=module', '-e', launcherCode, kit, home, kit], { cwd: root, env });
  assert.equal(launcherRuntime.status, 0, launcherRuntime.stderr);
  await new Promise(resolve => server.close(resolve));
  const again = await launch('bun-cache-offline');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), destination);
  const offlineHome = path.join(root, 'offline-home');
  await mkdir(offlineHome);
  const offline = await run(process.execPath, ['--input-type=module', '-e', code, kit, offlineHome, kit], {
    cwd: root, env: { ...env, BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache-empty') },
  });
  assert.notEqual(offline.status, 0);
  assert.match(offline.stderr, /dependency installation failed/);
  assert.deepEqual(await readdir(path.join(offlineHome, '.omp', 'review-kit-runtime')), []);
  const inProject = await run(process.execPath, ['--input-type=module', '-e', code, kit, kit, kit], {
    cwd: root, env,
  });
  assert.notEqual(inProject.status, 0);
  assert.match(inProject.stderr, /inside the reviewed repository/);
  await assert.rejects(readdir(path.join(kit, '.omp')), { code: 'ENOENT' });
  const linkedHome = path.join(root, 'linked-home');
  await mkdir(linkedHome);
  await symlink(kit, path.join(linkedHome, '.omp'), 'junction');
  const linked = await run(process.execPath, ['--input-type=module', '-e', code, kit, linkedHome, kit], { cwd: root, env });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /inside the reviewed repository/);
  await assert.rejects(readdir(path.join(kit, 'review-kit-runtime')), { code: 'ENOENT' });

  const slowHome = path.join(root, 'slow-home');
  await mkdir(slowHome);
  await writeFile(path.join(root, 'install'), 'setTimeout(() => process.exit(0), 1500);\n');
  const timeoutCode = `import { ensureReviewRuntime } from ${JSON.stringify(provisioner)};\n`
    + `try { ensureReviewRuntime({ kitRoot: process.argv[1], home: process.argv[2], repoRoot: process.argv[1], bun: process.execPath, bunVersion: 'slow', installTimeoutMs: 100 }); }\n`
    + `catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const timedOut = await run(process.execPath, ['--input-type=module', '-e', timeoutCode, kit, slowHome], { cwd: root, env });
  assert.notEqual(timedOut.status, 0);
  assert.match(timedOut.stderr, /dependency installation failed \(ETIMEDOUT\)/);
  assert.deepEqual(await readdir(path.join(slowHome, '.omp', 'review-kit-runtime')), []);

  await cp(new URL('../src/', import.meta.url), path.join(kit, 'src'), { recursive: true });
  await cp(new URL('../scripts/', import.meta.url), path.join(kit, 'scripts'), { recursive: true });
  const project = path.join(root, 'project');
  await mkdir(project);
  for (const args of [['init', '-q'], ['add', 'sample.js']]) {
    if (args[0] === 'add') await writeFile(path.join(project, 'sample.js'), 'export function answer() { return 42; }\n');
    const git = await run('git', args, { cwd: project, env });
    assert.equal(git.status, 0, git.stderr);
  }
  const launcherEnv = {
    ...env,
    BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache-launcher-offline'),
    OMP_REVIEW_KIT_RUNS_DIR: path.join(root, 'runs'),
    OMP_REVIEW_KIT_REPORTS_DIR: path.join(root, 'reports'),
  };
  delete launcherEnv.NODE_PATH;
  delete launcherEnv.OMP_REVIEW_KIT_RUNTIME_ROOT;
  const reviewed = await run(process.execPath, [path.join(kit, 'scripts', 'run-review.mjs'), project], { cwd: project, env: launcherEnv });
  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.stderr, /preparing the pinned OMP runtime/);
  assert.match(reviewed.stderr, /maintainability (?:analyzed|no-candidates).*coverage full/);
  assert.match(reviewed.stderr, /reuse hints .*1 unit\(s\), coverage full/);
  await rm(path.join(destination, 'node_modules', '@babel', 'parser', 'package.json'));
  const corrupt = await launch('bun-cache-corrupt');
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /cached review runtime is incomplete/);
});
