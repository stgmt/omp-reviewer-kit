// What OpenCode receives when it starts the plugin: the tool names it can call, the argument shape it
// is given, and the hook OpenCode runs before a tool. A host that found only one of them would lose
// either the review or the read-only inspection, and nothing else in the suite would notice.

import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../opencode/plugin.mjs';

test('Given OpenCode starts the plugin, When the server is created, Then both advertised tools are callable and declare their arguments', async () => {
  const hooks = await plugin.server({ directory: process.cwd() });
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['review_git', 'review_kit']);
  for (const [name, definition] of Object.entries(hooks.tool)) {
    assert.equal(typeof definition.execute, 'function', `${name} exposes execute`);
    assert.equal(typeof definition.description, 'string', `${name} describes itself`);
    assert.ok(definition.args && typeof definition.args === 'object', `${name} declares its argument shape`);
    assert.ok(Object.hasOwn(definition.args, 'operation'), `${name} accepts the documented operation selector`);
  }
  assert.equal(typeof hooks['tool.execute.before'], 'function', 'the guard hook is registered');
  assert.equal(plugin.id, 'omp-reviewer-kit');
});
