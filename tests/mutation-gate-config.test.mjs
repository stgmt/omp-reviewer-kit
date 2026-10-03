import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const quoted = (text) => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]);

function listAfter(source, name) {
  const from = source.indexOf(name);
  assert.ok(from >= 0, `${name} must exist`);
  return quoted(source.slice(from, source.indexOf('];', from) + 1));
}

const under = (file, roots) => roots.some((root) => file === root || file.startsWith(`${root}/`));

/** Everything the mutation gate replays must be inside the tree it copies into the temp directory. */
export function gateConfigProblems({ gateSource, layoutSource }) {
  const directories = listAfter(gateSource, 'const DIRECTORIES_TO_COPY');
  const files = listAfter(gateSource, 'const FILES_TO_COPY');
  const roots = [...directories, ...files];
  const problems = [];
  const mutantPaths = [...gateSource.matchAll(/\b(?:file|testFile): ?['"]([^'"]+)['"]/g)].map((match) => match[1]);
  for (const file of new Set(mutantPaths)) {
    if (!under(file, roots)) problems.push(`mutant path ${file} is not under a copied root`);
  }
  const layoutPaths = [
    ...listAfter(layoutSource, 'const required'),
    ...listAfter(layoutSource, 'const CLAUDE_PLUGIN_FILES').map((file) => `claude-plugin/${file}`),
  ];
  for (const file of layoutPaths) {
    if (!under(file, roots)) problems.push(`layout fixture path ${file} is not under a copied root`);
  }
  return { directories, files, problems };
}

test('Every copy-list entry of the mutation gate exists, and every replayed path is inside it', async () => {
  const gateSource = await readFile('scripts/run-mutation-tests.mjs', 'utf8');
  const layoutSource = await readFile('scripts/check-layout.mjs', 'utf8');
  const { directories, files, problems } = gateConfigProblems({ gateSource, layoutSource });
  assert.ok(directories.includes('claude-plugin') && directories.includes('.github'));
  for (const entry of [...directories, ...files]) await access(path.join(process.cwd(), entry));
  assert.deepEqual(problems, []);
});

test('The gate configuration check reports a mutant or fixture path outside the copied roots', () => {
  const gateSource = [
    "const DIRECTORIES_TO_COPY = ['src', 'tests'];",
    "const FILES_TO_COPY = ['package.json'];",
    "  { id: 'a', file: 'src/a.mjs', testFile: 'tests/a.test.mjs' },",
    "  { id: 'b', file: 'claude-plugin/scripts/bridge.mjs', testFile: \"tests/b.test.mjs\" },",
  ].join('\n');
  const layoutSource = "const required = ['package.json', '.github/workflows/ci.yml'];\nconst CLAUDE_PLUGIN_FILES = [];";
  const { problems } = gateConfigProblems({ gateSource, layoutSource });
  assert.deepEqual(problems, [
    'mutant path claude-plugin/scripts/bridge.mjs is not under a copied root',
    'layout fixture path .github/workflows/ci.yml is not under a copied root',
  ]);
});
