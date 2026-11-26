import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHAIN_FORMAT,
  hasUnsafeExec,
  hostShellName,
  isChainNewer,
  isOwnedChain,
  isShellHost,
  readChainBlock,
  renderChainBlock,
  unsafeHostControl,
  withChainBlock,
} from '../src/domain/hook-chain.mjs';

const HOST = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';

describe('Feature: the review block in a foreign hook', () => {
  it('Given the canonical block, Then it is owned, closed and carries this format', () => {
    const block = renderChainBlock();
    assert.equal(isOwnedChain(block), true);
    assert.equal(isChainNewer(block), false);
    const parsed = readChainBlock(block);
    assert.equal(parsed.format, CHAIN_FORMAT);
    assert.equal(parsed.owned, true);
    assert.equal(parsed.start, 0);
    assert.ok(parsed.end > parsed.start);
  });

  it('Given a host hook, When the block is added, Then it lands after the shebang and the host lines stay byte-identical', () => {
    const { text, action } = withChainBlock(HOST);
    assert.equal(action, 'inserted');
    const block = renderChainBlock();
    assert.equal(text, '#!/usr/bin/env sh\n' + block + '. "$(dirname "$0")/h"\n');

    const second = withChainBlock(text);
    assert.equal(second.action, 'unchanged');
    assert.equal(second.text, text);
    assert.equal((text.match(/# >>> omp-reviewer-kit chain/g) ?? []).length, 1);
  });

  it('Given a CRLF host hook, Then the block keeps CRLF and the host keeps its bytes', () => {
    const host = '#!/usr/bin/env sh\r\n. "$(dirname "$0")/h"\r\n';
    const { text, action } = withChainBlock(host);
    assert.equal(action, 'inserted');
    assert.equal(text, '#!/usr/bin/env sh\r\n' + renderChainBlock('\r\n') + '. "$(dirname "$0")/h"\r\n');
    assert.equal(isOwnedChain(text), true);
  });

  it('Given a host without a shebang, Then the block goes first', () => {
    const { text } = withChainBlock('. "$(dirname "$0")/h"\n');
    assert.ok(text.startsWith('# >>> omp-reviewer-kit chain'));
    assert.ok(text.endsWith('. "$(dirname "$0")/h"\n'));
  });

  it('Given the block is before the host lines, Then it runs at exit through a trap', () => {
    const block = renderChainBlock();
    assert.match(block, /trap __omp_review_kit_exit EXIT/);
    const trapAt = block.indexOf('trap ');
    const hostAt = withChainBlock(HOST).text.indexOf('. "$(dirname "$0")/h"');
    assert.ok(trapAt >= 0 && trapAt < hostAt, 'the trap is installed before the host runs');
  });

  it('Given an edited block, Then it is not owned and adding refuses instead of overwriting it', () => {
    const edited = renderChainBlock().replace('node "$__omp_review_kit_root/.omp/review-kit/run-review.mjs"', 'true');
    assert.equal(isOwnedChain(edited), false);
    assert.throws(() => withChainBlock(edited), /edited omp-reviewer-kit chain block/);
  });

  it('Given a block of a newer format, Then it is left alone', () => {
    const newer = renderChainBlock().replaceAll(`chain v${CHAIN_FORMAT}`, `chain v${CHAIN_FORMAT + 1}`);
    assert.equal(isOwnedChain(newer), true);
    assert.equal(isChainNewer(newer), true);
    assert.deepEqual(withChainBlock(newer), { text: newer, action: 'newer' });
  });

  it('Given a start marker without a close, Then it is present but not owned', () => {
    const truncated = renderChainBlock().split('\n').slice(0, 3).join('\n');
    const parsed = readChainBlock(truncated);
    assert.equal(parsed.owned, false);
    assert.equal(parsed.end, -1);
    assert.throws(() => withChainBlock(truncated), /edited omp-reviewer-kit chain block/);
  });

  it('Given a host that replaces the shell with exec, Then it is not chainable; a returning host is', () => {
    assert.equal(hasUnsafeExec('#!/usr/bin/env bash\nif [ -x "$PY" ]; then\n  exec "$PY" -mpre_commit "${ARGS[@]}"\nfi\n'), true);
    assert.equal(hasUnsafeExec('#!/bin/sh\nlint-staged\nexec ./finish.sh\n'), true);
    assert.equal(hasUnsafeExec('#!/bin/sh\nnpm test\n'), false);
    assert.equal(hasUnsafeExec(HOST), false);
    assert.equal(hasUnsafeExec('#!/bin/sh\nlefthook run pre-commit\nexecuted=1\n'), false);
  });

  it('Given a hook for a non-shell interpreter, Then the shell block would be a syntax error there', () => {
    assert.equal(hostShellName('#!/usr/bin/env python3\nprint(1)\n'), 'python3');
    assert.equal(isShellHost('#!/usr/bin/env python3\nprint(1)\n'), false);
    assert.equal(isShellHost('#!/usr/bin/env node\nconsole.log(1)\n'), false);
    assert.equal(isShellHost('#!/bin/sh\n'), true);
    assert.equal(isShellHost('#!/usr/bin/env bash\n'), true);
    assert.equal(isShellHost('#!/usr/bin/env -S bash -e\n'), true);
    assert.equal(isShellHost('#!/bin/dash\n'), true);
    // No shebang: git runs the file with sh, so the block is safe.
    assert.equal(isShellHost('npm test\n'), true);
  });

  it('Given a host that installs its own trap, Then the review block cannot rely on its EXIT trap', () => {
    assert.equal(unsafeHostControl('#!/bin/sh\ntrap "rm -f .tmp" EXIT\nnpm test\n'), true);
    assert.equal(unsafeHostControl('#!/bin/sh\ntrap cleanup INT TERM\nnpm test\n'), true);
    assert.equal(unsafeHostControl('#!/bin/sh\nnpm test\n'), false);
    // The kit's own block carries the trap the review needs; it is not the host's and must not count.
    assert.equal(unsafeHostControl(renderChainBlock()), false);
    assert.equal(unsafeHostControl(withChainBlock('#!/bin/sh\nnpm test\n').text), false);
  });
});
