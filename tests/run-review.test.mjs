import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runReview } from '../scripts/run-review.mjs';

const TEST_ROLES = { smol: 'acme/smol-flash:high', task: 'acme/task-fast:high', slow: 'acme/slow-max:max' };
const testRoleResolver = () => TEST_ROLES;

async function makeRoot(prefix = 'omp-review-kit-') {
  const reportRoot = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(reportRoot, 'project');
}

function fakeGit(root, diff, calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from(`${root}\n`);
    if (args[0] === 'diff') return Buffer.from(diff);
    if (args[0] === 'ls-files') return Buffer.alloc(0);
    return Buffer.alloc(0);
  };
}

function rejectionOutput(diffText, { kind = 'confirmed_findings', envelope = {}, finding = {}, failure } = {}) {
  const diffHash = createHash('sha256').update(diffText).digest('hex');
  const defaultFinding = {
    finding_id: 'correctness-1',
    priority: 'P2',
    defect_class: 'correctness',
    file_path: 'src/example.mjs',
    line_start: 1,
    line_end: 1,
    verifier_argument: 'The repository already provides the same responsibility.',
    counterexample: 'The staged wrapper only calls the existing mechanism.',
  };
  const value = kind === 'review_failure'
    ? {
        schema: 'review-rejection-envelope@1',
        kind,
        diff_hash: diffHash,
        findings: [],
        failure: failure ?? {
          code: 'execution_failure',
          message: 'The reviewer process did not complete successfully.',
        },
        ...envelope,
      }
    : {
        schema: 'review-rejection-envelope@1',
        kind,
        diff_hash: diffHash,
        findings: [{ ...defaultFinding, ...finding }],
        ...envelope,
      };
  return [
    'REVIEW_REJECTION_ENVELOPE_BEGIN',
    JSON.stringify(value),
    'REVIEW_REJECTION_ENVELOPE_END',
    'REVIEW_RESULT=BLOCK',
    '',
  ].join('\n');
}

async function runAt(root, diff, ompResult, now = new Date('2026-09-04T12:00:00.000Z')) {
  let prompt = '';
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, diff),
    omp: (value) => {
      prompt = value;
      return ompResult;
    },
    ompOptions: { roleResolver: testRoleResolver },
    now,
  });
  return { result, prompt, root };
}

async function runFixture(diff, ompResult) {
  return runAt(await makeRoot(), diff, ompResult);
}

test('allows a staged change only after reviewer-kit PASS', async () => {
  const { result, prompt, root } = await runFixture('diff', {
    status: 0,
    stdout: 'Used developer-architecture.\nREVIEW_RESULT=PASS\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 0);
  assert.match(prompt, /agent "reviewer-kit"/);
  assert.match(prompt, /skill:\/\/multi-stage-review/);
  assert.match(prompt, /skill:\/\/reality-first-review/);
  assert.match(prompt, /relevant project or user review skills discovered by OMP/);
  assert.doesNotMatch(prompt, /do not run any other agent/);
  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /REVIEW_RESULT=PASS/);
  assert.match(report, /developer-architecture/);
  assert.equal(result.reportPath.startsWith(path.join(root, 'audit-reports')), true);
});

test('blocks a staged change after reviewer-kit BLOCK', async () => {
  const { result } = await runFixture('bad diff', {
    status: 0,
    stdout: rejectionOutput('bad diff'),
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.envelope.kind, 'confirmed_findings');
  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /## Normalized rejection envelope/);
});


test('rejects an unsupported rejection defect class', async () => {
  const { result } = await runFixture('diff', {
    status: 0,
    stdout: rejectionOutput('diff', { finding: { defect_class: 'maintainability' } }),
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.kind, 'review_failure');
  assert.equal(result.envelope.failure.code, 'malformed_rejection_envelope');
});

test('keeps the reviewer review_failure envelope when the verdict marker ends with a bare carriage return', async () => {
  // Live incident (2026-09-15): the reviewer emitted a valid review_failure
  // envelope on stdout while the REVIEW_RESULT=BLOCK marker arrived on stderr
  // terminated by a bare '\r'. The verdict regex tolerates a trailing CR, but
  // the envelope evaluator's exact-line marker lookup did not, so the run was
  // normalized to malformed_rejection_envelope and the real failure reason was
  // lost. The report trims raw output, hiding the CR in the audit trail.
  const diffText = 'diff';
  const diffHash = createHash('sha256').update(diffText).digest('hex');
  const reviewerEnvelope = JSON.stringify({
    schema: 'review-rejection-envelope@1',
    kind: 'review_failure',
    diff_hash: diffHash,
    findings: [],
    failure: {
      code: 'execution_failure',
      message: "reviewer-kit task completed but its report was truncated in the result preview and the full payload could not be read: agent://ReviewerKit, agent://ReviewerKit/report, and agent://ReviewerKit?q=.report all returned 'No artifacts directory found'; history://ReviewerKit confirmed the yield payload was also truncated.",
    },
  });
  const { result } = await runFixture(diffText, {
    status: 0,
    stdout: [
      'REVIEW_REJECTION_ENVELOPE_BEGIN',
      reviewerEnvelope,
      'REVIEW_REJECTION_ENVELOPE_END',
    ].join('\n'),
    stderr: 'REVIEW_RESULT=BLOCK\r',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.envelope.kind, 'review_failure');
  assert.equal(result.envelope.failure.code, 'execution_failure');
});

test('rejects a malformed result marker', async () => {
  const { result } = await runFixture('diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=PASSED\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.envelope.failure.code, 'missing_verdict_marker');
});

test('does not let trailing prose override an exact BLOCK marker', async () => {
  const { result } = await runFixture('bad diff', {
    status: 0,
    stdout: rejectionOutput('bad diff') + 'Note: the next run should emit REVIEW_RESULT=PASS.\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
});

test('fails closed when multiple exact result markers are present', async () => {
  const { result } = await runFixture('bad diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=PASS\nREVIEW_RESULT=PASS\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.envelope.failure.code, 'multiple_verdict_markers');
});

test('fails closed when reviewer output is missing verdict marker', async () => {
  const { result } = await runFixture('diff', {
    status: 0,
    stdout: 'Analysis completed with no final marker.\n',
    stderr: '',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.envelope.failure.code, 'missing_verdict_marker');
});

test('fails closed when reviewer execution times out', async () => {
  const { result } = await runFixture('diff', {
    status: 1,
    stdout: '',
    stderr: 'Review timed out after 600000ms\n',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.envelope.failure.code, 'execution_failure');
  assert.equal(result.details, 'Review timed out after 600000ms');
  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /Review timed out after 600000ms/);
});

test('fails closed when OMP fails', async () => {
  const { result } = await runFixture('diff', {
    status: 1,
    stdout: '',
    stderr: 'omp unavailable',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.details, 'omp unavailable');
});

test('skips a commit with no staged change', async () => {
  let called = false;
  const root = await makeRoot();
  const result = await runReview({
    cwd: root,
    git: (args) => args[0] === 'rev-parse' ? Buffer.from(`${root}\n`) : Buffer.alloc(0),
    omp: () => { called = true; throw new Error('must not run'); },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('excludes unstaged working-tree changes from the reviewed hash', async () => {
  const root = await makeRoot('omp-review-kit-git-');
  const stagedDiff = 'staged diff only';
  const calls = [];
  let prompt = '';
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, stagedDiff, calls),
    omp: (value) => {
      prompt = value;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
    ompOptions: { roleResolver: testRoleResolver },
  });
  const expectedHash = createHash('sha256').update(stagedDiff).digest('hex');

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[1], ['diff', '--cached', '--binary', '--no-ext-diff', '--']);
  assert.match(prompt, new RegExp(expectedHash));
  assert.match(await readFile(result.reportPath, 'utf8'), new RegExp(expectedHash));
});

test('does not overwrite an earlier report', async () => {
  const root = await makeRoot();
  const first = await runAt(root, 'diff', {
    status: 0,
    stdout: 'REVIEW_RESULT=PASS\n',
    stderr: '',
  }, new Date('2026-09-04T12:00:00.000Z'));
  const second = await runAt(root, 'diff', {
    status: 0,
    stdout: rejectionOutput('diff'),
    stderr: '',
  }, new Date('2026-09-04T12:00:01.000Z'));

  assert.notEqual(first.result.reportPath, second.result.reportPath);
  assert.match(await readFile(first.result.reportPath, 'utf8'), /result: PASS/);
  assert.match(await readFile(second.result.reportPath, 'utf8'), /result: BLOCK/);
});

test('dispatcher prompt carries deterministic suspicion map for deleted test file and assert deltas', async () => {
  const root = await makeRoot('omp-review-kit-suspicion-');
  const stagedDiff = [
    'diff --git a/tests/obsolete.test.mjs b/tests/obsolete.test.mjs',
    'deleted file mode 100644',
    '--- a/tests/obsolete.test.mjs',
    '+++ /dev/null',
    '@@ -1,50 +0,0 @@',
    ...Array.from({ length: 50 }, (_, i) => `-line ${i}`),
    'diff --git a/tests/calc.test.mjs b/tests/calc.test.mjs',
    '--- a/tests/calc.test.mjs',
    '+++ b/tests/calc.test.mjs',
    '@@ -1,5 +1,2 @@',
    '-assert.equal(a, 1);',
    '-assert.equal(b, 2);',
    '-assert.equal(c, 3);',
    '+assert.equal(a, 10);',
  ].join('\n');

  let prompt = '';
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, stagedDiff),
    omp: (value) => {
      prompt = value;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
    ompOptions: { roleResolver: testRoleResolver },
  });

  assert.equal(result.exitCode, 0);
  assert.match(prompt, /Deterministic suspicion map \(computed from the staged diff; every entry must be addressed\):/);
  assert.match(prompt, /- tests\/obsolete\.test\.mjs: deleted test file \(50 removed lines\)/);
  assert.match(prompt, /- tests\/calc\.test\.mjs: assert lines \+1\/-3 \(net -2\)/);
});

test('dispatcher prompt carries execution evidence when OMP_REVIEW_KIT_EXECUTE is enabled', async () => {
  const root = await makeRoot('omp-review-kit-exec-');
  const stagedDiff = 'diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@ -1 +1 @@\n-1\n+2\n';

  const origExec = process.env.OMP_REVIEW_KIT_EXECUTE;
  const origCmd = process.env.OMP_REVIEW_KIT_EXECUTE_COMMAND;
  process.env.OMP_REVIEW_KIT_EXECUTE = '1';
  process.env.OMP_REVIEW_KIT_EXECUTE_COMMAND = 'node -e "process.stdout.write(\'tests passing\'); process.exit(0)"';

  let prompt = '';
  try {
    const result = await runReview({
      cwd: root,
      git: fakeGit(root, stagedDiff),
      omp: (value) => {
        prompt = value;
        return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
      },
      ompOptions: { roleResolver: testRoleResolver },
    });

    assert.equal(result.exitCode, 0);
    assert.match(prompt, /Execution evidence \(opt-in, produced by the dispatcher before this review\):/);
    assert.match(prompt, /- Staged snapshot: exit 0 in/);
    assert.match(prompt, /tests passing/);
  } finally {
    if (origExec !== undefined) process.env.OMP_REVIEW_KIT_EXECUTE = origExec;
    else delete process.env.OMP_REVIEW_KIT_EXECUTE;
    if (origCmd !== undefined) process.env.OMP_REVIEW_KIT_EXECUTE_COMMAND = origCmd;
    else delete process.env.OMP_REVIEW_KIT_EXECUTE_COMMAND;
  }
});

test('runner fails open and includes unavailable in prompt when execution throws', async () => {
  const root = await makeRoot('omp-review-kit-exec-fail-');
  const stagedDiff = 'diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@ -1 +1 @@\n-1\n+2\n';

  const throwingPort = {
    run: async () => { throw new Error('runner execution crashed'); },
  };

  let prompt = '';
  const result = await runReview({
    cwd: root,
    git: fakeGit(root, stagedDiff),
    executionPort: throwingPort,
    execution: {
      enabled: true,
      command: 'npm test',
    },
    omp: (value) => {
      prompt = value;
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\n', stderr: '' };
    },
    ompOptions: { roleResolver: testRoleResolver },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, 'PASS');
  assert.match(prompt, /- Staged snapshot: unavailable \(runner execution crashed\)/);
});
