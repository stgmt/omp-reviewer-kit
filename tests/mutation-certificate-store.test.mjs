// Given/When/Then over the mutation certificate: the record that lets a release reuse one gate run.
// Every case works in a temporary folder, so nothing reads or writes the owner's home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  CERTIFICATE_SCHEMA,
  createCertificate,
  describeCertificate,
  isUsableCertificate,
} from '../src/domain/mutation-certificate.mjs';
import {
  certificateFile,
  certificatesRootDir,
  pruneCertificates,
  readCertificate,
  writeCertificate,
} from '../src/infra/mutation-certificate-store.mjs';
import { workingTreeHash } from '../scripts/release-preflight.mjs';

const run = promisify(execFile);
const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const temporaryDir = () => mkdtemp(path.join(tmpdir(), 'review-kit-cert-'));

test('Given a certificate for these bytes, When it is read back, Then the whole proof is restored', async () => {
  const dir = await temporaryDir();
  try {
    const certificate = createCertificate({ digest: DIGEST, mutants: 333, killed: 333, durationMs: 213_940, createdAt: '2026-11-02T00:00:00.000Z' });
    await writeCertificate(certificate, { dir });
    const read = await readCertificate(DIGEST, { dir });
    assert.deepEqual(read, certificate);
    assert.equal(read.schema, CERTIFICATE_SCHEMA);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a certificate file of another schema or of another digest, When it is read, Then it is treated as absent', async () => {
  const dir = await temporaryDir();
  try {
    await writeFile(path.join(dir, `${DIGEST}.json`), JSON.stringify({ schema: 'mutation-certificate@0', digest: DIGEST }));
    assert.equal(await readCertificate(DIGEST, { dir }), null, 'another schema is not migrated');

    await writeFile(path.join(dir, `${OTHER}.json`), JSON.stringify(createCertificate({ digest: DIGEST, mutants: 1, killed: 1, durationMs: 1 })));
    assert.equal(await readCertificate(OTHER, { dir }), null, 'a file named for other bytes proves nothing');

    assert.equal(await readCertificate('not-a-digest', { dir }), null, 'a malformed digest reads nothing');
    assert.throws(() => certificateFile(dir, 'not-a-digest'), /invalid certificate digest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a kill of the whole catalog, When the certificate is judged, Then only the same digest and the same catalog size are enough', () => {
  const certificate = createCertificate({ digest: DIGEST, mutants: 333, killed: 333, durationMs: 1000 });
  assert.equal(isUsableCertificate(certificate, { digest: DIGEST, mutants: 333 }), true);
  assert.equal(isUsableCertificate(certificate, { digest: OTHER, mutants: 333 }), false, 'other bytes');
  assert.equal(isUsableCertificate(certificate, { digest: DIGEST, mutants: 334 }), false, 'a grown catalog');
  assert.equal(isUsableCertificate({ ...certificate, killed: 332 }, { digest: DIGEST, mutants: 333 }), false, 'a partial kill proves nothing');
  assert.equal(isUsableCertificate({ ...certificate, digest: 'xyz' }, { digest: 'xyz', mutants: 333 }), false, 'a malformed digest');
  assert.equal(isUsableCertificate({ ...certificate, schema: 'something@2' }, { digest: DIGEST, mutants: 333 }), false, 'another schema');
  assert.equal(isUsableCertificate(null, { digest: DIGEST, mutants: 333 }), false);
});

test('Given a proof from five minutes ago, When it is described, Then the line names what was proved and how old it is', () => {
  const certificate = createCertificate({ digest: DIGEST, mutants: 333, killed: 333, durationMs: 213_940, createdAt: '2026-11-02T00:00:00.000Z' });
  assert.equal(describeCertificate(certificate, Date.parse('2026-11-02T00:05:00.000Z')), '333/333 mutants proved in 214s, 5 min old');
  assert.equal(describeCertificate(certificate, Date.parse('2026-11-02T00:00:30.000Z')), '333/333 mutants proved in 214s, 30s old');
  assert.equal(describeCertificate({ ...certificate, createdAt: 'not a date' }), '333/333 mutants proved in 214s, age unknown');
});

test('Given certificates of several ages, When the folder is pruned, Then the newest and the young ones stay', async () => {
  const dir = await temporaryDir();
  try {
    const digests = [0, 1, 2, 3].map(index => String(index).repeat(64));
    for (const [index, digest] of digests.entries()) {
      await writeCertificate(createCertificate({ digest, mutants: 1, killed: 1, durationMs: 1, createdAt: '2026-11-02T00:00:00.000Z' }), { dir });
      const stamp = new Date(Date.now() - index * 86_400_000);
      await utimes(path.join(dir, `${digest}.json`), stamp, stamp);
    }
    const removed = await pruneCertificates({ dir, keep: 2 });
    const left = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
    assert.equal(removed, 2);
    assert.deepEqual(left, [`${digests[0]}.json`, `${digests[1]}.json`], 'the newest two survive by modification time');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given two writers of one certificate, When the second rename is held and retried, Then no temporary file is left behind', async () => {
  const dir = await temporaryDir();
  try {
    let attempts = 0;
    const renameFile = async (from, to) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('held by a scanner');
        error.code = 'EBUSY';
        throw error;
      }
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    };
    await writeCertificate(createCertificate({ digest: DIGEST, mutants: 1, killed: 1, durationMs: 1 }), { dir, renameFile });
    assert.equal(attempts, 2, 'the retried rename is the one that landed');
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), []);
    assert.ok(await readCertificate(DIGEST, { dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given a folder that cannot be written, When a certificate is stored, Then the failure reaches the caller instead of being swallowed', async () => {
  const dir = await temporaryDir();
  try {
    const blocked = path.join(dir, 'a-file');
    await writeFile(blocked, 'not a directory');
    await assert.rejects(() => writeCertificate(createCertificate({ digest: DIGEST, mutants: 1, killed: 1, durationMs: 1 }), { dir: blocked }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Given an override in the environment, When the root folder is resolved, Then one machine keeps one view', () => {
  assert.equal(certificatesRootDir({ env: { OMP_REVIEW_KIT_MUTATION_CERT_DIR: 'C:/tmp/certs' }, home: 'C:/Users/x' }), path.resolve('C:/tmp/certs'));
  assert.equal(certificatesRootDir({ env: {}, home: 'C:/Users/x' }), path.join('C:/Users/x', '.omp', 'review-kit-mutation'));
  assert.equal(certificatesRootDir({ env: { OMP_REVIEW_KIT_MUTATION_CERT_DIR: '  ' }, home: 'C:/Users/x' }), path.join('C:/Users/x', '.omp', 'review-kit-mutation'));
});

test('Given the same file content, When the working tree is hashed, Then the digest survives a commit and changes with any edit', async () => {
  const repo = await temporaryDir();
  try {
    await run('git', ['init', '--quiet'], { cwd: repo });
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'a.mjs'), 'export const a = 1;\n');
    const before = await workingTreeHash({ cwd: repo });
    assert.match(String(before), /^[0-9a-f]{40,64}$/);

    await run('git', ['add', '-A'], { cwd: repo });
    await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one'], { cwd: repo });
    const afterCommit = await workingTreeHash({ cwd: repo });
    assert.equal(afterCommit, before, 'the content is what is certified, not the checkout state');

    await writeFile(path.join(repo, 'README.md'), 'unrelated\n');
    const edited = await workingTreeHash({ cwd: repo });
    assert.notEqual(edited, before, 'an edit outside the mutant files still changes the certified bytes');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
