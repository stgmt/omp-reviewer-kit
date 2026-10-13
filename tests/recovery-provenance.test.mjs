import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as source from '../src/infra/omp-cli-reviewer-adapter.mjs';
import * as bundled from '../scripts/run-review.mjs';

for (const [label, mod] of [['source', source], ['bundled', bundled]]) {
  test(`${label}: Given damaged delivery, When identity or completion is wrong, Then recovery stays closed`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rk-provenance-'));
    try {
      const dir = path.join(root, 'artifacts');
      await mkdir(dir);
      const report = 'REVIEW_RESULT=PASS';
      const artifact = path.join(dir, 'AnyName.md');
      await writeFile(artifact, JSON.stringify(report));
      const transcript = async (agent, task, status, data = report) => writeFile(artifact.replace('.md', '.jsonl'), [
        { type: 'session_init', agent, task },
        { type: 'message', message: { role: 'toolResult', toolName: 'yield', details: { status, data } } },
      ].map((e) => JSON.stringify(e)).join('\n'));
      const options = { invocationToken: 'REVIEW_INVOCATION=expected' };
      assert.equal(await mod.recoverTaskReport(root, options), null, 'legacy metadata missing');
      await transcript('review-risk-hunter', options.invocationToken, 'success');
      assert.equal(await mod.recoverTaskReport(root, options), null, 'wrong role');
      await transcript('reviewer-kit', 'REVIEW_INVOCATION=foreign', 'success');
      assert.equal(await mod.recoverTaskReport(root, options), null, 'wrong attempt');
      await transcript('reviewer-kit', options.invocationToken, 'aborted');
      assert.equal(await mod.recoverTaskReport(root, options), null, 'aborted');
      await transcript('reviewer-kit', options.invocationToken, 'success', { aborted: true });
      assert.equal(await mod.recoverTaskReport(root, options), null, 'abort payload');
      await transcript('reviewer-kit', options.invocationToken, 'success');
      assert.equal(await mod.recoverTaskReport(root, { ...options, processStatus: 1 }), null, 'nonzero child');
      assert.equal((await mod.recoverTaskReport(root, options)).text, report);
      await writeFile(path.join(dir, 'Second.md'), JSON.stringify(report));
      await writeFile(path.join(dir, 'Second.jsonl'), await readFile(artifact.replace('.md', '.jsonl'), 'utf8'));
      assert.equal(await mod.recoverTaskReport(root, options), null, 'two genuine results are ambiguous');
      await rm(path.join(dir, 'Second.md'));
      await rm(path.join(dir, 'Second.jsonl'));
      await writeFile(artifact, JSON.stringify('REVIEW_RESULT=PASS\nREVIEW_RESULT=PASS'));
      assert.equal(await mod.recoverTaskReport(root, options), null, 'original malformed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${label}: Given duplicate dispatcher markers, When the linked result is complete, Then recover without another call`, async () => {
    let calls = 0;
    const adapter = new mod.OmpCliReviewerAdapter({ runner: async (_prompt, _cwd, _timeout, options) => {
      calls++;
      const dir = path.join(options.sessionDir, 'artifacts');
      await mkdir(dir);
      await writeFile(path.join(dir, 'Review.md'), JSON.stringify('REVIEW_RESULT=PASS'));
      await writeFile(path.join(dir, 'Review.jsonl'), [
        { type: 'session_init', agent: 'reviewer-kit', task: options.invocationToken },
        { type: 'message', message: { role: 'toolResult', toolName: 'yield', details: { status: 'success' } } },
      ].map((e) => JSON.stringify(e)).join('\n'));
      return { status: 0, stdout: 'REVIEW_RESULT=PASS\nREVIEW_RESULT=PASS' };
    } });
    const result = await adapter.executeReview({ prompt: 'fixture', cwd: process.cwd() });
    assert.equal(result.stdout, 'REVIEW_RESULT=PASS');
    assert.equal(calls, 1);
    assert.equal(result.attempts[0].reportRecovered.reason, 'multiple_verdict_markers');
  });
}
