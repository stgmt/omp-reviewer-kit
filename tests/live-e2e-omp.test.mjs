/**
 * Live E2E test suite for omp-reviewer-kit against real OMP processes.
 *
 * Live-Run Convention:
 * - Environment Variables:
 *     OMP_REVIEW_KIT_LIVE_E2E=1     Enable live test execution (otherwise skipped).
 *     OMP_REVIEW_KIT_MODEL=<@role>  Primary model role (e.g. @smol, @slow; concrete selectors are rejected).
 *     OMP_REVIEW_KIT_EFFORT=<effort> Optional thinking-level override mapped to omp --thinking (e.g. low, medium, high).
 * - Logging Convention:
 *     Live test output and traces MUST be directed to %TEMP% or a system temp directory,
 *     using tee if console streaming is desired:
 *       OMP_REVIEW_KIT_LIVE_E2E=1 node --test tests/live-e2e-omp.test.mjs 2>&1 | tee %TEMP%\live-e2e.log
 *     NEVER write or redirect live execution logs into the repository tree.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDirectExecution = Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)));
import test, { after, describe, it } from 'node:test';
import { ReviewPrompt } from '../src/index.mjs';

const isLiveE2E = process.env.OMP_REVIEW_KIT_LIVE_E2E === '1';
export const INFRA_RETRY_PATTERN = /RESOURCE_EXHAUSTED|429|socket connection was closed|timed out/i;

export const DEFAULT_EVIDENCE_PATTERN = /adds? no|(?:no|not) (?:a |new )?(?:product|user-facing|domain)|only (?:wraps|duplicates|reimplements)|same responsibility|duplicate|true by construction|red_proof|cannot fail|never fail|vacuous|tautolog|unexercised|no test coverage/i;


const hasOmp = (() => {
  try {
    const res = spawnOmpSync(['--version'], { encoding: 'utf8', windowsHide: true });
    return res.status === 0;
  } catch {
    return false;
  }
})();

function ompInvocation(commandArgs, ompCommand = process.env.OMP_REVIEW_KIT_OMP ?? 'omp') {
  if (/\.(cmd|bat)$/i.test(ompCommand)) {
    return {
      executable: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', 'call', ompCommand, ...commandArgs],
    };
  }
  return { executable: ompCommand, args: commandArgs };
}

export function spawnOmpSync(commandArgs, options = {}) {
  const invocation = ompInvocation(commandArgs);
  return spawnSync(invocation.executable, invocation.args, options);
}

function spawnOmp(commandArgs, options = {}, ompCommand) {
  const invocation = ompInvocation(commandArgs, ompCommand);
  return spawn(invocation.executable, invocation.args, options);
}

const liveOmpProcs = new Set();

function killProcessTree(proc) {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // Fall back to the single-process kill below
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // Already exited
  }
}

if (isDirectExecution) {
  after(() => {
    for (const proc of liveOmpProcs) killProcessTree(proc);
    liveOmpProcs.clear();
  });
}

/**
 * Executes a single attempt of a real OMP command with piped stdin and closed EOF.
 */
function executeLiveOmpAttempt(prompt, cwd, timeoutMs = 600_000, extraEnv = {}, ompCommand) {
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
    }, ompCommand);
    liveOmpProcs.add(proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      killProcessTree(proc);
      liveOmpProcs.delete(proc);
      reject(new Error(
        `Live OMP process timed out after ${timeoutMs}ms\n` +
        `--- stdout tail ---\n${stdout.slice(-2000)}\n` +
        `--- stderr tail ---\n${stderr.slice(-2000)}`
      ));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      liveOmpProcs.delete(proc);
      resolve({
        status: code,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      liveOmpProcs.delete(proc);
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

/**
 * Runs a real OMP command with piped stdin, closed EOF, and retry-once on infra failures.
 *
 * Rejects with partial stdout/stderr tails on timeout so a hung model call
 * still shows what OMP produced instead of a bare timeout message. On Windows
 * the whole process tree is killed, not just the cmd wrapper.
 */
export async function runLiveOmp(prompt, cwd, timeoutMs = 600_000, extraEnv = {}, ompCommand) {
  try {
    const result = await executeLiveOmpAttempt(prompt, cwd, timeoutMs, extraEnv, ompCommand);
    if (result.status !== 0 && INFRA_RETRY_PATTERN.test(result.combined)) {
      const match = result.combined.match(INFRA_RETRY_PATTERN)[0];
      console.warn(`[runLiveOmp] Infra failure detected (${match}) with exit status ${result.status}. Retrying once (attempt 2/2)...`);
      return await executeLiveOmpAttempt(prompt, cwd, timeoutMs, extraEnv, ompCommand);
    }
    return result;
  } catch (err) {
    const isTimeout = /timed out/i.test(err.message);
    const match = err.message.match(INFRA_RETRY_PATTERN);
    if (isTimeout || match) {
      const signature = match ? match[0] : 'timed out';
      console.warn(`[runLiveOmp] Infra failure / timeout detected (${signature}). Retrying once (attempt 2/2)...`);
      return await executeLiveOmpAttempt(prompt, cwd, timeoutMs, extraEnv, ompCommand);
    }
    throw err;
  }
}


export function resolveAgentDir(profile) {
  const args = [...(profile ? ['--profile', profile] : []), 'config', 'path'];
  const result = spawnOmpSync(args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Failed to resolve OMP config path: ${result.stderr}`);
  return result.stdout.trim();
}

export async function copyDefaultProfileConfig(targetAgentDir) {
  const defaultAgentDir = resolveAgentDir();
  await mkdir(targetAgentDir, { recursive: true });
  for (const filename of ['models.yml', 'config.yml', 'agent.db', 'models.db']) {
    await copyFile(path.join(defaultAgentDir, filename), path.join(targetAgentDir, filename));
  }
  // The default profile spills tool output above ~15KB into session artifacts.
  // Live matrix reviews run through a wrapper that keeps session persistence,
  // but the spill knob is still relaxed so oversized tool results stay inline
  // instead of depending on artifact reads inside a throwaway profile.
  const configPath = path.join(targetAgentDir, 'config.yml');
  const config = await readFile(configPath, 'utf8');
  const patched = patchArtifactSpillThreshold(config, 1024);
  await writeFile(configPath, patched, 'utf8');
}

export function patchArtifactSpillThreshold(configYaml, threshold = 1024) {
  return /artifactSpillThreshold:\s*\d+(?:\.\d+)?/.test(configYaml)
    ? configYaml.replace(/artifactSpillThreshold:\s*\d+(?:\.\d+)?/, `artifactSpillThreshold: ${threshold}`)
    : `${configYaml.trimEnd()}\ntools:\n  artifactSpillThreshold: ${threshold}\n`;
}

/**
 * Writes a shim that forwards every argument except `--no-session` to the real
 * OMP executable. Live matrix reviews need session persistence: under
 * `--no-session` the task tool's temporary artifacts directory is deleted when
 * each subagent settles, so `agent://<id>` handles for truncated result
 * previews can never resolve and the orchestrator falls back to a
 * `review_failure` envelope instead of reporting real findings.
 */
export async function writeSessionedOmpWrapper(dir, targetOverride = undefined, options = {}) {
  const realOmp = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const target = targetOverride ?? (() => {
      const resolved = spawnSync('where.exe', [realOmp], { encoding: 'utf8', windowsHide: true });
      const candidates = (resolved.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return candidates.find((candidate) => /\.exe$/i.test(candidate)) ?? candidates[0] ?? realOmp;
    })();
    const wrapper = path.join(dir, 'omp-sessioned.cmd');
    // %* keeps the raw argument string; a %~1 loop would split `task,read`
    // on the comma and corrupt `--tools task,read` into two arguments.
    await writeFile(wrapper, [
      '@echo off',
      'setlocal EnableDelayedExpansion',
      'set "OMP_ARGS=%*"',
      'set "OMP_ARGS=!OMP_ARGS:--no-session=!"',
      `call "${target}" !OMP_ARGS!`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'), 'utf8');
    return wrapper;
  }
  const target = targetOverride ?? realOmp;
  const wrapper = path.join(dir, 'omp-sessioned.sh');
  await writeFile(wrapper, [
    '#!/bin/sh',
    'set -f',
    'args=""',
    'for a in "$@"; do',
    '  [ "$a" = "--no-session" ] && continue',
    '  args="$args \'$a\'"',
    'done',
    'eval "set -- $args"',
    `exec "${target}" "$@"`,
    '',
  ].join('\n'), 'utf8');
  await chmod(wrapper, 0o755);
  return wrapper;
}

export function gitAt(repoDir) {
  return (args, options = {}) => spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

export async function writeTree(root, files) {
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
      '.audit/.gitkeep': '',
    },
    stagedContent: "import { spawnSync } from 'node:child_process'; import { appendFileSync } from 'node:fs';\nexport function captureCommand(command, args) { const result = spawnSync(command, args, { encoding: null, maxBuffer: Number.MAX_SAFE_INTEGER }); appendFileSync('.audit/all-command-bytes.bin', Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)])); return result; }\n",
  },
  {
    name: 'passes Port Adapter and Template Method for new capability',
    expected: 'PASS',
    stagedPath: 'src/export-transport.mjs',
    baseline: { 'ARCHITECTURE.md': 'The product needs a new remote export capability with one invariant shared by transports.\n' },
    // PASS fixtures must be clean and free of defect-hunting traps.
    stagedContent: `export class ExportPort { async export(_document) { throw new Error('ExportPort.export must be implemented'); } }\nexport class GovernedExportTransport extends ExportPort { async export(document) { if (document.id === undefined || document.id === null) throw new TypeError('document id required'); return this.send(document); } async send(_document) { throw new Error('send must be implemented'); } }\nexport class JsonHttpExportAdapter extends GovernedExportTransport { constructor(post) { super(); this.post = post; } async send(document) { return this.post('/exports', JSON.stringify(document)); } }\n`,
  },
  {
    name: 'passes a public user-facing CLI boundary',
    expected: 'PASS',
    stagedPath: 'src/public-cli.mjs',
    baseline: { 'ARCHITECTURE.md': 'A public CLI is the supported user interface for local and CI consumers.\n' },
    stagedContent: `export function parseGreeting(args) { const index = args.indexOf('--name'); if (index < 0 || !args[index + 1]) throw new TypeError('Usage: greet --name NAME'); return { name: args[index + 1] }; }\nexport function runGreeting(args, output) { const { name } = parseGreeting(args); output.write('Hello, ' + name + '\\n'); }\n`,
  },
  {
    name: 'passes cryptography for remote untrusted payload',
    expected: 'PASS',
    stagedPath: 'src/crypto-webhook.mjs',
    baseline: { 'ARCHITECTURE.md': 'Webhook payloads arrive from a remote untrusted network boundary and must be authenticated before processing.\n' },
    stagedContent: `import { verify } from 'node:crypto';\nexport function verifyRemoteWebhook(payload, signature, trustedPublicKey) { if (!Buffer.isBuffer(payload) || !Buffer.isBuffer(signature)) throw new TypeError('binary payload and signature required'); return verify(null, payload, trustedPublicKey, signature); }\n`,
  },
  {
    name: 'blocks vacuous check asserting true with unexercised passing report',
    expected: 'BLOCK',
    stagedPath: 'tests/calc.test.mjs',
    stagedFiles: {
      'tests/calc.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('all 594 calculations pass', () => {\n  assert.ok(true);\n});\n",
      'REPORT.md': '# Calculation Report\n\nAll 594 checks verified and passed.\n',
    },
    baseline: {
      'src/calc.mjs': 'export function add(a, b) { return a + b; }\n',
    },
    nativeEvidence: /calc\.test\.mjs|assert\.ok|cannot fail|vacuous|red_proof|failing power/i,
    evidencePattern: /cannot fail|assert\.ok|vacuous|red_proof|never fail|tautolog|no test coverage|unexercised|594/i,
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
    const sessionedOmp = await writeSessionedOmpWrapper(baseDir);

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

    const stagedFiles = reviewCase.stagedFiles ?? { [reviewCase.stagedPath]: reviewCase.stagedContent };
    await writeTree(repoDir, stagedFiles);
    for (const relPath of Object.keys(stagedFiles)) {
      git(['add', relPath]);
    }
    const stagedBefore = git(['diff', '--cached', '--binary', '--no-ext-diff', '--']).stdout;
    assert.notEqual(stagedBefore.length, 0);
    const executeCommitReview = () => git(['commit', '-m', `Review matrix ${reviewCase.expected}`], {
      env: {
        ...process.env,
        OMP_PROFILE: profile,
        OMP_REVIEW_KIT_MODEL: model,
        OMP_REVIEW_KIT_MAX_FALLBACKS: '0',
        OMP_REVIEW_KIT_OMP: sessionedOmp,
      },
      timeout: 900_000,
    });

    let commit = executeCommitReview();
    let output = commit.stdout + commit.stderr;

    if (commit.status !== 0 && INFRA_RETRY_PATTERN.test(output)) {
      const match = output.match(INFRA_RETRY_PATTERN)[0];
      console.warn(`[runLiveReviewCase] Infra failure detected (${match}) during git commit review for "${reviewCase.name}". Retrying attempt 2/2...`);
      commit = executeCommitReview();
      output = commit.stdout + commit.stderr;
    }

    if (reviewCase.expected === 'PASS') {
      // Surface the rejection report on unexpected BLOCK so the failure is
      // diagnosable after the temp repo is cleaned up.
      let failureDetail = output;
      const reportPointer = output.match(/^REVIEW_REJECTION_REPORT=(.+)$/m);
      if (commit.status !== 0 && reportPointer) {
        try {
          failureDetail += '\n--- rejection report ---\n' + (await readFile(reportPointer[1].trim(), 'utf8')).slice(0, 6000);
        } catch { /* report unreadable; keep raw output */ }
      }
      assert.equal(commit.status, 0, `Expected PASS for ${reviewCase.name}\n${failureDetail}`);
      assert.equal((output.match(/reviewer-kit PASS:/g) ?? []).length, 1);
      assert.doesNotMatch(output, /REVIEW_REJECTION_(?:ENVELOPE|REPORT)/);
      assert.match(git(['log', '-1', '--pretty=%s']).stdout, /Review matrix PASS/);
      return;
    }

    let reportText = '';
    const reportPointer = output.match(/^REVIEW_REJECTION_REPORT=(.+)$/m);
    if (reportPointer) {
      try {
        reportText = await readFile(reportPointer[1].trim(), 'utf8');
      } catch { /* report unreadable */ }
    }

    try {
      assert.notEqual(commit.status, 0, `Expected BLOCK for ${reviewCase.name}\n${output}`);
      const pointers = [...output.matchAll(/^REVIEW_REJECTION_REPORT=(.+)$/gm)];
      assert.equal(pointers.length, 1, output);
      const reportPath = pointers[0][1].trim();
      const report = reportText || (await readFile(reportPath, 'utf8'));
      const envelope = extractNormalizedEnvelope(report);
      assert.equal(envelope.kind, 'confirmed_findings', report);
      assert.ok(envelope.findings.length >= 1, report);
      const finding = envelope.findings.find((item) => item.file_path === reviewCase.stagedPath);
      assert.ok(finding, `Missing finding for ${reviewCase.stagedPath}\n${report}`);
      assert.match(finding.priority, /^P[12]$/);
      assert.equal(finding.defect_class, 'correctness');
      const lineCount = (reviewCase.stagedContent ?? stagedFiles[reviewCase.stagedPath]).split('\n').length;
      assert.ok(finding.line_start >= 1 && finding.line_end <= lineCount);
      assert.match(finding.verifier_argument + ' ' + finding.counterexample, reviewCase.nativeEvidence);
      if (reviewCase.evidencePattern) {
        assert.match(finding.verifier_argument + ' ' + finding.counterexample, reviewCase.evidencePattern);
      } else {
        assert.match(finding.verifier_argument + ' ' + finding.counterexample, DEFAULT_EVIDENCE_PATTERN);
      }
      assert.equal(git(['diff', '--cached', '--binary', '--no-ext-diff', '--']).stdout, stagedBefore);
      assert.doesNotMatch(git(['log', '-1', '--pretty=%s']).stdout, /Review matrix BLOCK/);
    } catch (err) {
      if (reportText && !err.message.includes('--- rejection report ---')) {
        err.message += '\n--- rejection report ---\n' + reportText.slice(0, 6000);
      }
      throw err;
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (isDirectExecution) {
describe('Feature: Real Live OMP & Plugin Discovery E2E (No Mocks)', () => {
  it('Live Preflight: isolated profile OMP probe verifies model availability before live matrix', { skip: !isLiveE2E }, async () => {
    const profile = `omp-rev-preflight-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const agentDir = resolveAgentDir(profile);
    const profileDir = path.dirname(agentDir);
    const model = process.env.OMP_REVIEW_KIT_MODEL ?? process.env.MODEL;
    if (!model) {
      throw new Error(
        'Live Preflight failed: no model configured.\n' +
        'Actionable fix: set OMP_REVIEW_KIT_MODEL (or MODEL) in the environment, e.g. OMP_REVIEW_KIT_MODEL=@slow'
      );
    }

    try {
      await copyDefaultProfileConfig(agentDir);
      const probeResult = spawnOmpSync(['-p', '--model', model, '--tools', '', '--no-session', 'respond with OK'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        env: {
          ...process.env,
          OMP_PROFILE: profile,
        },
      });

      if (probeResult.status !== 0 || (probeResult.error && probeResult.error.code === 'ETIMEDOUT')) {
        const detail = probeResult.stderr || probeResult.stdout || probeResult.error?.message || 'unknown failure';
        throw new Error(
          `Live Preflight failed: model "${model}" failed probe in isolated profile "${profile}".\n` +
          `Cause: ${detail.trim()}\n` +
          `Actionable fix: Model "${model}" appears missing or unauthorized in the isolated profile.\n` +
          `  1. Verify "${model}" is listed in ~/.omp/agent/models.yml or configured in ~/.omp/agent/config.yml\n` +
          `  2. Check credentials or run 'omp models' to confirm availability\n` +
          `  3. Or choose an available model via OMP_REVIEW_KIT_MODEL=<valid-model>`
        );
      }
    } finally {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  });

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
      const sessionedOmp = await writeSessionedOmpWrapper(baseDir);
      const result = await runLiveOmp(prompt, repoDir, 900_000, {}, sessionedOmp);

      assert.equal(result.status, 0,
        `OMP exit=${result.status}\nstdout:\n${result.stdout.slice(0, 3000)}\nstderr:\n${result.stderr.slice(0, 1000)}`);
      assert.match(result.stdout, /REVIEW_RESULT=PASS/, `stdout:\n${result.stdout.slice(0, 3000)}`);
      assert.match(result.stdout, /coverage|findings/i, `stdout:\n${result.stdout.slice(0, 3000)}`);
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
      const sessionedOmp = await writeSessionedOmpWrapper(baseDir);
      const result = await runLiveOmp(prompt, repoDir, 900_000, {}, sessionedOmp);

      assert.equal(result.status, 0,
        `OMP exit=${result.status}\nstdout:\n${result.stdout.slice(0, 3000)}\nstderr:\n${result.stderr.slice(0, 1000)}`);
      assert.match(result.stdout, /REVIEW_RESULT=BLOCK/, `stdout:\n${result.stdout.slice(0, 3000)}`);
      assert.match(result.stdout, /calc\.js|zero|divide/i, `stdout:\n${result.stdout.slice(0, 3000)}`);
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
}
