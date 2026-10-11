import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as srcStore from '../src/infra/filesystem-report-store-adapter.mjs';
import { ReviewReport as SrcReviewReport } from '../src/domain/review-report.mjs';
import * as runnerModule from '../scripts/run-review.mjs';

const VARIANTS = [
  ['src module', srcStore, SrcReviewReport],
  ['runner copy', runnerModule, runnerModule.ReviewReport],
];

const HOME = path.join(tmpdir(), 'omp-report-store-home');

function makeReport(ReportClass) {
  return new ReportClass({
    diffIdentity: 'def456',
    verdict: 'PASS',
    rawOutput: 'Confirmed findings\nNone.\n\nREVIEW_RESULT=PASS\n',
    timestamp: new Date('2026-10-03T10:00:00.000Z'),
  });
}

async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The reports folder name: the directory name, then the first 12 hex digits of sha256 of the absolute path.
function folderNameOf(repoRoot) {
  const resolved = path.resolve(repoRoot);
  return `${path.basename(resolved)}-${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`;
}

for (const [label, mod, ReportClass] of VARIANTS) {
  const { reportsRootDir, repoReportsDir, FileSystemReportStoreAdapter } = mod;

  test(`${label}: reportsRootDir defaults to Documents/omp-reviewer-kit under the home folder`, () => {
    assert.equal(reportsRootDir({ env: {}, home: HOME }), path.join(HOME, 'Documents', 'omp-reviewer-kit'));
  });

  test(`${label}: OMP_REVIEW_KIT_REPORTS_DIR overrides the root and is resolved to an absolute path`, () => {
    const override = path.join(tmpdir(), 'omp-report-store-custom');
    assert.equal(reportsRootDir({ env: { OMP_REVIEW_KIT_REPORTS_DIR: override }, home: HOME }), path.resolve(override));
  });

  test(`${label}: a relative OMP_REVIEW_KIT_REPORTS_DIR resolves to an absolute path under the working folder`, () => {
    const root = reportsRootDir({ env: { OMP_REVIEW_KIT_REPORTS_DIR: 'rel-reports' }, home: HOME });
    assert.equal(root, path.resolve('rel-reports'));
    assert.equal(path.isAbsolute(root), true);
  });

  test(`${label}: an empty or whitespace-only override falls back to the Documents default`, () => {
    const fallback = path.join(HOME, 'Documents', 'omp-reviewer-kit');
    assert.equal(reportsRootDir({ env: { OMP_REVIEW_KIT_REPORTS_DIR: '' }, home: HOME }), fallback);
    assert.equal(reportsRootDir({ env: { OMP_REVIEW_KIT_REPORTS_DIR: '   ' }, home: HOME }), fallback);
  });

  test(`${label}: repoReportsDir nests the reports under the repository's directory name and a hash of its absolute path`, () => {
    const repo = path.join(tmpdir(), 'work', 'omp-spec-kit');
    const dir = repoReportsDir(repo, { env: {}, home: HOME });
    assert.equal(dir, path.join(reportsRootDir({ env: {}, home: HOME }), folderNameOf(repo)));
    assert.match(path.basename(dir), /^omp-spec-kit-[0-9a-f]{12}$/);
  });

  test(`${label}: saveReport writes one file under <rootDir>/<repo folder>, returns that absolute path, and writes nothing into the repository`, async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'omp-report-store-'));
    try {
      const rootDir = path.join(base, 'reports');
      const repoRoot = path.join(base, 'omp-spec-kit');
      await mkdir(repoRoot, { recursive: true });
      const report = makeReport(ReportClass);

      const saved = await new FileSystemReportStoreAdapter({ rootDir }).saveReport(repoRoot, report);

      const expected = path.join(rootDir, folderNameOf(repoRoot), report.filename);
      assert.equal(saved, expected);
      assert.equal(path.isAbsolute(saved), true);
      assert.equal(await readFile(saved, 'utf8'), report.toMarkdown());
      assert.deepEqual(await readdir(rootDir), [folderNameOf(repoRoot)]);
      assert.deepEqual(await readdir(path.join(rootDir, folderNameOf(repoRoot))), [report.filename]);
      assert.deepEqual(await readdir(repoRoot), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test(`${label}: the default store takes its root from OMP_REVIEW_KIT_REPORTS_DIR`, async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'omp-report-store-env-'));
    try {
      const repoRoot = path.join(base, 'omp-spec-kit');
      await mkdir(repoRoot, { recursive: true });
      const report = makeReport(ReportClass);

      const saved = await withEnv(
        { OMP_REVIEW_KIT_REPORTS_DIR: path.join(base, 'env-reports') },
        () => new FileSystemReportStoreAdapter().saveReport(repoRoot, report),
      );

      assert.equal(saved, path.join(base, 'env-reports', folderNameOf(repoRoot), report.filename));
      assert.equal(await readFile(saved, 'utf8'), report.toMarkdown());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test(`${label}: a relative override makes the default store save under the working folder, at an absolute path`, async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'omp-report-store-rel-'));
    const previous = process.cwd();
    try {
      process.chdir(base);
      const repoRoot = path.join(base, 'omp-spec-kit');
      await mkdir(repoRoot, { recursive: true });
      const report = makeReport(ReportClass);

      const saved = await withEnv(
        { OMP_REVIEW_KIT_REPORTS_DIR: 'rel-reports' },
        () => new FileSystemReportStoreAdapter().saveReport(repoRoot, report),
      );

      assert.equal(saved, path.resolve('rel-reports', folderNameOf(repoRoot), report.filename));
      assert.equal(path.isAbsolute(saved), true);
      assert.equal(await readFile(saved, 'utf8'), report.toMarkdown());
    } finally {
      process.chdir(previous);
      await rm(base, { recursive: true, force: true });
    }
  });

  test(`${label}: two checkouts that share a directory name save to different reports folders`, async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'omp-report-store-f1-'));
    try {
      const rootDir = path.join(base, 'reports');
      const repoA = path.join(base, 'a', 'wt');
      const repoB = path.join(base, 'b', 'wt');
      await mkdir(repoA, { recursive: true });
      await mkdir(repoB, { recursive: true });
      const report = makeReport(ReportClass);
      const env = { OMP_REVIEW_KIT_REPORTS_DIR: rootDir };

      assert.equal(repoReportsDir(repoA, { env, home: HOME }), path.join(rootDir, folderNameOf(repoA)));
      assert.equal(repoReportsDir(repoB, { env, home: HOME }), path.join(rootDir, folderNameOf(repoB)));

      const store = new FileSystemReportStoreAdapter({ rootDir });
      const savedA = await store.saveReport(repoA, report);
      const savedB = await store.saveReport(repoB, report);

      assert.notEqual(path.dirname(savedA), path.dirname(savedB));
      assert.equal(await readFile(savedA, 'utf8'), report.toMarkdown());
      assert.equal(await readFile(savedB, 'utf8'), report.toMarkdown());
      assert.deepEqual((await readdir(rootDir)).sort(), [folderNameOf(repoA), folderNameOf(repoB)].sort());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
}
