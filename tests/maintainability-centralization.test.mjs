// The exemption the owner asked for: one shared contract, its consumers and its test are the shape
// of a single definition. A group that reaches a second independent implementation still blocks.

import assert from 'node:assert/strict';
import test from 'node:test';
import { centralizationGroupIds, classifyContractCentralization, moduleSpecifiers } from '../src/domain/maintainability-centralization.mjs';
import { classifyFilePath } from '../src/domain/file-class.mjs';
import { isTestPath } from '../src/domain/suspicion-map.mjs';
import { evaluateReview, maintainabilityBlocks } from '../src/native/verdict.mjs';

const classOf = file => (/\.test\.mjs$|^tests\//.test(file) ? 'test' : 'executable');

test('Given one module, its consumers and its test, When the group is classified, Then it is centralisation', () => {
  const verdict = classifyContractCentralization({
    occurrences: [
      { path: 'src/domain/source-span.mjs', role: 'definition' }, { path: 'src/domain/source-span.mjs', role: 'forwarder' },
      { path: 'src/native/reuse/scan.mjs', role: 'call-site' }, { path: 'src/native/maintainability/extract.mjs', role: 'call-site' },
      { path: 'tests/source-span.test.mjs', role: 'call-site' }, { path: 'tests/source-span.test.mjs', role: 'call-site' },
    ],
    classOf,
    sources: new Map([
      ['src/native/reuse/scan.mjs', "import { sourceSpan } from '../../domain/source-span.mjs';"],
      ['src/native/maintainability/extract.mjs', "import { sourceSpan } from '../../domain/source-span.mjs';"],
    ]),
  });
  assert.equal(verdict.centralization, true);
  assert.equal(verdict.owner, 'src/domain/source-span.mjs');
  assert.deepEqual(verdict.consumers.sort(), ['src/native/maintainability/extract.mjs', 'src/native/reuse/scan.mjs']);
});

test('Given a consumer that does not use the owner, When the group is classified, Then it is not centralisation', () => {
  const verdict = classifyContractCentralization({
    occurrences: [
      { path: 'src/domain/source-span.mjs', role: 'definition' },
      { path: 'src/infra/review-run-store.mjs', role: 'call-site' },
      { path: 'tests/source-span.test.mjs', role: 'call-site' },
    ],
    classOf,
    sources: new Map([['src/infra/review-run-store.mjs', 'export const root = 1;']]),
  });
  assert.equal(verdict.centralization, false);
  assert.match(verdict.reason, /does not use/);
});

test('Given a consumer whose source could not be read, When the group is classified, Then the exemption is not granted', () => {
  const verdict = classifyContractCentralization({
    occurrences: [
      { path: 'src/domain/source-span.mjs', role: 'definition' },
      { path: 'src/native/reuse/scan.mjs', role: 'call-site' },
      { path: 'tests/source-span.test.mjs', role: 'call-site' },
    ],
    classOf,
    sources: new Map(),
  });
  assert.equal(verdict.centralization, false);
  assert.match(verdict.reason, /unread/);
});

test('Given no test file at all, When the group is classified, Then it is not centralisation', () => {
  const verdict = classifyContractCentralization({
    occurrences: [{ path: 'src/domain/a.mjs', role: 'definition' }, { path: 'src/native/b.mjs', role: 'call-site' }],
    classOf,
    sources: new Map([['src/native/b.mjs', "import { x } from '../../domain/a.mjs';"]]),
  });
  assert.equal(verdict.centralization, false);
});

test('Given a confirmed item on an exempt group, When the verdict is evaluated, Then it does not block', () => {
  const candidate = { candidate_id: 'g38', decision: 'confirmed', stated_cost: 'coordination', priority: 'P2', forwarding_only: false };
  assert.equal(maintainabilityBlocks(candidate, { centralization: new Set(['g38']) }), false);
  assert.equal(maintainabilityBlocks(candidate, { centralization: new Set() }), true, 'without the exemption it still blocks');
});

test('Given a passing reviewer and an exempt group, When the verdict is evaluated, Then the review passes', () => {
  const stage = { agent: 'review-maintainability', exitCode: 0, aborted: false, structuredStatus: 'valid', data: { candidates: [{ candidate_id: 'g38', decision: 'confirmed', stated_cost: 'coordination', priority: 'P2', forwarding_only: false }] } };
  const base = { exitCode: 0, aborted: false, structuredStatus: 'valid', data: { test_harness: 'present' } };
  const result = evaluateReview({
    reviewer: { exitCode: 0, aborted: false, yieldStatus: 'success', text: 'report\n\nREVIEW_RESULT=PASS' },
    stages: [{ ...base, agent: 'review-context-scout' }, { ...base, agent: 'review-risk-hunter', data: { lane: 'correctness' } }, { ...base, agent: 'review-finding-verifier', data: { confirmed_findings: [], confirmed_coverage_gaps: [] } }, stage],
    profile: 'full',
    lanes: ['correctness'],
    fileClasses: [],
    maintainability: { policy: 'block', status: 'analyzed', coverage: 'full', planned: true },
    maintainabilityCentralization: new Set(['g38']),
  });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.pass, true);
});

/** The classifier the production path uses: executable-looking test files are re-tagged as test. */
const productionClassOf = file => (isTestPath(file) ? 'test' : classifyFilePath(file));

test('Given the production classifier, When a tests/ file is classified, Then it is a test path rather than executable', () => {
  assert.equal(classifyFilePath('tests/source-span.test.mjs'), 'executable', 'the raw classifier upgrades it');
  assert.equal(productionClassOf('tests/source-span.test.mjs'), 'test', 'the review re-tags it');
});

test('Given artifact groups from a real analysis, When the ids are computed, Then the shared contract is exempt and the copy is not', async () => {
  const groups = [
    {
      groupId: 'g38',
      occurrences: [
        { path: 'src/domain/source-span.mjs', role: 'definition' }, { path: 'src/domain/source-span.mjs', role: 'forwarder' },
        { path: 'src/native/reuse/scan.mjs', role: 'call-site' }, { path: 'tests/source-span.test.mjs', role: 'call-site' },
      ],
    },
    {
      groupId: 'g53',
      occurrences: [
        { path: 'src/domain/source-span.mjs', role: 'definition' }, { path: 'src/infra/review-run-store.mjs', role: 'call-site' },
        { path: 'tests/source-span.test.mjs', role: 'call-site' },
      ],
    },
  ];
  const sources = new Map([
    ['src/domain/source-span.mjs', 'export function sourceSpan() {}'],
    ['src/native/reuse/scan.mjs', "import { sourceSpan } from '../../domain/source-span.mjs';"],
    ['src/infra/review-run-store.mjs', 'export const root = 1;'],
  ]);
  const { exempt, decisions } = await centralizationGroupIds({
    groups,
    classOf: productionClassOf,
    readSource: async file => sources.get(file) ?? null,
  });
  assert.deepEqual([...exempt], ['g38']);
  assert.equal(decisions.find(entry => entry.groupId === 'g53').centralization, false);
});

test('Given a group that has no contract test under the production classifier, When the ids are computed, Then it still blocks', async () => {
  const groups = [{ groupId: 'g60', occurrences: [{ path: 'src/domain/a.mjs' }, { path: 'src/native/b.mjs' }] }];
  const { exempt } = await centralizationGroupIds({
    groups,
    classOf: productionClassOf,
    readSource: async file => (file.endsWith('b.mjs') ? "import { x } from '../../domain/a.mjs';" : 'export const a = 1;'),
  });
  assert.equal(exempt.size, 0);
});

test('Given a comment or an unrelated string naming the owner, When the specifiers are read, Then neither counts as an import', () => {
  const source = [
    "// import { x } from '../domain/source-span.mjs';",
    "/* from '../domain/source-span.mjs' */",
    "const note = \"import { y } from '../domain/source-span.mjs'\";",
    "export const a = 1;",
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(source), []);
});

test('Given a real import and a require, When the specifiers are read, Then both are named', () => {
  const source = "import { sourceSpan } from '../domain/source-span.mjs';\nconst other = require('./local.cjs');\n";
  assert.deepEqual(moduleSpecifiers(source), ['../domain/source-span.mjs', './local.cjs']);
});

test('Given a consumer that only mentions the owner in a comment, When the group is classified, Then it is not centralisation', () => {
  const verdict = classifyContractCentralization({
    occurrences: [
      { path: 'src/domain/source-span.mjs', role: 'definition' },
      { path: 'src/infra/copy.mjs', role: 'call-site' },
      { path: 'tests/source-span.test.mjs', role: 'call-site' },
    ],
    classOf: productionClassOf,
    sources: new Map([['src/infra/copy.mjs', "// from '../domain/source-span.mjs'\nexport const copy = 1;"]]),
  });
  assert.equal(verdict.centralization, false);
});

test('Given a consumer that imports the owner and also defines the same rule, When the group is classified, Then it is not centralisation', () => {
  const verdict = classifyContractCentralization({
    occurrences: [
      { path: 'src/domain/source-span.mjs', role: 'definition' },
      { path: 'src/domain/source-span.mjs', role: 'forwarder' },
      { path: 'src/infra/copy.mjs', role: 'definition' },
      { path: 'src/infra/copy.mjs', role: 'call-site' },
      { path: 'tests/source-span.test.mjs', role: 'call-site' },
    ],
    classOf: productionClassOf,
    sources: new Map([
      ['src/domain/source-span.mjs', 'export function sourceSpan(a, b) {}'],
      ['src/infra/copy.mjs', "import { sourceSpan } from '../domain/source-span.mjs';\nexport function myOwnSpan(a, b) { return a; }\nsourceSpan(1, 2);"],
    ]),
  });
  assert.equal(verdict.centralization, false);
  assert.match(verdict.reason, /defines the rule as well as importing it/);
});
