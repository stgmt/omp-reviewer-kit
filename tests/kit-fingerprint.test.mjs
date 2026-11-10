// The kit's own identity: the version and the agent-prompt digest that a journal entry is bound to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readAgentsDigest, readKitVersion } from '../src/infra/kit-fingerprint.mjs';

async function tempKit({ version = '9.9.9', agents = { 'a.md': 'first prompt\n', 'b.md': 'second prompt\n' } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-fingerprint-'));
  if (version !== null) await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'kit', version }), 'utf8');
  if (agents !== null) {
    await mkdir(path.join(root, 'agents'), { recursive: true });
    for (const [name, body] of Object.entries(agents)) await writeFile(path.join(root, 'agents', name), body, 'utf8');
  }
  return root;
}

test('Given a package.json, When the version is read, Then it is the declared version', async () => {
  const root = await tempKit();
  try {
    assert.equal(await readKitVersion(root), '9.9.9');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given no readable package.json, When the version is read, Then it is null', async () => {
  const root = await tempKit({ version: null });
  try {
    assert.equal(await readKitVersion(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given the agent prompts, When the digest is read twice, Then it is the same digest', async () => {
  const root = await tempKit();
  try {
    assert.equal(await readAgentsDigest(root), await readAgentsDigest(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given an edited prompt, When the digest is read, Then it changes', async () => {
  const root = await tempKit();
  try {
    const before = await readAgentsDigest(root);
    await writeFile(path.join(root, 'agents', 'a.md'), 'a different prompt\n', 'utf8');
    assert.notEqual(await readAgentsDigest(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Given no agents directory, When the digest is read, Then it is null rather than a guess', async () => {
  const root = await tempKit({ agents: null });
  try {
    assert.equal(await readAgentsDigest(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
