import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { describe, it } from 'node:test';
import { ReviewPrompt } from '../src/index.mjs';

const isLiveE2E = process.env.OMP_REVIEW_KIT_LIVE_E2E === '1';

const hasOmp = (() => {
  try {
    const res = spawnOmpSync(['--version'], { encoding: 'utf8', windowsHide: true });
    return res.status === 0;
  } catch {
    return false;
  }
})();

function ompInvocation(commandArgs) {
  const ompCommand = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
  if (/\.(cmd|bat)$/i.test(ompCommand)) {
    return {
      executable: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', 'call', ompCommand, ...commandArgs],
    };
  }
  return { executable: ompCommand, args: commandArgs };
}

function spawnOmpSync(commandArgs, options = {}) {
  const invocation = ompInvocation(commandArgs);
  return spawnSync(invocation.executable, invocation.args, options);
}

function spawnOmp(commandArgs, options = {}) {
  const invocation = ompInvocation(commandArgs);
  return spawn(invocation.executable, invocation.args, options);
}

/**
 * Runs a real OMP command with piped stdin and closed EOF.
 */
function runLiveOmp(prompt, cwd, timeoutMs = 600_000, extraEnv = {}) {
  const commandArgs = ['-p', '--model', process.env.OMP_REVIEW_KIT_MODEL ?? '@slow', '--no-session'];

  return new Promise((resolve, reject) => {
    const proc = spawnOmp(commandArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Live OMP process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.on('error', () => {});
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {
      // Ignore write errors on closed streams
    }
  });
}


function resolveAgentDir(profile) {
  const args = [...(profile ? ['--profile', profile] : []), 'config', 'path'];
  const result = spawnOmpSync(args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Failed to resolve OMP config path: ${result.stderr}`);
  return result.stdout.trim();
}

async function copyDefaultProfileConfig(targetAgentDir) {
  const defaultAgentDir = resolveAgentDir();
  await mkdir(targetAgentDir, { recursive: true });
  for (const filename of ['models.yml', 'config.yml', 'agent.db']) {
    await copyFile(path.join(defaultAgentDir, filename), path.join(targetAgentDir, filename));
  }
}

function gitAt(repoDir) {
  return (args, options = {}) => spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

async function writeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

function extractNormalizedEnvelope(report) {
  const match = report.match(/## Normalized rejection envelope\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(match, 'BLOCK report must contain a normalized rejection envelope');
  return JSON.parse(match[1]);
}

const LIVE_REVIEW_CASES = [
  {
    name: 'blocks 41 internal CLI wrappers around an existing service',
    expected: 'BLOCK',
    stagedPath: 'src/internal-step-clis.mjs',
    nativeEvidence: /WorkflowService|advance/i,
    baseline: {
      'ARCHITECTURE.md': 'Internal workflow progression is owned by WorkflowService.advance and is called in-process. Internal subprocess CLIs add no product capability.\n',
      'src/workflow-service.mjs': 'export class WorkflowService { advance(state) { return { ...state, step: state.step + 1 }; } }\n',
    },
    stagedContent: [
      "import { spawnSync } from 'node:child_process';",
      ...Array.from({ length: 41 }, (_, index) => `export function internalStep${index + 1}(state) { return spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(' + JSON.stringify(state) + '))']); }`),
      '',
    ].join('\n'),
  },
  {
    name: 'blocks local Ed25519 trust store for APPROVE',
    expected: 'BLOCK',
    stagedPath: 'src/local-approval-pki.mjs',
    nativeEvidence: /ApprovalState|local|boolean|enum/i,
    baseline: {
      'ARCHITECTURE.md': 'This is a single-user local tool. ApprovalState.approve owns the APPROVE boolean; there is no remote trust boundary.\n',
      'src/approval-state.mjs': 'export class ApprovalState { approve() { return { decision: \"APPROVE\" }; } }\n',
    },
    stagedContent: "import { generateKeyPairSync, sign, verify } from 'node:crypto';\nexport class LocalApprovalTrustStore { constructor() { this.keys = generateKeyPairSync('ed25519'); } approve() { const value = Buffer.from('APPROVE'); const signature = sign(null, value, this.keys.privateKey); return verify(null, value, this.keys.publicKey, signature); } }\n",
  },
  {
    name: 'blocks exit 20 human inbox beside LangGraph interrupt',
    expected: 'BLOCK',
    stagedPath: 'src/human-inbox.mjs',
    nativeEvidence: /interrupt|SQLite|checkpointer/i,
    baseline: {
      'ARCHITECTURE.md': 'Workflow pauses use LangGraph interrupt with the SQLite checkpointer; it already persists and resumes human input.\n',
      'src/workflow.mjs': 'export function pauseForHuman(interrupt, state) { return interrupt({ question: state.question }); }\n',
    },
    stagedContent: "import { mkdir, writeFile } from 'node:fs/promises';\nexport async function pauseWithHumanInbox(runId, payload) { await mkdir('human-inbox', { recursive: true }); await writeFile('human-inbox/' + runId + '.json', JSON.stringify(payload)); process.exitCode = 20; }\n",
  },
  {
    name: 'blocks 28 process receipts replacing product tests',
    expected: 'BLOCK',
    stagedPath: 'src/implementation-task-proofs.mjs',
    nativeEvidence: /product|node:test|behavior/i,
    baseline: {
      'ARCHITECTURE.md': 'Observable product behavior is verified with node:test BDD scenarios. Authoring-process receipts are not product evidence.\n',
      'src/product.mjs': 'export function total(values) { return values.reduce((sum, value) => sum + value, 0); }\n',
      'test/product.test.mjs': "import assert from 'node:assert/strict'; import test from 'node:test'; import { total } from '../src/product.mjs'; test('totals values', () => assert.equal(total([1, 2]), 3));\n",
    },
    stagedContent: `export class ImplementationTaskProofBodyV1 { constructor(step, stdout, commitHash) { this.step = step; this.stdout = stdout; this.commitHash = commitHash; } }\nexport const requiredProofs = Array.from({ length: 28 }, (_, index) => new ImplementationTaskProofBodyV1(index + 1, '', 'pending'));\nexport function allImplementationStepsProven() { return requiredProofs.length === 28; }\n`,
  },
  {
    name: 'blocks unbounded capture command beside native logger',
    expected: 'BLOCK',
    stagedPath: 'src/capture-command.mjs',
    nativeEvidence: /logger|logCommand/i,
    baseline: {
      'ARCHITECTURE.md': 'Command observability uses logger.logCommand with bounded structured domain events. Raw binary capture has no product consumer.\n',
      'src/logger.mjs': 'export const logger = { logCommand(event) { return JSON.stringify({ command: event.command, status: event.status }); } };\n',
    },
    stagedContent: "import { spawnSync } from 'node:child_process'; import { appendFileSync } from 'node:fs';\nexport function captureCommand(command, args) { const result = spawnSync(command, args, { encoding: null, maxBuffer: Number.MAX_SAFE_INTEGER }); appendFileSync('.audit/all-command-bytes.bin', Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)])); return result; }\n",
  },
  {
    name: 'passes Port Adapter and Template Method for new capability',
    expected: 'PASS',
    stagedPath: 'src/export-transport.mjs',
    baseline: { 'ARCHITECTURE.md': 'The product needs a new remote export capability with one invariant shared by transports.\n' },
    stagedContent: `export class ExportPort { async export(_document) { throw new Error('ExportPort.export must be implemented'); } }\nexport class GovernedExportTransport extends ExportPort { async export(document) { if (!document.id) throw new TypeError('document id required'); return this.send(document); } async send(_document) { throw new Error('send must be implemented'); } }\nexport class JsonHttpExportAdapter extends GovernedExportTransport { constructor(post) { super(); this.post = post; } async send(document) { return this.post('/exports', JSON.stringify(document)); } }\n`,
  },
  {
    name: 'passes a public user-facing CLI boundary',
    expected: 'PASS',
    stagedPath: 'src/public-cli.mjs',
    baseline: { 'ARCHITECTURE.md': 'A public CLI is the supported user interface for local and CI consumers.\n' },
    stagedContent: `export function parseGreeting(args) { const index = args.indexOf('--name'); if (index < 0 || !args[index + 1]) throw new TypeError('Usage: greet --name NAME'); return { name: args[index + 1] }; }\nexport function runGreeting(args, output) { const { name } = parseGreeting(args); output.write('Hello, ' + name + '\n'); }\n`,
  },
  {
    name: 'passes cryptography for remote untrusted payload',
    expected: 'PASS',
    stagedPath: 'src/remote-webhook-verifier.mjs',
    baseline: { 'ARCHITECTURE.md': 'Webhook payloads arrive from a remote untrusted network boundary and must be authenticated before processing.\n' },
    stagedContent: `import { verify } from 'node:crypto';\nexport function verifyRemoteWebhook(payload, signature, trustedPublicKey) { if (!Buffer.isBuffer(payload) || !Buffer.isBuffer(signature)) throw new TypeError('binary payload and signature required'); return verify(null, payload, trustedPublicKey, signature); }\n`,
  },
];

async function runLiveReviewCase(reviewCase) {
  const profile = `omp-rev-matrix-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-matrix-'));
  const repoDir = path.join(baseDir, 'repo');
  const agentDir = resolveAgentDir(profile);
  const profileDir = path.dirname(agentDir);
  const packageRoot = path.resolve(process.env.OMP_REVIEW_KIT_LIVE_PACKAGE_ROOT ?? '.');
  const model = process.env.OMP_REVIEW_KIT_MODEL;
  assert.ok(model, 'OMP_REVIEW_KIT_MODEL must select one available model for the live matrix');
  await mkdir(repoDir, { recursive: true });

  try {
    await copyDefaultProfileConfig(agentDir);
    const install = spawnOmpSync(['--profile', profile, 'plugin', 'install', packageRoot], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(install.status, 0, `Plugin install failed for ${reviewCase.name}: ${install.stderr}`);

    const git = gitAt(repoDir);
    assert.equal(git(['init']).status, 0);
    git(['config', 'user.name', 'Live Matrix Test']);
    git(['config', 'user.email', 'live-matrix@test.local']);
    await writeTree(repoDir, reviewCase.baseline);
    git(['add', '.']);
    const baseline = git(['commit', '--no-verify', '-m', 'Baseline native architecture']);
    assert.equal(baseline.status, 0, baseline.stderr);

    const setup = spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'setup-hook.mjs'), repoDir], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(setup.status, 0, `Hook setup failed: ${setup.stderr}`);

    await writeTree(repoDir, { [reviewCase.stagedPath]: reviewCase.stagedContent });
    git(['add', reviewCase.stagedPath]);
    const stagedBefore = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']).stdout;
    assert.notEqual(stagedBefore.length, 0);

    const commit = git(['commit', '-m', `Review matrix ${reviewCase.expected}`], {
      env: {
        ...process.env,
        OMP_PROFILE: profile,
        OMP_REVIEW_KIT_MODEL: model,
        OMP_REVIEW_KIT_MAX_FALLBACKS: '0',
      },
      timeout: 900_000,
    });
    const output = commit.stdout + commit.stderr;

    if (reviewCase.expected === 'PASS') {
      assert.equal(commit.status, 0, `Expected PASS for ${reviewCase.name}\n${output}`);
      assert.equal((output.match(/reviewer-kit PASS:/g) ?? []).length, 1);
      assert.doesNotMatch(output, /REVIEW_REJECTION_(?:ENVELOPE|REPORT)/);
      assert.match(git(['log', '-1', '--pretty=%s']).stdout, /Review matrix PASS/);
      return;
    }

    assert.notEqual(commit.status, 0, `Expected BLOCK for ${reviewCase.name}\n${output}`);
    const pointers = [...output.matchAll(/^REVIEW_REJECTION_REPORT=(.+)$/gm)];
    assert.equal(pointers.length, 1, output);
    const reportPath = pointers[0][1].trim();
    const report = await readFile(reportPath, 'utf8');
    const envelope = extractNormalizedEnvelope(report);
    assert.equal(envelope.kind, 'confirmed_findings', report);
    assert.ok(envelope.findings.length >= 1, report);
    const finding = envelope.findings.find((item) => item.file_path === reviewCase.stagedPath);
    assert.ok(finding, `Missing finding for ${reviewCase.stagedPath}\n${report}`);
    assert.equal(finding.priority, 'P2');
    assert.equal(finding.defect_class, 'correctness');
    assert.ok(finding.line_start >= 1 && finding.line_end <= reviewCase.stagedContent.split('\n').length);
    assert.match(finding.verifier_argument + ' ' + finding.counterexample, reviewCase.nativeEvidence);
    assert.match(finding.verifier_argument + ' ' + finding.counterexample, /adds? no|no (?:new )?(?:product|user-facing|domain)|only (?:wraps|duplicates|reimplements)|same responsibility|duplicate/i);
    assert.equal(git(['diff', '--cached', '--binary', '--no-ext-diff', '--']).stdout, stagedBefore);
    assert.doesNotMatch(git(['log', '-1', '--pretty=%s']).stdout, /Review matrix BLOCK/);
  } finally {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('Feature: Real Live OMP & Plugin Discovery E2E (No Mocks)', () => {
  it('Live Check 1: OMP plugin doctor confirms omp-reviewer-kit is linked and healthy', { skip: !hasOmp }, () => {
    const res = spawnOmpSync(['plugin', 'doctor'], { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, `omp plugin doctor failed: ${res.stderr}`);
    assert.match(res.stdout, /plugin:omp-reviewer-kit/);
  });

  it('Live Check 2: OMP native task discovery detects reviewer-kit and all specialist agents', { skip: !hasOmp }, async () => {
    const defaultDiscoveryPath = path.join(path.dirname(resolveAgentDir()), 'plugins', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'task', 'discovery.ts');
    let discoverAgents;
    try {
      const discoveryModulePath = pathToFileURL(defaultDiscoveryPath).href;
      const mod = await import(discoveryModulePath);
      discoverAgents = mod.discoverAgents;
    } catch {
      // Ignore if global discovery module path differs
    }

    if (discoverAgents) {
      const res = await discoverAgents(path.resolve('.'));

      // 1. Orchestrator: reviewer-kit
      const reviewerKit = res.agents.find((a) => a.name === 'reviewer-kit');
      assert.ok(reviewerKit, 'reviewer-kit must be discovered in OMP task agents list');
      assert.equal(reviewerKit.name, 'reviewer-kit');
      assert.deepEqual(reviewerKit.model, ['@slow']);
      assert.equal(reviewerKit.blocking, true);
      assert.ok(reviewerKit.spawns, 'reviewer-kit must declare spawns allowlist');
      assert.deepEqual(reviewerKit.autoloadSkills, ['reality-first-review', 'multi-stage-review']);
      assert.ok(!reviewerKit.tools.includes('edit'), 'reviewer-kit must not have edit');
      assert.ok(!reviewerKit.tools.includes('write'), 'reviewer-kit must not have write');

      // 2. Context Scout
      const scout = res.agents.find((a) => a.name === 'review-context-scout');
      assert.ok(scout, 'review-context-scout must be discovered');
      assert.equal(scout.blocking, true);
      assert.deepEqual(scout.model, ['@task']);
      assert.ok(!scout.tools.includes('task'), 'scout must not have task');
      assert.ok(!scout.tools.includes('edit') && !scout.tools.includes('write'));

      // 3. Risk Hunter
      const hunter = res.agents.find((a) => a.name === 'review-risk-hunter');
      assert.ok(hunter, 'review-risk-hunter must be discovered');
      assert.equal(hunter.blocking, true);
      assert.deepEqual(hunter.model, ['@slow']);
      assert.ok(!hunter.tools.includes('task'), 'hunter must not have task');
      assert.ok(!hunter.tools.includes('edit') && !hunter.tools.includes('write'));

      // 4. Finding Verifier
      const verifier = res.agents.find((a) => a.name === 'review-finding-verifier');
      assert.ok(verifier, 'review-finding-verifier must be discovered');
      assert.equal(verifier.blocking, true);
      assert.deepEqual(verifier.model, ['@slow']);
      assert.ok(!verifier.tools.includes('task'), 'verifier must not have task');
      assert.ok(!verifier.tools.includes('edit') && !verifier.tools.includes('write'));
    }
  });

  it('Live Check 3: Real OMP clean staged fixture executes hierarchy and emits REVIEW_RESULT=PASS', { skip: !isLiveE2E }, async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-pass-'));
    const repoDir = path.join(baseDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    try {
      const git = (args, options = {}) =>
        spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true, ...options });
      git(['init']);
      git(['config', 'user.name', 'Live Pass Test']);
      git(['config', 'user.email', 'live-pass@test.local']);

      // Stage a clean, verified file
      const testFile = path.join(repoDir, 'sample.txt');
      await writeFile(testFile, 'Clean production code adhering strictly to domain invariants.\n', 'utf8');
      git(['add', 'sample.txt']);

      const diffRes = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']);
      assert.notEqual(diffRes.stdout.length, 0);

      const prompt = ReviewPrompt.forDiff(diffRes.stdout).toString();
      const result = await runLiveOmp(prompt, repoDir, 600_000);

      assert.equal(result.status, 0, `OMP execution failed with status ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /REVIEW_RESULT=PASS/);
      assert.match(result.stdout, /coverage|findings/i);
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Live Check 4: Real OMP violating staged fixture with project skill emits REVIEW_RESULT=BLOCK', { skip: !isLiveE2E }, async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-block-'));
    const repoDir = path.join(baseDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    try {
      const git = (args, options = {}) =>
        spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true, ...options });
      git(['init']);
      git(['config', 'user.name', 'Live Block Test']);
      git(['config', 'user.email', 'live-block@test.local']);

      // Create a temporary project review skill with an exact invariant
      const skillDir = path.join(repoDir, '.omp', 'skills', 'zero-div-guard');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: zero-div-guard',
          'description: Invariant rule: forbid literal division by zero in calculation modules.',
          '---',
          '# Zero Division Rule',
          'Any division where denominator is literal zero (e.g. `n / 0`) is strictly prohibited and must be blocked.',
        ].join('\n'),
        'utf8'
      );

      // Stage a file violating the project skill rule
      const testFile = path.join(repoDir, 'calc.js');
      await writeFile(testFile, 'export function divide(x) {\n  return x / 0;\n}\n', 'utf8');
      git(['add', 'calc.js']);

      const diffRes = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']);
      assert.notEqual(diffRes.stdout.length, 0);

      const prompt = ReviewPrompt.forDiff(diffRes.stdout).toString();
      const result = await runLiveOmp(prompt, repoDir, 600_000);

      assert.equal(result.status, 0, `OMP execution failed with status ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /REVIEW_RESULT=BLOCK/);
      assert.match(result.stdout, /calc\.js|zero|divide/i);
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Live Check 5: Isolated named profile with automatic hook setup and dynamic user skill evolution', { skip: !isLiveE2E }, async () => {
    const profName = `omp-rev-live-${Date.now()}`;
    const baseDir = await mkdtemp(path.join(tmpdir(), 'omp-live-profile-'));
    const repoDir = path.join(baseDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    let profileDir;
    try {
      const git = (args, options = {}) =>
        spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true, ...options });
      git(['init']);
      git(['config', 'user.name', 'Profile E2E Test']);
      git(['config', 'user.email', 'profile-e2e@test.local']);

      // 1. Resolve profile directory
      const pathRes = spawnOmpSync(['--profile', profName, 'config', 'path'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(pathRes.status, 0, `Failed to resolve profile path: ${pathRes.stderr}`);
      const agentDir = pathRes.stdout.trim();
      profileDir = path.dirname(agentDir);
      await mkdir(agentDir, { recursive: true });

      // Copy auth and model configuration from the dynamically resolved default profile.
      await copyDefaultProfileConfig(agentDir);

      // 2. Install current plugin into the isolated profile
      const pluginInstallRes = spawnOmpSync(['--profile', profName, 'plugin', 'install', path.resolve(process.env.OMP_REVIEW_KIT_LIVE_PACKAGE_ROOT ?? '.')], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(pluginInstallRes.status, 0, `Plugin install failed: ${pluginInstallRes.stderr}`);

      // 3. Launch OMP in repoDir to trigger session_start auto-setup without running /reviewer-kit:setup
      const probeProc = spawnOmp(['--profile', profName, '-p', '--no-session', 'echo auto-setup'], {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      probeProc.stdin.write('test\n');
      probeProc.stdin.end();
      await new Promise((resolve) => {
        probeProc.on('close', resolve);
        setTimeout(() => {
          probeProc.kill();
          resolve();
        }, 30_000);
      });

      // Verify that session_start installed the hook and runner
      const hookStat = await stat(path.join(repoDir, '.githooks', 'pre-commit'));
      assert.equal(hookStat.isFile(), true, 'Pre-commit hook must be created automatically');

      const runnerStat = await stat(path.join(repoDir, '.omp', 'review-kit', 'run-review.mjs'));
      assert.equal(runnerStat.isFile(), true, 'Runner script must be created automatically');

      const coreHooksRes = git(['config', '--get', 'core.hooksPath']);
      assert.equal(coreHooksRes.stdout.trim(), '.githooks', 'core.hooksPath must be set to .githooks');

      // 4. Create user skill forbidding REVIEW_SENTINEL_V1
      const userSkillDir = path.join(agentDir, 'skills', 'dynamic-review-e2e');
      await mkdir(userSkillDir, { recursive: true });
      const userSkillFile = path.join(userSkillDir, 'SKILL.md');

      await writeFile(
        userSkillFile,
        [
          '---',
          'name: dynamic-review-e2e',
          'description: Enforces rejection of sentinel tokens in commit reviews.',
          '---',
          '# Sentinel Rejection Rule',
          'Any file containing token REVIEW_SENTINEL_V1 is strictly prohibited and must be blocked with P1 finding.',
        ].join('\n'),
        'utf8'
      );

      // Stage file containing REVIEW_SENTINEL_V1
      const v1File = path.join(repoDir, 'token.txt');
      await writeFile(v1File, 'const token = "REVIEW_SENTINEL_V1";\n', 'utf8');
      git(['add', 'token.txt']);

      // Attempt real git commit with OMP_PROFILE
      const commitRes1 = git(['commit', '-m', 'Commit with V1 token'], {
        env: {
          ...process.env,
          OMP_PROFILE: profName,
        },
      });

      // Must be BLOCKED and cite the rule or sentinel
      assert.notEqual(
        commitRes1.status,
        0,
        `Commit with REVIEW_SENTINEL_V1 must be blocked.\nstdout: ${commitRes1.stdout}\nstderr: ${commitRes1.stderr}`
      );
      assert.match(commitRes1.stdout + commitRes1.stderr, /reviewer-kit BLOCK/);

      // 5. Update the same skill in-place: permit V1, forbid REVIEW_SENTINEL_V2
      await writeFile(
        userSkillFile,
        [
          '---',
          'name: dynamic-review-e2e',
          'description: Enforces rejection of sentinel tokens in commit reviews.',
          '---',
          '# Sentinel Rejection Rule',
          'REVIEW_SENTINEL_V1 is permitted. Any file containing token REVIEW_SENTINEL_V2 is strictly prohibited and must be blocked with P1 finding.',
        ].join('\n'),
        'utf8'
      );

      // Stage file containing REVIEW_SENTINEL_V2
      await writeFile(v1File, 'const token = "REVIEW_SENTINEL_V2";\n', 'utf8');
      git(['add', 'token.txt']);

      // Attempt real git commit with OMP_PROFILE
      const commitRes2 = git(['commit', '-m', 'Commit with V2 token'], {
        env: {
          ...process.env,
          OMP_PROFILE: profName,
        },
      });

      // Must be BLOCKED and reflect the newly updated skill requirement
      assert.notEqual(
        commitRes2.status,
        0,
        `Commit with REVIEW_SENTINEL_V2 must be blocked.\nstdout: ${commitRes2.stdout}\nstderr: ${commitRes2.stderr}`
      );
      assert.match(commitRes2.stdout + commitRes2.stderr, /reviewer-kit BLOCK/);

      // Verify commit reports were written to audit-reports/commit-reviews/
      const reportsDir = path.join(repoDir, 'audit-reports', 'commit-reviews');
      const reportFiles = await readdir(reportsDir);
      assert.ok(reportFiles.length >= 2, 'Audit reports must be created for both blocked commits');
    } finally {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
      if (profileDir) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  for (const reviewCase of LIVE_REVIEW_CASES) {
    it(`Live Matrix: ${reviewCase.name}`, { skip: !isLiveE2E }, async () => {
      await runLiveReviewCase(reviewCase);
    });
  }
});
