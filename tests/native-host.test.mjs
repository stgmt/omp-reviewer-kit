// Given/When/Then over the host's exit mapping and the saved report. The review step is the injected
// seam (its stages are covered by native-review and by the live hook case); the report is written by
// the real writer into a temporary folder, never into the user's Documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/native/native-host.mjs';

const DIFF_HASH = 'ab'.repeat(32);

function sink() {
  const written = [];
  return { write: text => written.push(text), text: () => written.join('') };
}

function reviewed({ pass, reasons = [], text, fallback = { applied: true, requested: 'requested-model', chainLength: 5, error: null } }) {
  return {
    staged: true,
    diffHash: DIFF_HASH,
    profile: 'full',
    lanes: ['correctness'],
    changedPaths: ['src/a.mjs'],
    provenance: { role: 'task', model: 'resolved-model' },
    fallback,
    stages: [{ agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'resolved-model' }],
    text,
    verdict: { pass, verdict: pass ? 'PASS' : 'BLOCK', reasons },
  };
}

async function withTempDirs(run) {
  const base = await mkdtemp(path.join(tmpdir(), 'native-host-test-'));
  const repo = path.join(base, 'repo');
  const reports = path.join(base, 'reports');
  try {
    await run({ repo, reports });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('Given nothing is staged, When the host runs, Then it skips the review and exits 0', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      runReview: async () => ({ staged: false }),
    });
    assert.equal(code, 0);
    assert.match(stderr.text(), /^review: SKIPPED \(no staged changes\)$/m);
  });
});

test('Given the review passes, When the host runs, Then it prints the report, names the saved report and exits 0', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    const stdout = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout,
      runReview: async () => reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }),
    });
    assert.equal(code, 0);
    assert.match(stdout.text(), /^REVIEW_RESULT=PASS$/m);
    assert.match(stderr.text(), /^review: PASS$/m);
    const reportPath = stderr.text().match(/^review: report (.+)$/m)?.[1];
    assert.ok(reportPath, 'the host names the saved report');
    assert.equal(path.dirname(path.dirname(reportPath)), reports, 'the report lies under the reports folder');
  });
});

test('Given the review blocks, When the host runs, Then it exits 1 and names every reason', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({
        pass: false,
        reasons: ['reviewer verdict BLOCK', 'no completed stage evidence for review-finding-verifier'],
        text: '## Review\n\nREVIEW_RESULT=BLOCK',
      }),
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /^review: BLOCK \(reviewer verdict BLOCK; no completed stage evidence for review-finding-verifier\)$/m);
  });
});

test('Given a passing review with no reasons, When the host saves the report, Then the report carries the diff hash, the reviewer text and "none" for the reasons, outside the repository', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }),
    });
    const reportPath = stderr.text().match(/^review: report (.+)$/m)[1];
    assert.match(path.basename(reportPath), /-abababababab\.md$/, 'the file name carries the first 12 characters of the diff hash');
    assert.ok(path.relative(repo, reportPath).startsWith('..'), 'the report is never written inside the repository');
    const body = await readFile(reportPath, 'utf8');
    assert.match(body, /^# reviewer-kit review: PASS$/m);
    assert.ok(body.includes(`- Diff SHA-256: ${DIFF_HASH}`));
    assert.match(body, /^## Verdict reasons\n\n- none$/m);
    assert.ok(body.includes('## Reviewer report\n\n## Review\n\nREVIEW_RESULT=PASS'));
  });
});

test('Given the reviewer fell back to another model, When the host saves the report, Then it records the applied fallback, the candidate count and the requested selector', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }),
    });
    const reportPath = stderr.text().match(/^review: report (.+)$/m)[1];
    const body = await readFile(reportPath, 'utf8');
    assert.match(body, /^- Reviewer fallback: applied \(requested requested-model\)$/m);
    assert.match(body, /^- Reviewer fallback candidates: 5$/m);
    assert.doesNotMatch(body, /Reviewer provider error/);
    assert.match(stderr.text(), /^review: reviewer fallback=applied candidates=5$/m);
  });
});

test('Given the reviewer never left its requested model and the task ended on a provider error, When the host saves the report, Then it records the reason, the candidate count and the error', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({
        pass: false,
        reasons: ['reviewer task exit 1'],
        text: '',
        fallback: { applied: false, requested: 'anthropic/claude-haiku-5-5:medium', chainLength: 6, error: '403 permission_error: OAuth authentication is currently not allowed for this organization.' },
      }),
    });
    assert.equal(code, 1);
    const reportPath = stderr.text().match(/^review: report (.+)$/m)[1];
    const body = await readFile(reportPath, 'utf8');
    assert.match(body, /^- Reviewer fallback: not applied \(requested anthropic\/claude-haiku-5-5:medium\)$/m);
    assert.match(body, /^- Reviewer fallback candidates: 6$/m);
    assert.match(body, /^- Reviewer provider error: 403 permission_error: OAuth authentication is currently not allowed for this organization\.$/m);
    assert.match(stderr.text(), /^review: reviewer fallback=not-applied candidates=6$/m);
  });
});

test('Given a review result with no fallback evidence, When the host saves the report, Then the report says unknown instead of claiming a fallback ran', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    const result = reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' });
    delete result.fallback;
    await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      runReview: async () => result,
    });
    const reportPath = stderr.text().match(/^review: report (.+)$/m)[1];
    const body = await readFile(reportPath, 'utf8');
    assert.match(body, /^- Reviewer fallback: unknown$/m);
    assert.match(stderr.text(), /^review: reviewer fallback=not-applied candidates=unknown$/m);
  });
});
