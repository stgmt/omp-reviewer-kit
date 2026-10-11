import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PluginInstallerService } from '../src/application/installer-service.mjs';
import initExtension from '../src/extension.mjs';
import { repoReportsFolderName } from '../src/infra/filesystem-report-store-adapter.mjs';

const OLDER_STAMP = '2026-10-09T08-00-00-000Z';
const NEWER_STAMP = '2026-10-10T20-21-51-525Z';
const NEWER_DATE = '2026-10-10T20:21:51.525Z';
const OLDER_HASH = '1'.repeat(64);
const NEWER_HASH = '2'.repeat(64);

function statusCommand() {
  const commands = new Map();
  initExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on() {},
    async sendUserMessage() {},
    logger: { warn() {}, error() {} },
  });
  return commands.get('reviewer-kit:status');
}

const status = statusCommand();

async function runStatus(cwd) {
  const notifications = [];
  await status.handler('', {
    cwd,
    ui: {
      notify(msg, type) {
        notifications.push({ msg, type });
      },
      setStatus() {},
    },
  });
  return notifications;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Runs one case inside a throwaway base folder; the reports root is `<base>/reports`.
async function isolated(run) {
  const base = await mkdtemp(path.join(tmpdir(), 'omp-status-latest-'));
  const saved = {
    reports: process.env.OMP_REVIEW_KIT_REPORTS_DIR,
    runs: process.env.OMP_REVIEW_KIT_RUNS_DIR,
    targets: process.env.OMP_REVIEW_KIT_TARGETS,
  };
  const reportsRoot = path.join(base, 'reports');
  process.env.OMP_REVIEW_KIT_REPORTS_DIR = reportsRoot;
  process.env.OMP_REVIEW_KIT_RUNS_DIR = path.join(base, 'runs');
  process.env.OMP_REVIEW_KIT_TARGETS = path.join(base, 'review-kit-targets.json');
  try {
    return await run(base, reportsRoot);
  } finally {
    restoreEnv('OMP_REVIEW_KIT_REPORTS_DIR', saved.reports);
    restoreEnv('OMP_REVIEW_KIT_RUNS_DIR', saved.runs);
    restoreEnv('OMP_REVIEW_KIT_TARGETS', saved.targets);
    await rm(base, { recursive: true, force: true });
  }
}

async function createRepo(dir) {
  await mkdir(dir, { recursive: true });
  const result = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return dir;
}

// The reports folder the production code uses for this checkout: keyed by the root Git reports.
async function reportDirOf(repoDir, reportsRoot) {
  const { repoRoot } = await new PluginInstallerService().status(repoDir);
  return path.join(reportsRoot, repoReportsFolderName(repoRoot));
}

async function writeReport(reportDir, stamp, hash, verdict) {
  await mkdir(reportDir, { recursive: true });
  const file = path.join(reportDir, `${stamp}-${hash}.md`);
  await writeFile(file, `# OMP Review Kit commit review\n\n- staged diff hash: ${hash}\n- result: ${verdict}\n`, 'utf8');
  return file;
}

describe('Feature: /reviewer-kit:status shows the latest saved review of this repository', () => {
  it('Given a PASS and a BLOCK report saved for this repository, When status runs, Then it prints the newer BLOCK verdict and the absolute path of the newer report', async () => {
    await isolated(async (base, reportsRoot) => {
      const repoDir = await createRepo(path.join(base, 'repo'));
      const reportDir = await reportDirOf(repoDir, reportsRoot);
      const older = await writeReport(reportDir, OLDER_STAMP, OLDER_HASH, 'PASS');
      const newer = await writeReport(reportDir, NEWER_STAMP, NEWER_HASH, 'BLOCK');

      const lines = (await runStatus(repoDir)).map((n) => n.msg).join('\n').split('\n');

      const verdictAt = lines.indexOf(`Latest Review: BLOCK (${NEWER_DATE})`);
      assert.notEqual(verdictAt, -1, lines.join('\n'));
      assert.equal(lines[verdictAt + 1], `Report: ${newer}`);
      assert.equal(lines.some((line) => line.includes(older)), false);
    });
  });

  it('Given no reports folder yet, When status runs, Then status succeeds and prints no Latest Review line', async () => {
    await isolated(async (base) => {
      const repoDir = await createRepo(path.join(base, 'repo'));

      const notifications = await runStatus(repoDir);

      assert.equal(notifications.length, 1);
      assert.notEqual(notifications[0].type, 'error');
      const text = notifications[0].msg;
      assert.match(text, /^Status: /m);
      assert.doesNotMatch(text, /Latest Review:/);
      assert.doesNotMatch(text, /status check failed/);
    });
  });

  it('Given two checkouts named app and a review saved only for a/app, When each status runs, Then a/app shows its own report and b/app prints no Latest Review line', async () => {
    await isolated(async (base, reportsRoot) => {
      const repoA = await createRepo(path.join(base, 'a', 'app'));
      const repoB = await createRepo(path.join(base, 'b', 'app'));
      const reportDirA = await reportDirOf(repoA, reportsRoot);
      const reportA = await writeReport(reportDirA, NEWER_STAMP, NEWER_HASH, 'BLOCK');

      const linesA = (await runStatus(repoA)).map((n) => n.msg).join('\n').split('\n');
      const verdictAt = linesA.indexOf(`Latest Review: BLOCK (${NEWER_DATE})`);
      assert.notEqual(verdictAt, -1, linesA.join('\n'));
      assert.equal(linesA[verdictAt + 1], `Report: ${reportA}`);

      const textB = (await runStatus(repoB)).map((n) => n.msg).join('\n');
      assert.match(textB, /^Status: /m);
      assert.doesNotMatch(textB, /Latest Review:/);
      assert.equal(textB.includes(reportA), false);
    });
  });
});
