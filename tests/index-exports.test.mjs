// Given/When/Then over the package root: the run-record surface is reachable from the entry point
// that consumers import, and every name there is callable or a value, never a dangling re-export.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as kit from '../src/index.mjs';

const FUNCTIONS = [
  'buildRunRecord',
  'createRunId',
  'createRunRecorder',
  'formatStageEvent',
  'progressEvents',
  'stageEvidence',
  'formatDuration',
  'isTerminalRun',
  'normalizeRunRecord',
  'runStateFor',
  'stageCounts',
  'stageSummaryLine',
  'isRunAlive',
  'latestRunRecord',
  'pruneRuns',
  'readRunRecord',
  'readRunRecords',
  'runRecordFile',
  'runsRootDir',
  'writeRunRecord',
  'readReportEnvelope',
  'readDiffBudget',
  'assessDiff',
  'formatDiffSize',
];

test('Given the package root, When it is imported, Then the run-record functions are exported and callable', () => {
  for (const name of FUNCTIONS) assert.equal(typeof kit[name], 'function', `${name} is exported`);
  assert.equal(kit.RUN_SCHEMA, 'review-run-record@2');
});
