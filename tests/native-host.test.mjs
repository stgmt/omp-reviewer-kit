// Given/When/Then over the host's exit mapping and the saved report. The review step is the injected
// seam (its stages are covered by native-review and by the live hook case); the report is written by
// the real writer into a temporary folder, never into the user's Documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/native/native-host.mjs';
import { readRunRecords } from '../src/infra/review-run-store.mjs';

const DIFF_HASH = 'ab'.repeat(32);

function sink() {
  const written = [];
  return { write: text => written.push(text), text: () => written.join('') };
}

function reviewed({ pass, reasons = [], notes = [], text, fallback = { applied: true, requested: 'requested-model', chainLength: 5, error: null } }) {
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
    verdict: { pass, verdict: pass ? 'PASS' : 'BLOCK', reasons, notes },
  };
}

async function withTempDirs(run) {
  const base = await mkdtemp(path.join(tmpdir(), 'native-host-test-'));
  const repo = path.join(base, 'repo');
  const reports = path.join(base, 'reports');
  const runs = path.join(base, 'runs');
  try {
    await run({ repo, reports, runs });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('Given nothing is staged, When the host runs, Then it skips the review and exits 0', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => ({ staged: false }),
    });
    assert.equal(code, 0);
    assert.match(stderr.text(), /^review: SKIPPED \(no staged changes\)$/m);
  });
});

test('Given the review passes, When the host runs, Then it prints the report, names the saved report and exits 0', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const stdout = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
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
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
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
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
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
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
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
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
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
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const result = reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' });
    delete result.fallback;
    await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
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

function timed(result) {
  return {
    ...result,
    runSummary: {
      startedAt: '2026-11-01T09:12:33.120Z',
      finishedAt: '2026-11-01T09:16:45.460Z',
      durationMs: 252340,
      reviewer: { durationMs: 251000, tokens: 410000, requests: 38, contextTokens: 90000, sessionFile: 'C:\\sessions\\Review.jsonl', fallbackApplied: true },
      timings: { snapshotMs: 1200, nativeTaskMs: 251000, verdictMs: 40 },
    },
  };
}

test('Given a passing review, When the host finishes, Then one run record lies outside the repository with the verdict, the duration and the stage timings, and no reviewer text', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const result = timed(reviewed({ pass: true, text: '## Review\n\nSECRET-REPORT-BODY\n\nREVIEW_RESULT=PASS' }));
    result.stages = [
      { agent: 'review-context-scout', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'resolved-model', durationMs: 62000, tokens: 18000, requests: 12, counts: { behaviors: 5 } },
      { agent: 'review-risk-hunter', exitCode: 0, aborted: false, structuredStatus: 'valid', role: 'task', model: 'resolved-model', durationMs: 130000, tokens: 61000, requests: 19, counts: { candidates: 1, coverage_gaps: 3 } },
    ];
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => result,
    });
    assert.equal(code, 0);
    const files = (await readdir(runs)).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one record per run');
    const raw = await readFile(path.join(runs, files[0]), 'utf8');
    const record = JSON.parse(raw);
    assert.equal(record.schema, 'review-run-record@2');
    assert.equal(record.state, 'passed');
    assert.equal(record.verdict, 'PASS');
    assert.equal(typeof record.durationMs, 'number', 'the host measures the wall clock of its own run');
    assert.equal(record.timings.nativeTaskMs, 251000);
    assert.equal(record.repoRoot, path.resolve(repo));
    assert.equal(record.stages.length, 2);
    assert.equal(record.stages[1].durationMs, 130000);
    assert.deepEqual(record.stages[1].counts, { candidates: 1, coverage_gaps: 3 });
    assert.ok(record.reportPath.endsWith('.md'));
    assert.ok(!raw.includes('SECRET-REPORT-BODY'), 'the reviewer report is never copied into the record');
    assert.ok(path.relative(repo, path.join(runs, files[0])).startsWith('..'), 'the record is never written inside the repository');
    assert.match(stderr.text(), /^review: run \S+ passed \S+$/m);
  });
});

test('Given nothing is staged, When the host finishes, Then the record says skipped instead of claiming a review ran', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr: sink(),
      stdout: sink(),
      runReview: async () => ({ staged: false, runSummary: { timings: { snapshotMs: 12 }, durationMs: 14 } }),
    });
    assert.equal(code, 0);
    const files = (await readdir(runs)).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(runs, files[0]), 'utf8'));
    assert.equal(record.state, 'skipped');
    assert.equal(record.verdict, null);
    assert.equal(record.timings.snapshotMs, 12);
  });
});

test('Given the reviewer reports stage progress, When the host runs, Then each stage transition is logged once and PROGRESS=0 silences the stage lines but not the summary', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const progress = onEvent => {
      onEvent({ agent: 'review-context-scout', status: 'running', lane: null });
      onEvent({ agent: 'review-context-scout', status: 'running', lane: null });
      onEvent({ agent: 'review-context-scout', status: 'completed', lane: null, durationMs: 62_000, tokens: 18_000, requests: 12 });
      onEvent({ agent: 'review-context-scout', status: 'completed', lane: null, durationMs: 62_000, tokens: 18_000, requests: 12 });
    };
    const loud = sink();
    const loudCode = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr: loud,
      stdout: sink(),
      runReview: async ({ onEvent }) => {
        progress(onEvent);
        return timed(reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }));
      },
    });
    assert.equal(loudCode, 0);
    const loudLines = loud.text().split('\n');
    assert.equal(loudLines.filter(line => line === 'review: stage review-context-scout running').length, 1);
    assert.equal(loudLines.filter(line => line === 'review: stage review-context-scout completed (1m02s, 18k tok, 12 req)').length, 1);

    const quiet = sink();
    const quietCode = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs, OMP_REVIEW_KIT_PROGRESS: '0' },
      stderr: quiet,
      stdout: sink(),
      runReview: async ({ onEvent }) => {
        progress(onEvent);
        return timed(reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }));
      },
    });
    assert.equal(quietCode, 0);
    assert.doesNotMatch(quiet.text(), /^review: stage review-context-scout (running|completed \(1m02s)/m);
    assert.match(quiet.text(), /^review: run \S+ passed \S+$/m);
  });
});

test('Given the run recorder throws on every call, When the review passes, Then the verdict and the exit code are unchanged', async () => {
  await withTempDirs(async ({ repo, reports }) => {
    const stderr = sink();
    const boom = () => {
      throw new Error('record sink exploded');
    };
    const recorder = {
      runId: 'broken-recorder',
      get record() {
        throw new Error('record read exploded');
      },
      get writeFailure() {
        throw new Error('failure read exploded');
      },
      start: async () => boom(),
      event: async () => boom(),
      complete: async () => boom(),
      fail: async () => boom(),
    };
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports },
      stderr,
      stdout: sink(),
      recorder,
      runReview: async () => timed(reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' })),
    });
    assert.equal(code, 0);
    assert.match(stderr.text(), /^review: PASS$/m);
    assert.match(stderr.text(), /^review: run record unavailable$/m);
  });
});

test('Given the review throws, When the host runs, Then the run is recorded as failed, the error is named and the exit code is 1', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => {
        throw new Error('snapshot exploded');
      },
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /^review: BLOCK \(host error: snapshot exploded\)$/m);
    assert.match(stderr.text(), /^review: run \S+ failed \S+$/m);
    const records = await readRunRecords({ dir: runs });
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'failed');
    assert.equal(records[0].verdict, 'FAILED');
    assert.deepEqual(records[0].reasons, ['snapshot exploded']);
  });
});

test('Given the review passes, When the host runs, Then the report carries the run table with one row per stage', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }),
    });
    assert.equal(code, 0);
    const named = /^review: report (.+)$/m.exec(stderr.text());
    assert.ok(named, 'the report path is named');
    const body = await readFile(named[1], 'utf8');
    assert.match(body, /^## Run$/m);
    assert.match(body, /^\| Stage \| Duration \| Tokens \| Requests \| Result \|$/m);
    assert.match(body, /^\| review-context-scout \|/m);
  });
});

test('Given the diff is over budget, When the host runs, Then it refuses in one line, records the refusal and exits 1', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => ({
        staged: true,
        refused: { refused: true, reason: 'too-many-paths', paths: 54, bytes: 1_800_000, maxPaths: 40, maxBytes: 1_500_000 },
      }),
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /^review: diff too large \(54 paths, 1\.8 MB; budget 40 paths, 1\.5 MB\)$/m);
    assert.doesNotMatch(stderr.text(), /^review: (PASS|BLOCK)/m);
    const records = await readRunRecords({ dir: runs });
    assert.equal(records[0].state, 'refused');
    assert.equal(records[0].verdict, 'REFUSED');
    assert.deepEqual(records[0].reasons, ['too-many-paths: 54 paths, 1.8 MB (max 40 paths, 1.5 MB)']);
  });
});

test('Given the diff is within budget, When the host runs, Then one line names the size and the budget before the review', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => ({
        ...reviewed({ pass: true, text: '## Review\n\nREVIEW_RESULT=PASS' }),
        budget: { refused: false, reason: null, paths: 23, bytes: 210_000, maxPaths: 40, maxBytes: 1_500_000 },
      }),
    });
    assert.equal(code, 0);
    assert.match(stderr.text(), /^review: diff 23 paths, 210\.0 KB \(budget 40 paths, 1\.5 MB\)$/m);
  });
});

test('Given a pass whose verdict carries a note, When the host runs, Then the verdict line stays exact and the note is its own line', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const note = 're-verification rejected 1 finding(s) the report raised; the stages confirmed none';
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({ pass: true, notes: [note], text: '## Review\n\nREVIEW_RESULT=BLOCK' }),
    });
    assert.equal(code, 0);
    assert.match(stderr.text(), /^review: PASS$/m, 'a consumer of the exact line still sees it');
    assert.doesNotMatch(stderr.text(), /^review: PASS \(/m, 'no note is folded into the verdict line');
    assert.match(stderr.text(), /^review: note re-verification rejected 1 finding\(s\) the report raised; the stages confirmed none$/m);
  });
});

test('Given a block whose verdict carries a note, When the host runs, Then the note does not change the reason line', async () => {
  await withTempDirs(async ({ repo, reports, runs }) => {
    const stderr = sink();
    const code = await main([repo], {
      env: { OMP_REVIEW_KIT_REPORTS_DIR: reports, OMP_REVIEW_KIT_RUNS_DIR: runs },
      stderr,
      stdout: sink(),
      runReview: async () => reviewed({
        pass: false,
        reasons: ['reviewer verdict BLOCK'],
        notes: ['re-verification confirmed 1 finding(s) the report raised'],
        text: '## Review\n\nREVIEW_RESULT=BLOCK',
      }),
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /^review: BLOCK \(reviewer verdict BLOCK\)$/m);
    assert.match(stderr.text(), /^review: note re-verification confirmed 1 finding\(s\) the report raised$/m);
  });
});
