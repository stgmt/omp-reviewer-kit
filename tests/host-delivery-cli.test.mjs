// The delivery surface as a user meets it: the CLI of each new script, the host contracts they emit,
// and the two behaviours the review found missing — assignment-prefixed commits and exact identity.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { INSTALL_MANIFEST } from '../src/domain/host-install-plan.mjs';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
const ROOT = process.cwd();

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], { encoding: 'utf8', windowsHide: true, timeout: 180000, ...options });
}

test('Given the published package, When its OpenCode entry is read, Then the server export and the engine range are declared', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./server'], './opencode/plugin.mjs');
  assert.match(pkg.engines.opencode, />=/);
  const module = await import(pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href);
  assert.equal(typeof module.default.server, 'function');
});

test('Given the OpenCode module, When a shell command that is not a commit runs, Then the hook allows it without a review', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href);
  const hooks = await module.default.server();
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'npm test' } });
});

test('Given the OpenCode module, When a non-shell tool runs, Then the guard is not consulted at all', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href);
  const hooks = await module.default.server();
  await hooks['tool.execute.before']({ tool: 'read' }, { args: { filePath: 'x' } });
});

test('Given the configured Codex hook, When a commit is denied, Then the command carries --codex and the answer is Codex denial', async () => {
  const hooks = JSON.parse(await readFile(path.join(ROOT, '.codex-plugin', 'hooks.json'), 'utf8'));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /--codex/, 'the Codex contract must be selected by the configured command');
  assert.equal(hooks.hooks.PreToolUse[0].matcher, '^Bash$');
});

test('Given the guard program, When the payload is malformed, Then it answers an empty object and allows', () => {
  const result = run('scripts/hook-guard.mjs', ['--codex'], { input: 'not json' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('Given the guard program in Codex form and a non-commit command, When it runs, Then it allows without consulting the review', () => {
  const result = run('scripts/hook-guard.mjs', ['--codex'], { input: JSON.stringify({ tool_input: { command: 'git status' } }) });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('Given an assignment-prefixed commit, When the guard runs, Then it consults the review launcher of the kit root', async () => {
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'guard-kit-'));
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    const marker = path.join(kitRoot, 'reviewed.txt');
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('review: PASS\\n');\nprocess.exit(0);\n`, 'utf8');
    const result = run('scripts/hook-guard.mjs', ['--codex'], { input: JSON.stringify({ tool_input: { command: 'GIT_TRACE=1 FOO=bar git commit -m x' } }), env: { ...process.env, OMP_REVIEW_KIT_ROOT: kitRoot } });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /review passed/);
    assert.equal(await readFile(marker, 'utf8'), 'ran', 'the assignment-prefixed commit reached the review');
  } finally {
    await rm(kitRoot, REMOVE);
  }
});

test('Given an unknown host, When the installer runs, Then it prints usage and exits nonzero', () => {
  const result = run('scripts/host-install.mjs', ['--host', 'opncode']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('Given the installer in dry-run for OpenCode, Then it changes nothing and prints the plan', () => {
  const dir = path.join(os.tmpdir(), `oc-cli-${process.pid}-${Date.now()}`);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'host-install.mjs'), '--host', 'opencode'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, OPENCODE_CONFIG_DIR: dir },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dry run/);
});

test('Given an unreadable install manifest, When the installer applies, Then it reports refusal and exits nonzero', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-refused-cli-'));
  try {
    const configDir = path.join(root, 'opencode');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, INSTALL_MANIFEST), '{not json', 'utf8');
    const result = run('scripts/host-install.mjs', ['--host', 'opencode', '--apply'], {
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^refused —/);
    assert.match(result.stderr, /refused: the install manifest is unreadable/);
    await assert.rejects(readFile(path.join(configDir, 'opencode.json'), 'utf8'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a conflicting user agent, When installation is planned or applied, Then the existing profile stays unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-conflict-cli-'));
  try {
    const configDir = path.join(root, 'opencode');
    const asset = path.join(configDir, 'agents', 'reviewer-kit.md');
    const manifest = path.join(configDir, INSTALL_MANIFEST);
    const configText = JSON.stringify({ plugin: ['other-plugin'], model: 'user-model' }, null, 2);
    const manifestText = JSON.stringify({ version: '1.0.0', files: [] }, null, 2);
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), configText, 'utf8');
    await writeFile(asset, 'user-owned incompatible agent', 'utf8');
    await writeFile(manifest, manifestText, 'utf8');
    for (const args of [['--host', 'opencode'], ['--host', 'opencode', '--apply']]) {
      const result = run('scripts/host-install.mjs', args, {
        env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /agents\/reviewer-kit\.md/);
      assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), configText);
      assert.equal(await readFile(manifest, 'utf8'), manifestText);
      assert.equal(await readFile(asset, 'utf8'), 'user-owned incompatible agent');
      await assert.rejects(readFile(path.join(configDir, 'commands', 'review.md'), 'utf8'), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(configDir, 'agents', 'review-context-scout.md'), 'utf8'), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given an edited manifest-owned file, When the installer removes itself, Then it reports the preserved path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-preserved-cli-'));
  try {
    const configDir = path.join(root, 'opencode');
    const asset = path.join(configDir, 'agents', 'reviewer-kit.md');
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({
      plugin: ['omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git'],
    }), 'utf8');
    await writeFile(asset, 'user-edited agent', 'utf8');
    await writeFile(path.join(configDir, INSTALL_MANIFEST), JSON.stringify({
      version: '1.0.0',
      files: [{ path: 'agents/reviewer-kit.md', sha256: '0'.repeat(64) }],
    }), 'utf8');
    const result = run('scripts/host-install.mjs', ['--host', 'opencode', '--apply', '--remove'], {
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /preserved \(ignored\): agents\/reviewer-kit\.md/);
    assert.equal(await readFile(asset, 'utf8'), 'user-edited agent');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a repository without host manifests, When the sync check runs, Then it names the files and exits nonzero', () => {
  const dir = path.join(os.tmpdir(), `sync-cli-${process.pid}-${Date.now()}`);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-host-manifests.mjs'), '--check'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, cwd: ROOT,
  });
  assert.equal(result.status, 0, 'the real checkout is current');
  assert.ok(dir.length > 0);
});

test('Given a stale checkout, When the sync check runs against it, Then the stale and missing files are named', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sync-stale-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-host-manifests.mjs'), '--check'], { encoding: 'utf8', windowsHide: true, cwd: root, timeout: 60000 });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /disagree with package\.json 1\.0\.0/);
    const applied = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-host-manifests.mjs'), '--apply'], { encoding: 'utf8', windowsHide: true, cwd: root, timeout: 60000 });
    assert.equal(applied.status, 0);
    const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-host-manifests.mjs'), '--check'], { encoding: 'utf8', windowsHide: true, cwd: root, timeout: 60000 });
    assert.equal(again.status, 0, 'a second check on the applied tree is clean');
    const plugin = JSON.parse(await readFile(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '1.0.0');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given the layout gate, When a required host file is missing, Then it is rejected by name', async () => {
  const { REQUIRED_FILES } = await import('../src/infra/layout-required.mjs');
  for (const file of ['opencode/plugin.mjs', 'scripts/hook-guard.mjs', 'scripts/host-install.mjs', 'scripts/host-doctor.mjs', 'scripts/sync-host-manifests.mjs', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json']) {
    assert.ok(REQUIRED_FILES.includes(file), `${file} must be part of the distributed layout`);
  }
});

test('Given the layout check, When a host manifest is stale, Then the check fails and names it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'layout-stale-'));
  try {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const { generatedHostFiles } = await import('../src/domain/host-manifests.mjs');
    for (const file of generatedHostFiles({ version: pkg.version })) {
      const target = path.join(root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
    const stale = path.join(root, '.codex-plugin', 'plugin.json');
    await writeFile(stale, JSON.stringify({ name: 'omp-reviewer-kit', version: '0.0.1' }), 'utf8');
    const { checkHostManifests } = await import('../scripts/sync-host-manifests.mjs');
    const rows = await checkHostManifests({ root, version: pkg.version });
    assert.equal(rows.find(row => row.path === '.codex-plugin/plugin.json').status, 'stale');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a config that already has a sibling package, When the kit is installed and removed, Then the sibling survives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-identity-'));
  try {
    const configDir = path.join(root, 'opencode');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: ['omp-reviewer-kit-helper@1.0.0', 'other@1.0.0'] }), 'utf8');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    await applyOpenCode({ apply: true, remove: false, force: true, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    const installed = JSON.parse(await readFile(path.join(configDir, 'opencode.json'), 'utf8')).plugin;
    assert.ok(installed.includes('omp-reviewer-kit-helper@1.0.0'), 'a sibling package is not this kit');
    assert.ok(installed.some(entry => entry.startsWith('omp-reviewer-kit@')));
    await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    const removed = JSON.parse(await readFile(path.join(configDir, 'opencode.json'), 'utf8')).plugin;
    assert.deepEqual(removed, ['omp-reviewer-kit-helper@1.0.0', 'other@1.0.0']);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a directory with only a JSONC config, When the installer looks for the file, Then it uses the JSONC file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-jsonc-'));
  try {
    await writeFile(path.join(root, 'opencode.jsonc'), '{\n  // keep\n  "theme": "dark"\n}\n', 'utf8');
    const { openCodeConfigFile } = await import('../scripts/host-install.mjs');
    const found = await openCodeConfigFile(root);
    assert.equal(path.basename(found.path), 'opencode.jsonc');
    assert.equal(found.exists, true);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given both config files, When the installer looks for the file, Then the JSON file wins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-both-'));
  try {
    await writeFile(path.join(root, 'opencode.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'opencode.jsonc'), '{}', 'utf8');
    const { openCodeConfigFile } = await import('../scripts/host-install.mjs');
    const found = await openCodeConfigFile(root);
    assert.equal(path.basename(found.path), 'opencode.json');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a machine with two OMP install modes, When the doctor runs, Then it exits nonzero and names the conflict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'doctor-cli-'));
  try {
    await mkdir(path.join(root, '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit'), { recursive: true });
    await writeFile(path.join(root, '.omp', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'omp-reviewer-kit@omp-reviewer-kit': [{ scope: 'user', installPath: 'x', version: '1.0.0' }] } }), 'utf8');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'host-doctor.mjs')], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODE_CONFIG_DIR: path.join(root, 'oc') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /conflict:/);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given the OpenCode module, When the child review exits nonzero, Then the decision blocks with its reason', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href);
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-child-'));
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), "process.stdout.write('review: BLOCK (finding)\\n');\nprocess.exit(1);\n", 'utf8');
    const previous = process.env.OMP_REVIEW_KIT_ROOT;
    process.env.OMP_REVIEW_KIT_ROOT = kitRoot;
    try {
      const decision = module.runGuard('git commit -m x');
      assert.equal(decision.decision, 'block');
      assert.match(decision.reason, /blocked this commit/);
    } finally {
      if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROOT;
      else process.env.OMP_REVIEW_KIT_ROOT = previous;
    }
  } finally {
    await rm(kitRoot, REMOVE);
  }
});

test('Given the OpenCode module, When the child review exits zero, Then the decision allows', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href);
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-child-'));
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), "process.stdout.write('review: PASS\\n');\nprocess.exit(0);\n", 'utf8');
    const previous = process.env.OMP_REVIEW_KIT_ROOT;
    process.env.OMP_REVIEW_KIT_ROOT = kitRoot;
    try {
      assert.equal(module.runGuard('git commit -m x').decision, 'allow');
    } finally {
      if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROOT;
      else process.env.OMP_REVIEW_KIT_ROOT = previous;
    }
  } finally {
    await rm(kitRoot, REMOVE);
  }
});

test('Given the registered OpenCode hook, When a commit is blocked, Then the hook rejects with the reason, and a passing review resolves', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href);
  const hooks = await module.default.server();
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-hook-'));
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    const previous = process.env.OMP_REVIEW_KIT_ROOT;
    process.env.OMP_REVIEW_KIT_ROOT = kitRoot;
    try {
      await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), "process.stdout.write('review: BLOCK (finding)\\n');\nprocess.exit(1);\n", 'utf8');
      await assert.rejects(
        hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m x' } }),
        /blocked this commit/,
      );
      await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), "process.stdout.write('review: PASS\\n');\nprocess.exit(0);\n", 'utf8');
      await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git commit -m x' } });
    } finally {
      if (previous === undefined) delete process.env.OMP_REVIEW_KIT_ROOT;
      else process.env.OMP_REVIEW_KIT_ROOT = previous;
    }
  } finally {
    await rm(kitRoot, REMOVE);
  }
});

test('Given the OpenCode hook runs under Bun, When the review blocks a commit, Then the hook rejects it', async () => {
  const kitRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-bun-hook-'));
  try {
    await mkdir(path.join(kitRoot, 'scripts'), { recursive: true });
    await writeFile(path.join(kitRoot, 'scripts', 'run-review.mjs'), 'process.exit(1);\n', 'utf8');
    const moduleUrl = pathToFileURL(path.join(ROOT, 'opencode', 'plugin.mjs')).href;
    const code = `import { beforeTool } from ${JSON.stringify(moduleUrl)};\n`
      + `try { await beforeTool({ tool: 'bash' }, { args: { command: 'git commit -m x' } }); process.exitCode = 2; }\n`
      + `catch (error) { if (!/blocked this commit/.test(error.message)) process.exitCode = 3; }\n`;
    const result = spawnSync('bun', ['-e', code], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, OMP_REVIEW_KIT_ROOT: kitRoot },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    await rm(kitRoot, REMOVE);
  }
});

test('Given a user file with the same name, When the installer copies components, Then the user file is neither overwritten nor recorded', async () => {
  const kit = await mkdtemp(path.join(os.tmpdir(), 'oc-collide-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oc-collide-config-'));
  try {
    await mkdir(path.join(kit, 'opencode', 'agents'), { recursive: true });
    await mkdir(path.join(config, 'agents'), { recursive: true });
    await writeFile(path.join(kit, 'opencode', 'agents', 'reviewer.md'), '# kit reviewer\n', 'utf8');
    await writeFile(path.join(config, 'agents', 'reviewer.md'), '# my own agent\n', 'utf8');
    const { copyComponents } = await import('../scripts/host-install.mjs');
    const { copied, conflicts } = await copyComponents({ configDir: config, kitRoot: kit });
    assert.deepEqual(copied, []);
    assert.deepEqual(conflicts, ['agents/reviewer.md']);
    assert.equal(await readFile(path.join(config, 'agents', 'reviewer.md'), 'utf8'), '# my own agent\n', 'the user file survives');
  } finally {
    await rm(kit, REMOVE);
    await rm(config, REMOVE);
  }
});

test('Given a stale generated manifest, When the layout gate checks it, Then it throws naming the file', async () => {
  const { assertHostManifestsCurrent } = await import('../scripts/sync-host-manifests.mjs');
  const rows = [
    { path: '.agents/plugins/marketplace.json', status: 'stale' },
    { path: '.codex-plugin/plugin.json', status: 'current' },
  ];
  assert.throws(() => assertHostManifestsCurrent(rows, '9.9.9'), /\.agents\/plugins\/marketplace\.json/);
  assert.equal(assertHostManifestsCurrent([{ path: 'x', status: 'current' }], '9.9.9'), undefined);
});


test('Given the layout gate, When it evaluates host manifests, Then it throws through the shared decision instead of ignoring them', async () => {
  const { checkHostManifests, assertHostManifestsCurrent } = await import('../scripts/sync-host-manifests.mjs');
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const rows = await checkHostManifests({ root: ROOT, version: pkg.version });
  assert.equal(assertHostManifestsCurrent(rows, pkg.version), undefined, 'the checkout is current');
  const stale = rows.map((row, index) => (index === 0 ? { ...row, status: 'stale' } : row));
  assert.throws(() => assertHostManifestsCurrent(stale, pkg.version), /host manifests disagree/);
});

test('Given an otherwise valid checkout with one stale generated manifest, When the layout gate runs there, Then it exits nonzero and names the file', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'layout-fixture-'));
  try {
    const { cp } = await import('node:fs/promises');
    for (const entry of await readdir(ROOT)) {
      if (['node_modules', '.git', 'audit-reports'].includes(entry)) continue;
      await cp(path.join(ROOT, entry), path.join(fixture, entry), { recursive: true, force: true });
    }
    const manifest = path.join(fixture, '.codex-plugin', 'plugin.json');
    const document = JSON.parse(await readFile(manifest, 'utf8'));
    document.description = 'a change the generator would not write';
    await writeFile(manifest, JSON.stringify(document, null, 2), 'utf8');
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'check-layout.mjs')], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.notEqual(result.status, 0, 'a stale generated manifest must fail the layout gate');
    assert.match(String(result.stderr), /\.codex-plugin\/plugin\.json/);
  } finally {
    await rm(fixture, REMOVE);
  }
});

test('Given two applies to the same config, When the kit is removed afterwards, Then every component the first apply copied is deleted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-twice-'));
  try {
    const configDir = path.join(root, 'opencode');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    await applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    const second = await applyOpenCode({ apply: true, remove: false, force: true, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    assert.deepEqual(second.conflicts, []);
    await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    await assert.rejects(readFile(path.join(configDir, 'agents', 'reviewer-kit.md'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(configDir, 'commands', 'review.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a config with only a sibling package, When OpenCode is inspected, Then this kit is not reported installed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-sibling-'));
  try {
    const configDir = path.join(root, 'oc');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: ['omp-reviewer-kit-helper@1.0.0'] }), 'utf8');
    const { inspectOpenCode } = await import('../scripts/host-doctor.mjs');
    const opencode = await inspectOpenCode({ env: { OPENCODE_CONFIG_DIR: configDir }, home: root });
    assert.equal(opencode.installed, false);
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given the mutation gate, When a worker copies the tree, Then every host directory the catalog mutates is copied', async () => {
  const { DIRECTORIES_TO_COPY } = await import('../scripts/mutation-runner.mjs');
  for (const root of ['.codex-plugin', '.agents', 'opencode']) {
    assert.ok(DIRECTORIES_TO_COPY.includes(root), `${root} must be copied into the worker tree`);
  }
});

test('Given a manifest entry that escapes the config directory, When the kit is removed, Then the outside path is kept and reported', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-escape-'));
  try {
    const configDir = path.join(root, 'opencode');
    await mkdir(configDir, { recursive: true });
    const outside = path.join(root, 'important-file.txt');
    await writeFile(outside, 'keep me', 'utf8');
    await writeFile(path.join(configDir, '.omp-reviewer-kit-manifest.json'), JSON.stringify({ version: '1.0.0', files: ['../important-file.txt'] }), 'utf8');
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: ['omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git'] }), 'utf8');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    const result = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    assert.deepEqual(result.ignored, ['../important-file.txt']);
    assert.equal(await readFile(outside, 'utf8'), 'keep me', 'a path outside the config dir is never deleted');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a manifest that names the config root, When the kit is removed, Then the root and its files survive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-root-'));
  try {
    const configDir = path.join(root, 'opencode');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), '{"kept":true}', 'utf8');
    await writeFile(path.join(configDir, '.omp-reviewer-kit-manifest.json'), JSON.stringify({ version: '1.0.0', files: ['.'] }), 'utf8');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    const result = await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    assert.deepEqual(result.ignored, ['.']);
    assert.equal(await readFile(path.join(configDir, 'settings.json'), 'utf8'), '{"kept":true}');
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given no OpenCode config at all, When a removal runs, Then no config file is created', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-noconfig-'));
  try {
    const configDir = path.join(root, 'opencode');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    await applyOpenCode({ apply: true, remove: true, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    await assert.rejects(readFile(path.join(configDir, 'opencode.json'), 'utf8'));
  } finally {
    await rm(root, REMOVE);
  }
});

test('Given a truncated config, When an install runs, Then the file is left exactly as it was', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-broken-'));
  try {
    const configDir = path.join(root, 'opencode');
    await mkdir(configDir, { recursive: true });
    const broken = '{"theme":"dark"';
    await writeFile(path.join(configDir, 'opencode.json'), broken, 'utf8');
    const { applyOpenCode } = await import('../scripts/host-install.mjs');
    const result = await applyOpenCode({ apply: true, remove: false, force: false, env: { OPENCODE_CONFIG_DIR: configDir }, home: root, kitRoot: ROOT });
    assert.match(String(result.refused), /closing brace/);
    assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), broken, 'a broken config is never replaced');
  } finally {
    await rm(root, REMOVE);
  }
});
