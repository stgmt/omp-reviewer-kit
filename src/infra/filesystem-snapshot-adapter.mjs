import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SnapshotStorePort } from '../application/ports.mjs';
import { sanitizePromptToken } from '../domain/review-prompt.mjs';

const SNAPSHOT_RETENTION = 5;
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A .live marker protects a dir in use by a running review; markers older
// than a day belong to dead processes and no longer exempt the dir.
const SNAPSHOT_LIVE_TTL_MS = 24 * 60 * 60 * 1000;

// Per-consumer in-use markers: `.live-<pid>` at the snapshot root. Any fresh
// marker exempts the dir from EVERY sweep deletion path; each consumer
// removes only its own marker on release.
const LIVE_MARKER_RE = /^\.live(?:-\d+(?:-[0-9a-f]+)?)?$/;

/**
 * True when pid plausibly still owns a live resource: signal-0 probes a
 * running process (EPERM also means alive); ESRCH means it exited.
 * Fail-open on other platforms' quirks: a live-looking report is kept.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
const CONTROL_BYTES_RE = /[\x00-\x1f\x7f-\x9f]/;

// Windows/NTFS strips trailing dots and spaces from file and directory
// names; POSIX folds none. A staged name that FOLDS into a reserved name
// ('.live-1.', '.review ') must be treated as the reserved name, not a
// harmless sibling.
function foldFsName(name) {
  return name
    // Win32 DOS-to-NT normalization folds superscript digits U+00B9..B3 to
    // ASCII 1-3 ('com\u00B9' resolves to COM1); fold before the device check.
    .replace(/[\u00B9\u00B2\u00B3]/g, (ch) => ({ '\u00B9': '1', '\u00B2': '2', '\u00B3': '3' }[ch]))
    .replace(/[. ]+$/, '');
}

const DOS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/i;
const NTFS_SHORT_ALIAS_RE = /~\d+(?:\.[^.\\/]*)?$/;

function assertSafeSnapshotPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    CONTROL_BYTES_RE.test(filePath) ||
    path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(filePath) ||
    // Split on BOTH separators: Windows path.resolve honors '\' too, so a
    // staged 'z\..\a.mjs' escapes the '/'-only check and materializes
    // outside the snapshot (or forges .live* markers via 'z\..\.live-99').
    filePath.split(/[\\/]/).some((seg) => seg === '..' || foldFsName(seg) === '..') ||
    // A colon inside any segment is an NTFS alternate data stream
    // ('file.ts:evil' writes the ADS of file.ts on Windows): the manifest
    // lists the staged name while the bytes land on a sibling stream —
    // silent content evasion, same hazard class as device names.
    // Windows-only hazards: ADS colons, DOS device names, and NTFS 8.3
    // aliases are all legal POSIX filenames — gating on platform keeps
    // Linux/macOS reviews from failing on staged POSIX-legal paths.
    (process.platform === 'win32'
      && filePath.split(/[\\/]/).some((seg) => seg.includes(':'))) ||
    // DOS device basenames (con/nul/aux/com1-9/lpt1-9, extension-insensitive)
    // sink writes to a device on Windows — staged payload bytes would never
    // land on disk while the manifest lists the path: silent content evasion.
    (process.platform === 'win32'
      && filePath.split(/[\\/]/).some((seg) => DOS_DEVICE_RE.test(foldFsName(seg)))) ||
    // NTFS 8.3 short-name aliases ('FOO~1.TXT') write through to whatever the
    // 8.3 name resolves to on volumes where alias generation is enabled —
    // the staged name can overwrite a sibling file's bytes.
    (process.platform === 'win32'
      && filePath.split(/[\\/]/).some((seg) => NTFS_SHORT_ALIAS_RE.test(seg)))
  ) {
    // Error text escapes the raw staged path: err.message flows into the
    // review_failure envelope, last-run.json and notify sinks — C0/C1/ADS
    // bytes inside it must never reach reviewer-facing surfaces raw.
    throw new Error(`Unsafe staged path in snapshot: ${sanitizePromptToken(filePath)}`);
  }
}

/**
 * Infrastructure adapter materializing a StagedSnapshot onto the filesystem.
 *
 * The returned directory is only a read source for the reviewer. The caller
 * keeps the real repository as its working directory so Git and OMP discovery
 * continue to work normally.
 */
export class FileSystemSnapshotAdapter extends SnapshotStorePort {
  #leaseName;
  /** Per-dir binding: which lease name THIS adapter stamped in each dir.
   *  #leaseName re-rolls per create() so ops on earlier dirs must resolve
   *  through this map, not the current field (r29 correctness-1). */
  #leaseByDir = new Map();
  /** Serializes create() on this adapter: overlapping calls re-roll
   *  #leaseName mid-flight, orphaning the earlier marker inside the shared
   *  reuseDir (it then reads as a foreign live lease and blocks sweeps).
   *  Queued create() calls run one-at-a-time on this promise chain. */
  #createGate = Promise.resolve();
  /** Lease marker name for the current run (test/introspection surface). */
  get leaseName() {
    return this.#leaseName;
  }
  constructor() {
    super();
    // Per-run lease name: same-process concurrent runs MUST NOT share the
    // `.live-<pid>` marker — a sibling's release()/dropOwnMarker would unlink
    // our lease mid-flight and #assertOwnLease would then refuse the dir.
    this.#leaseName = `.live-${process.pid}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * @param {import('../domain/staged-snapshot.mjs').StagedSnapshot} snapshot
   * @param {{ diffBytes?: Buffer, changedPaths?: string[], fileClasses?: { path: string, fileClass: string, sha256?: string|null }[], reuseDir?: string }} [artifacts]
   * @returns {Promise<string>}
   */
  create(snapshot, artifacts) {
    const run = this.#createGate.then(() => this.#createInner(snapshot, artifacts));
    this.#createGate = run.catch(() => {});
    return run;
  }

  async #createInner(snapshot, artifacts) {
    this.lastReused = null;
    // Fresh run → fresh lease name, so sequential create() calls on this
    // adapter also carry distinct markers.
    this.#leaseName = `.live-${process.pid}-${randomBytes(4).toString('hex')}`;
    const reuseDir = typeof artifacts?.reuseDir === 'string' ? artifacts.reuseDir : null;
    if (reuseDir) {
      // Stamp our lease BEFORE the reuse probe: the dir is unprotected
      // while #isReusable byte-verifies the whole index, and a concurrent
      // same-diff review could rm+rebuild it out from under us mid-check —
      // we would then markLive inside THEIR tree and serve bytes we never
      // verified. The stamp is idempotent: reused → same marker retained;
      // rejected → the rebuild either re-stamps into the rm'd+recreated
      // dir or we drop our marker when diverting to transient.
      const dirInfo = await stat(reuseDir).catch(() => null);
      if (dirInfo?.isDirectory()) {
        // The dir is unprotected at this instant: a concurrent sweep or
        // rebuild can delete it between stat and markLive — a vanished dir
        // means the stamp is moot, not fatal.
        try {
          await this.#markLive(reuseDir);
        } catch {
          await this.#dropOwnMarker(reuseDir);
        }
      }
    }
    if (reuseDir && (await this.#isReusable(snapshot, reuseDir, artifacts?.diffBytes, artifacts?.fileClasses, artifacts?.changedPaths))) {
      // Deterministic reuse: identical staged content was materialized before
      // and re-verified byte-for-byte over the WHOLE served index.
      this.#markReused(reuseDir);
      // The shared cache dir is read-only for the run lifetime: the durable
      // per-run report lives OUTSIDE it (see ReviewPrompt reportPath), so
      // reuse must not create, delete, or overwrite anything inside.
      await this.#touch(reuseDir);
      await this.#sweep(reuseDir);
      let ownLeaseHeld = true;
      try {
        await this.#assertOwnLease(reuseDir);
      } catch {
        // Another consumer destroyed our lease mid-verify (e.g. stale-detach
        // in their claim path) — fall through to a private staging dir;
        // bytes verify from the live index either way, so a lost lease is a
        // divert, never a hard failure.
        this.lastReused = null;
        await this.#dropOwnMarker(reuseDir);
        ownLeaseHeld = false;
      }
      if (ownLeaseHeld) return reuseDir;
    }
    let targetDir = null;
    if (reuseDir && (await this.#isLive(reuseDir))) {
      // A rejected reuseDir that still serves a running review must never be
      // destroyed — materialize into a transient dir instead. Our early
      // stamp came with us: drop it so we do not extend false liveness on a
      // dir serving a foreign run.
      await this.#dropOwnMarker(reuseDir);
    }
    // Rebuild goes into a private staging dir first: the diff-addressed
    // reuseDir is then claimed by a single atomic rename, so two concurrent
    // same-diff reviews can never interleave materialize writes inside one
    // shared dir (the old rm→mkdir→markLive window let process A rm B's
    // mid-build tree and both served interleaved bytes).
    targetDir = await mkdtemp(path.join(tmpdir(), 'reviewer-kit-snapshot-'));
    try {
      // Stamp BEFORE materialize: the stage dir carries the shared
      // 'reviewer-kit-snapshot-' prefix, and the retention sweep deletes
      // unprotected dirs beyond SNAPSHOT_RETENTION — an unmarked staging
      // dir mid-materialize is a victim for any concurrent sweeper.
      await this.#markLive(targetDir);
      await this.materialize(snapshot, targetDir);
      await this.#writeReviewArtifacts(targetDir, artifacts);
      if (reuseDir) {
        targetDir = await this.#claimReuseDir(reuseDir, targetDir);
      }
      return targetDir;
    } catch (error) {
      // A staging dir we failed to claim is OURS — remove it. A claimed
      // reuseDir is never rm'd on failure: a concurrent actor may already
      // serve it; we only drop our own lease marker.
      if (targetDir === reuseDir) {
        await this.#dropOwnMarker(targetDir);
      } else {
        await this.remove(targetDir);
        // A failed claim must not leave our early stamp on the rejected
        // reuseDir — it would fake liveness for a stale/foreign dir.
        if (reuseDir) await this.#dropOwnMarker(reuseDir);
      }
      throw error;
    }
  }

  /** Finds OUR lease marker file actually present in dir (own PID + any run hex). */
  async #ownMarkerIn(dir) {
    // r27+r29 correctness-1: prefer the lease WE stamped in THIS dir
    // (per-dir map — #leaseName re-rolls per create() and would otherwise
    // orphan earlier dirs' markers). Fallback order when the map has no
    // entry (marker planted by an earlier create() roll or by tests that
    // stamp directly): the current #leaseName, then the first own-PID
    // marker — sibling same-PID hexes lose to our recorded leases.
    const names = await readdir(dir).catch(() => []);
    const mapped = this.#leaseByDir.get(dir);
    if (mapped && names.includes(mapped)) return mapped;
    if (names.includes(this.#leaseName)) return this.#leaseName;
    // NO same-PID scan: `.live-<pid>-<hex>` with a hex other than our recorded
    // lease is a FOREIGN adapter instance's marker — picking it here made
    // #dropOwnMarker unlink a sibling's lease mid-review (r41 correctness-1).
    return null;
  }

  /** Removes only OUR lease marker(s); a foreign takeover owns a different PID. */
  async #dropOwnMarker(dir) {
    const name = await this.#ownMarkerIn(dir);
    if (name) await rm(path.join(dir, name), { force: true }).catch(() => {});
    this.#leaseByDir.delete(dir);
  }

  /**
   * Atomically move the staged tree onto the diff-addressed reuseDir. Any
   * contention (dir appears mid-claim, foreign lease, rename refusal) falls
   * back to serving the private staging dir — correctness over cache sharing.
   *
   * @param {string} reuseDir
   * @param {string} stageDir private dir holding the fully materialized tree
   * @returns {Promise<string>} the dir to serve (reuseDir on claim, stageDir otherwise)
   */
  async #claimReuseDir(reuseDir, stageDir) {
    // A leftover stale dir in the slot is not ours to serve; detach it into a
    // private trash name first so a foreign in-flight writer keeps its own
    // handle instead of corrupting our fresh tree. It may reappear between
    // our live check and detach — a fresh foreign stamp means divert.
    const dirInfo = await stat(reuseDir).catch(() => null);
    if (dirInfo) {
      if (await this.#isLive(reuseDir)) {
        await this.#dropOwnMarker(reuseDir);
        return stageDir;
      }
      // Foreign lease may appear any instant: detach-by-rename keeps the
      // owner's fd-valid path alive even if they stamped after our check —
      // their process holds the renamed dir, never our bytes.
      const trashDir = `${reuseDir}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(reuseDir, trashDir);
      } catch {
        await this.#dropOwnMarker(reuseDir);
        return stageDir; // someone else claimed/removed it — serve ours
      }
      // Our early stamp rode the rename into trashDir — unlink OUR marker by
      // name so the protection re-check below counts only real foreign
      // leases; an own-marker must never keep detached junk alive for 24h.
      const movedLease = this.#leaseByDir.get(reuseDir);
      if (movedLease) await rm(path.join(trashDir, movedLease), { force: true }).catch(() => {});
      this.#leaseByDir.delete(reuseDir);
      // Post-rename re-check mirrors #sweep: a foreign lease stamped between
      // our probe and the rename moves WITH the tree into trashDir — deleting
      // it kills a live consumer's marker. Leave the detached tree for the
      // next sweep instead of rm'ing over a foreign stamp.
      if (!(await this.#isProtected(trashDir))) {
        await rm(trashDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    try {
      await rename(stageDir, reuseDir);
    } catch {
      // Claim lost to a concurrent creator — our staging dir is authoritative.
      await this.#dropOwnMarker(reuseDir);
      return stageDir;
    }
    // The staging dir's lease name moves with the tree — rebind the map.
    this.#leaseByDir.set(reuseDir, this.#leaseByDir.get(stageDir));
    this.#leaseByDir.delete(stageDir);
    // The rename consumed stageDir — there is no fallback left. Sweep foreign
    // debris, then fail closed if our lease is gone: a same-process sibling
    // or a destroyer mid-flight must never be served an unverified tree.
    await this.#sweep(reuseDir);
    await this.#assertOwnLease(reuseDir);
    return reuseDir;
  }


  /**
   * A cached snapshot is reusable when every check binds the on-disk cache to
   * the CURRENT staged content, not merely to itself:
   * - the directory tree contains EXACTLY the staged file set plus the
   *   `.review/` artifacts and `.live*` markers — any foreign file,
   *   symlink, junction, or other non-regular entry at the root or under
   *   staged subdirectories fails reuse (planted bytes must never be
   *   served as staged content),
   * - `.review/` contains only diff.patch, changed-files.txt and (when the
   *   run classifies paths) file-classes.json — a stale or planted
   *   report.md fails reuse and the dir is rebuilt clean,
   * - `.review/diff.patch` byte-equals the current staged diff,
   * - `.review/changed-files.txt` byte-equals the changed-path manifest,
   * - `.review/file-classes.json` round-trips and its rows form an exact
   *   bijection with the live fileClasses rows — same path set, matching
   *   fileClass and equal sha256 per path (deleted paths carry null on
   *   both sides) — so a self-consistent forged manifest pointing at
   *   attacker bytes is rejected, and
   * - every staged file in the WHOLE index byte-equals its staged content
   *   (two worktrees can stage an identical patch while differing in
   *   unchanged files).
   * A cache written by an older runner or planted in tmpdir fails any of
   * these checks and is rematerialized from the live index instead.
   */
  async #isReusable(snapshot, reuseDir, diffBytes, fileClasses, changedPaths) {
    if (!Buffer.isBuffer(diffBytes)) return false;
    try {
      // Enumerate the whole tree: every served path must be a staged file,
      // a `.review/` artifact, or a `.live*` marker. Extra planted files are
      // the direct "serve attacker bytes as staged source" vector.
      const expected = new Set(snapshot.files.map((f) => f.path.replace(/\\/g, '/')));
      const stack = [''];
      while (stack.length > 0) {
        const rel = stack.pop();
        const abs = rel === '' ? reuseDir : path.join(reuseDir, ...rel.split('/'));
        const dirents = await readdir(abs, { withFileTypes: true });
        for (const e of dirents) {
          const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
          if (e.isDirectory()) {
            if (childRel === '.review') continue; // handled below
            stack.push(childRel);
            continue;
          }
          // Non-regular entries (symlinks, junctions, fifos, sockets) are
          // never staged content: withFileTypes does not follow links, so
          // skipping them would let planted entries evade this check.
          if (!e.isFile()) return false;
          if (rel === '' && LIVE_MARKER_RE.test(e.name)) continue;
          if (!expected.has(childRel)) return false;
        }
      }

      const reviewDir = path.join(reuseDir, '.review');
      const expectedArtifacts = new Set(['diff.patch', 'changed-files.txt']);
      if (Array.isArray(fileClasses)) expectedArtifacts.add('file-classes.json');
      const entries = await readdir(reviewDir, { withFileTypes: true });
      if (entries.some((e) => !e.isFile() || !expectedArtifacts.has(e.name))) return false;
      const names = new Set(entries.map((e) => e.name));
      if (!names.has('diff.patch')) return false;

      const existing = await readFile(path.join(reviewDir, 'diff.patch'));
      if (!existing.equals(diffBytes)) return false;
      if (Array.isArray(changedPaths)) {
        const expected = `${changedPaths.map((p) => sanitizePromptToken(p)).join('\n')}\n`;
        const onDisk = await readFile(path.join(reviewDir, 'changed-files.txt'), 'utf8');
        if (onDisk !== expected) return false;
      }
      if (Array.isArray(fileClasses)) {
        const manifest = JSON.parse(await readFile(path.join(reviewDir, 'file-classes.json'), 'utf8'));
        if (manifest.schema !== 'file-classes@1' || !Array.isArray(manifest.files)) return false;
        if (manifest.files.length !== fileClasses.length) return false;
        // Bijection: every live fileClasses row binds to a manifest row for
        // the SAME path with the SAME fileClass and the SAME sha256; every
        // manifest row must name a live staged path. A forged manifest whose
        // rows are only self-consistent (rows sha256-verifying planted bytes
        // under arbitrary paths) fails here. Deleted staged paths carry
        // sha256:null on BOTH sides (absent from snapshot.files, nothing to
        // hash) — null equals null, so deletion diffs reuse; a null forged
        // against a live non-null row still mismatches and fails.
        // Path keys sanitize identically to the writer, so deletion diffs
        // whose control bytes were escaped on disk still biject with the
        // live rows — and a forged manifest never keys on a raw path that
        // only LOOKS equal after escaping.
        const expectedByPath = new Map(fileClasses.map((row) => [sanitizePromptToken(row.path), row]));
        const manifestByPath = new Map();
        for (const row of manifest.files) {
          const sha = row?.sha256 ?? null;
          if (typeof row?.path !== 'string' || (sha !== null && (typeof sha !== 'string' || sha.length === 0))) {
            return false;
          }
          if (manifestByPath.has(row.path)) return false;
          manifestByPath.set(row.path, row);
        }
        for (const row of manifest.files) {
          const expected = expectedByPath.get(row.path);
          if (!expected || expected.fileClass !== row.fileClass) return false;
        }
        for (const row of fileClasses) {
          const manifestRow = manifestByPath.get(sanitizePromptToken(row.path));
          if (!manifestRow || manifestRow.sha256 !== row.sha256) return false;
        }
      }

      // Whole-index binding: the snapshot serves EVERY staged file to the
      // reviewer, so reuse verifies every served byte — not only the paths
      // that appear in the diff. Two repos/worktrees can stage a
      // byte-identical patch while differing in unchanged files; hashing
      // only the manifest would serve foreign content as staged source.
      for (const file of snapshot.files) {
        assertSafeSnapshotPath(file.path);
        const bytes = await readFile(path.join(reuseDir, ...file.path.split('/'))).catch(() => null);
        if (!bytes || !bytes.equals(file.content)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Refreshes a directory's mtime so a just-revalidated cache entry is not
   * treated as stale by the very sweep that follows it.
   */
  async #touch(dir) {
    const now = new Date();
    await utimes(dir, now, now).catch(() => {});
  }

  #markReused(reuseDir) {
    this.lastReused = reuseDir;
  }

  /** @returns {string|null} the reuseDir returned by the last create() call when it was reused, else null */
  get reusedDir() {
    return this.lastReused ?? null;
  }

  /**
   * Prune cached snapshot dirs under the OS temp root: oldest-first beyond
   * SNAPSHOT_RETENTION and everything older than SNAPSHOT_TTL_MS.
   */
  async #sweep(excludeDir = null) {
    try {
      const base = tmpdir();
      const names = await readdir(base);
      const candidates = [];
      for (const name of names) {
        if (!name.startsWith('reviewer-kit-snapshot-')) continue;
        const full = path.join(base, name);
        if (excludeDir && path.resolve(full) === path.resolve(excludeDir)) continue;
        const info = await lstat(full).catch(() => null);
        if (!info || !info.isDirectory()) continue;
        candidates.push({ full, mtimeMs: info.mtimeMs });
      }
      // Liveness first: ANY fresh `.live*` marker exempts the dir from every
      // deletion path (TTL expiry AND retention count). Without this a long
      // review loses its input the moment 5 newer dirs accumulate.
      const now = Date.now();
      const unprotected = [];
      for (const c of candidates) {
        if (await this.#isProtected(c.full)) continue;
        unprotected.push(c);
      }
      const victims = unprotected.filter((c) => now - c.mtimeMs > SNAPSHOT_TTL_MS);
      const fresh = unprotected
        .filter((c) => now - c.mtimeMs <= SNAPSHOT_TTL_MS)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      victims.push(...fresh.slice(SNAPSHOT_RETENTION));
      for (const victim of victims) {
        // Narrow the check-then-delete race: a lease stamped after the
        // protection census must still stop this rm (no lock exists for
        // same-user tmpdir sharing; re-checking shrinks the window).
        if (await this.#isProtected(victim.full)) continue;
        await rm(victim.full, { recursive: true, force: true }).catch(() => {});
      }
      // Orphan per-run durable reports (crashed runs never reach their
      // finally): files only, TTL-bounded, and only when the owning pid is
      // no longer alive — a same-diff concurrent run must never lose its
      // report fallback mid-flight.
      for (const name of names) {
        if (!name.startsWith('reviewer-kit-report-') || !name.endsWith('.md')) continue;
        const full = path.join(base, name);
        const info = await lstat(full).catch(() => null);
        if (!info || !info.isFile()) continue;
        if (now - info.mtimeMs <= SNAPSHOT_TTL_MS) continue;
        const owner = Number(name.match(/-(\d+)\.md$/)?.[1]);
        if (Number.isInteger(owner) && isPidAlive(owner)) continue;
        await rm(full, { force: true }).catch(() => {});
      }
    } catch {
      // Sweeping is best-effort hygiene; never fail a review over it.
    }
  }

  /**
   * True while any OTHER consumer's `.live*` marker in dir is younger than
   * SNAPSHOT_LIVE_TTL_MS. Our own `.live-<pid>` never blocks create(): it is
   * this process's lease, not a foreign consumer's.
   */
  async #isLive(dir) {
    const names = await readdir(dir).catch(() => []);
    const now = Date.now();
    const ownPid = new RegExp(`^\\.live-${process.pid}(?:-[0-9a-f]+)?$`);
    for (const name of names) {
      // All own-PID markers are ours — a stale hex from a dead earlier run
      // of THIS process is not a live foreign consumer.
      if (!LIVE_MARKER_RE.test(name) || ownPid.test(name)) continue;
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info && info.isFile() && now - info.mtimeMs < SNAPSHOT_LIVE_TTL_MS) return true;
    }
    return false;
  }

  /**
   * True while this process's own `.live-<pid>` marker file exists in dir
   * (any mtime — just stamped seconds ago by create()).
   */
  async #hasOwnLease(dir) {
    const name = this.#leaseByDir.get(dir);
    if (!name) return false;
    const info = await stat(path.join(dir, name)).catch(() => null);
    return !!info && info.isFile();
  }

  /**
   * Fail closed after any sweep touching a retained dir: if our own lease
   * is gone, a concurrent actor destroyed the dir mid-flight — serving it
   * would hand reviewers a deleted or foreign tree.
   */
  async #assertOwnLease(dir) {
    if (!(await this.#hasOwnLease(dir))) {
      throw new Error(`Snapshot dir lost its in-use lease mid-flight: ${dir}`);
    }
  }

  /**
   * True while any `.live*` marker — including our own — is younger than
   * SNAPSHOT_LIVE_TTL_MS. Sweep protection counts every consumer's lease.
   */
  async #isProtected(dir) {
    const names = await readdir(dir).catch(() => []);
    const now = Date.now();
    for (const name of names) {
      if (!LIVE_MARKER_RE.test(name)) continue;
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info && info.isFile() && now - info.mtimeMs < SNAPSHOT_LIVE_TTL_MS) return true;
    }
    return false;
  }

  /**
   * Stamps this consumer's in-use marker (`.live-<pid>`); the retention
   * sweep honors every fresh marker, so concurrent consumers each hold
   * their own lease. Throws on failure: a silently unmarked dir would be
   * served without sweep protection.
   */
  async #markLive(dir) {
    // Capture the lease name BEFORE any await: a concurrent create() on this
    // shared adapter re-rolls this.#leaseName, and a post-await re-read would
    // bind the dir to a name we never wrote (r7 correctness-1 torn entry).
    const lease = this.#leaseName;
    const marker = path.join(dir, lease);
    // Reclaim only the lease THIS instance previously recorded for this dir:
    // the per-dir map keeps just the last name, so the old marker would
    // orphan and count as a foreign live lease for other processes. Same-PID
    // markers with a different name may belong to a FOREIGN adapter instance
    // (sibling OMP review) — they are NEVER removed here.
    const prevLease = this.#leaseByDir.get(dir);
    if (prevLease && prevLease !== lease) {
      await rm(path.join(dir, prevLease), { force: true }).catch(() => {});
    }
    await writeFile(marker, `${process.pid}\n`, 'utf8');
    const now = new Date();
    await utimes(marker, now, now).catch(() => {});
    this.#leaseByDir.set(dir, lease);
  }

  /**
   * Re-stamps this process's lease on a retained dir (heartbeat). Reviews
   * outliving SNAPSHOT_LIVE_TTL_MS keep sweep protection for their whole
   * duration instead of aging out mid-run. Missing marker → NO-OP, always:
   * the marker is absent because release() already ran (an in-flight tick
   * landing after release must never resurrect the lease as a foreign-live
   * marker for up to 24h) or the dir was swept. A non-regular marker at
   * our lease name is removed (lease tamper) instead of updated.
   *
   * @param {string} snapshotDir
   * @returns {Promise<void>}
   */
  async refreshLease(snapshotDir) {
    const name = await this.#ownMarkerIn(snapshotDir);
    if (!name) return; // nothing stamped in THIS dir by this process — never resurrect
    const marker = path.join(snapshotDir, name);
    const info = await lstat(marker).catch(() => null);
    if (info === null) return;
    if (!info.isFile()) {
      await rm(marker, { recursive: true, force: true }).catch(() => {});
      return;
    }
    const now = new Date();
    await utimes(marker, now, now).catch(() => {});
  }

  /**
   * Releases ONLY this process's in-use marker WITHOUT deleting the
   * directory: used for snapshot dirs that outlive this run as cache
   * entries (the deterministic reuseDir). Other consumers' markers are
   * untouched, so a concurrent review stays protected.
   *
   * @param {string} snapshotDir
   * @returns {Promise<void>}
   */
  async release(snapshotDir) {
    const name = await this.#ownMarkerIn(snapshotDir);
    if (!name) return;
    const marker = path.join(snapshotDir, name);
    const info = await lstat(marker).catch(() => null);
    // A non-regular marker at our lease name is foreign content (symlink,
    // planted dir) — never unlink it, and fail loudly: lease state was
    // tampered with mid-run.
    if (info && !info.isFile()) {
      throw new Error(`snapshot lease marker is not a regular file: ${marker}`);
    }
    await rm(marker, { force: true }).catch(() => {});
    this.#leaseByDir.delete(snapshotDir);
  }

  /**
   * @param {string} snapshotDir
   * @returns {Promise<void>}
   */
  async remove(snapshotDir) {
    this.#leaseByDir.delete(snapshotDir);
    await rm(snapshotDir, { recursive: true, force: true });
  }

  /**
   * @param {import('../domain/staged-snapshot.mjs').StagedSnapshot} snapshot
   * @param {string} targetDir
   * @returns {Promise<void>}
   */
  async materialize(snapshot, targetDir) {
    // Two staged paths can fold onto ONE on-disk name — case-insensitive
    // (SRC/x vs src/x), backslash-vs-slash (a\b vs a/b), NTFS trailing
    // dot/space strip (file. vs file). Without a seen-set the later index
    // entry wins last-write-wins while diff.patch lists both: the reviewer
    // reads bytes that differ from what the index commits. Fail closed on
    // any fold collision; deterministic on every platform.
    const seenDestinations = new Set();
    for (const file of snapshot.files) {
      assertSafeSnapshotPath(file.path);
      const normalized = file.path.replace(/\\/g, '/').toLowerCase();
      if (normalized === '.review' || normalized.startsWith('.review/')) {
        throw new Error(`Staged path collides with reserved snapshot artifacts directory: ${file.path}`);
      }
      // The `.live*` root namespace is adapter lease state: a staged file
      // with that name would forge an in-use lease (sweep- and TTL-immune
      // for 24h) or be deleted by release() when it matches the own pid.
      const topSegment = normalized.split('/')[0];
      if (LIVE_MARKER_RE.test(topSegment)) {
        throw new Error(`Staged path collides with reserved snapshot lease namespace: ${file.path}`);
      }
      // NTFS folds trailing dots/spaces: '.live-1.' materializes as
      // '.live-1' and '.review.' as '.review' — a planted lease or a
      // hidden artifacts dir by another name. Reject folded collisions.
      if (LIVE_MARKER_RE.test(foldFsName(topSegment)) || foldFsName(topSegment) === '.review') {
        throw new Error(`Staged path folds onto reserved snapshot namespace: ${file.path}`);
      }
      const destination = path.resolve(targetDir, ...file.path.split('/'));
      const destinationKey = file.path.replace(/\\/g, '/').split('/').map(foldFsName).join('/').toLowerCase();
      if (seenDestinations.has(destinationKey)) {
        throw new Error(`Staged paths fold onto one on-disk name: ${file.path}`);
      }
      seenDestinations.add(destinationKey);
      const root = path.resolve(targetDir) + path.sep;
      if (!destination.startsWith(root)) {
        throw new Error(`Staged path escapes snapshot directory: ${file.path}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
      // Preserve the staged executable bit so test commands that exec
      // staged scripts behave like the real index (POSIX; no-op on Windows).
      if (file.mode === '100755') {
        await chmod(destination, 0o755).catch(() => {});
      }
    }
  }

  async #writeReviewArtifacts(targetDir, artifacts) {
    if (!artifacts || artifacts.artifacts === false || artifacts.diffBytes === undefined) {
      return;
    }
    const reviewDir = path.join(targetDir, '.review');
    // Purge any pre-existing .review content: when materializing into a
    // deterministic reuseDir, foreign artifacts (a planted report.md the
    // dispatcher would reproduce verbatim on agent-write failure) must not
    // survive alongside the artifacts we are about to write.
    await rm(reviewDir, { recursive: true, force: true });
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'diff.patch'), artifacts.diffBytes);
    // Deleted staged paths never reach materialize; control bytes in their
    // names must not reach the reviewer as raw text either — sanitize like
    // the prompt does (reuse compare sanitizes live paths the same way).
    const manifest = (artifacts.changedPaths ?? []).map((p) => sanitizePromptToken(p)).join('\n') + '\n';
    await writeFile(path.join(reviewDir, 'changed-files.txt'), manifest, 'utf8');
    if (Array.isArray(artifacts.fileClasses)) {
      // Paths sanitize identically to changed-files.txt: deleted staged
      // paths never pass assertSafeSnapshotPath and their raw bytes (bidi,
      // zero-width, C1) must not reach the reviewer-facing manifest.
      const rows = artifacts.fileClasses.map((entry) => ({
        path: sanitizePromptToken(entry.path),
        fileClass: entry.fileClass,
        sha256: entry.sha256 ?? null,
      }));
      await writeFile(
        path.join(reviewDir, 'file-classes.json'),
        JSON.stringify({ schema: 'file-classes@1', files: rows }, null, 2) + '\n',
        'utf8',
      );
    }
  }
}
