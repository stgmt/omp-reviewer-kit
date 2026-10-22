// Given/When/Then over the reports folders. Pure path arithmetic: nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { repoReportsDir, repoReportsFolderName, reportsRootDir } from '../src/infra/filesystem-report-store-adapter.mjs';

test('Given no override, When the reports root is read, Then it is the Documents folder of the user', () => {
  assert.equal(reportsRootDir({ env: {}, home: '/home/reviewer' }), path.join('/home/reviewer', 'Documents', 'omp-reviewer-kit'));
});

test('Given the override variable, When the reports root is read, Then it is the resolved override', () => {
  const override = path.resolve('reports-override-dir');
  assert.equal(reportsRootDir({ env: { OMP_REVIEW_KIT_REPORTS_DIR: `  ${override}  ` }, home: '/home/reviewer' }), override);
});

test('Given two checkouts that share a directory name, When their folder names are read, Then the path hash keeps them apart', () => {
  const first = repoReportsFolderName(path.resolve('work', 'a', 'wt'));
  const second = repoReportsFolderName(path.resolve('work', 'b', 'wt'));
  assert.match(first, /^wt-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('Given the override variable, When a repository folder is read, Then it lies under the override and outside the repository', () => {
  const repo = path.resolve('work', 'repo-x');
  const override = path.resolve('reports-root');
  const dir = repoReportsDir(repo, { env: { OMP_REVIEW_KIT_REPORTS_DIR: override } });
  assert.equal(path.dirname(dir), override);
  assert.equal(path.basename(dir), repoReportsFolderName(repo));
  assert.equal(dir.startsWith(repo + path.sep), false);
});
