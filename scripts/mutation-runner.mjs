import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readdir, lstat, readFile, writeFile, readlink, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { terminateProcessTree } from '../src/infra/process-tree.mjs';

const reporter = new URL('./mutation-test-reporter.mjs', import.meta.url).href;
const DIRECTORIES_TO_COPY = ['src', 'scripts', 'agents', 'skills', 'tests', 'templates', '.omp-plugin', '.omp/review-kit', '.claude-plugin', 'claude-plugin', '.github', '.specs/native-task-review'];
const FILES_TO_COPY = ['package.json', 'README.md', 'AGENTS.md', 'ROADMAP.md', 'CHANGELOG.md'];
const exclusiveSuites = new Set(['execution-timeout', 'superseded-runs', 'run-signal-guard', 'review-run-records', 'omp-cli-reviewer-adapter', 'extension', 'run-tests-wrapper', 'claude-bridge', 'review-progress', 'target-heal', 'target-switches', 'status-latest-review', 'mutation-runner']);
const catalogCheck = (event) => /mutation manifest:|mutant anchors|curated mutant/i.test(event.name);
// Windows keeps transient handles on files that were just executed or written, so a plain removal fails with EBUSY.
// The removal keeps retrying while a handle holds the tree. A tree still held when the retries run out rejects the job as infrastructure_error, never as a killed mutant.
export const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
export const removeTree = (target) => rm(target, REMOVE_OPTIONS);
// Full-file runs (the baseline and the mutated reference) run a whole suite; the guard suites take minutes on Windows. Focused mutant runs keep the 120 s limit.
export const FULL_SUITE_TIMEOUT_MS = 30 * 60_000;
export const mutantIdentity = (mutant) => createHash('sha256').update(JSON.stringify([mutant.id, mutant.file, mutant.testFile, mutant.original, mutant.replacement])).digest('hex');
const assertionFailure = (event) => !event.suite && !event.skipped && !catalogCheck(event)
  && event.type === 'test:fail' && (event.causeCode === 'ERR_ASSERTION' || event.code === 'ERR_ASSERTION');

export async function runPool(jobs, count, execute) {
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('Workers must be an integer between 1 and 16');
  let parallel = [];
  const drain = async () => {
    let next = 0;
    let failure;
    await Promise.all(Array.from({ length: count }, async (_, worker) => {
      while (!failure && next < parallel.length) {
        try { await execute(parallel[next++], worker); } catch (error) { failure ??= error; }
      }
    }));
    parallel = [];
    if (failure) throw failure;
  };
  for (const job of jobs) {
    if (job.exclusive) {
      await drain();
      await execute(job, 0);
    } else parallel.push(job);
  }
  await drain();
}

export async function captureTree(root) {
  const entries = [];
  const walk = async (relative) => {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) entries.push({ path: relative, kind: 'link', target: await readlink(absolute), mode });
    else if (stat.isDirectory()) {
      if (relative) entries.push({ path: relative, kind: 'directory', mode });
      for (const name of (await readdir(absolute)).sort()) await walk(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push({ path: relative, kind: 'file', bytes: (await readFile(absolute)).toString('base64'), mode });
    else throw new Error(`Unsupported worker path: ${relative}`);
  };
  await walk('');
  return entries;
}

export async function restoreTree(root, baseline) {
  for (const entry of baseline) {
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) throw new Error('Invalid baseline path');
  }
  const current = await captureTree(root);
  const wanted = new Map(baseline.map((entry) => [entry.path, entry]));
  const actual = new Map(current.map((entry) => [entry.path, entry]));
  for (const entry of [...current].sort((a, b) => b.path.length - a.path.length)) {
    const target = wanted.get(entry.path);
    if (!target || target.kind !== entry.kind) {
      await removeTree(path.join(root, entry.path));
      for (const relative of actual.keys()) if (relative === entry.path || relative.startsWith(`${entry.path}/`)) actual.delete(relative);
    }
  }
  for (const entry of baseline) {
    const absolute = path.join(root, entry.path);
    const old = actual.get(entry.path);
    if (entry.kind === 'directory') await mkdir(absolute, { recursive: true });
    else if (entry.kind === 'file' && (old?.kind !== 'file' || old.bytes !== entry.bytes)) await writeFile(absolute, Buffer.from(entry.bytes, 'base64'));
    else if (entry.kind === 'link' && (old?.kind !== 'link' || old.target !== entry.target)) {
      await removeTree(absolute);
      await symlink(entry.target, absolute);
    }
    if (entry.kind !== 'link' && (old?.kind !== entry.kind || old?.mode !== entry.mode)) await chmod(absolute, entry.mode);
  }
  if (JSON.stringify(await captureTree(root)) !== JSON.stringify(baseline)) throw new Error('Worker reset did not restore pristine input');
}

export function classifyTestRun(run, expected = []) {
  if (run.timedOut) return 'timeout';
  if (run.error || run.signal || run.status === null) return 'infrastructure_error';
  const leaves = run.events.filter((event) => ['test:pass', 'test:fail'].includes(event.type) && !event.suite && !event.skipped);
  if (run.requireSummary) {
    const summary = run.events.filter((event) => event.type === 'test:summary').at(-1);
    if (!summary || summary.counts?.cancelled || summary.counts?.tests < leaves.length) return 'infrastructure_error';
  }
  if (!leaves.length || expected.some((name) => leaves.filter((event) => event.name === name).length !== 1)
    || (expected.length && leaves.some((event) => !expected.includes(event.name)))) return 'selector_invalid';
  const failures = leaves.filter((event) => event.type === 'test:fail');
  if (failures.some((event) => event.causeCode !== 'ERR_ASSERTION' && event.code !== 'ERR_ASSERTION')) return 'infrastructure_error';
  if (failures.length && run.status !== 0 && failures.every((event) => !expected.length || expected.includes(event.name))) return 'killed';
  if (run.status === 0 && !failures.length) return 'survived';
  return 'infrastructure_error';
}

export async function runTest(root, testFile, names = [], { timeoutMs = 120_000, signal, stateRoot, ancestors = [] } = {}) {
  const scratch = await mkdtemp(path.join(stateRoot ?? tmpdir(), 'rk-mutant-job-'));
  const env = { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    OMP_REVIEW_KIT_RUNS_DIR: path.join(scratch, 'runs'), OMP_REVIEW_KIT_TARGETS: path.join(scratch, 'targets.json'), OMP_REVIEW_KIT_REPORTS_DIR: path.join(scratch, 'reports') };
  delete env.NODE_TEST_CONTEXT;
  delete env.OMP_REVIEW_KIT_OFFLINE_SDK;
  delete env.OMP_REVIEW_KIT_LIVE_E2E;
  delete env.OMP_REVIEW_KIT_NATIVE_CLI;
  delete env.OMP_REVIEW_KIT_NATIVE_RUNTIME;
  delete env.OMP_REVIEW_KIT_NATIVE_KEEP;
  const localReporter = path.join(root, 'scripts', 'mutation-test-reporter.mjs');
  const reporterUrl = await lstat(localReporter).then(() => pathToFileURL(localReporter).href).catch(() => reporter);
  // Older native runners select all siblings when a describe ancestor matches.
  // Do not pretend that broad execution is a precise selector.
  const legacyNestedSelection = Number(process.versions.node.split('.')[0]) < 22 && ancestors.length > 0;
  if (legacyNestedSelection) {
    await removeTree(scratch);
    return { status: 1, events: [], error: 'Precise nested mutation selectors require Node 22 or newer', durationMs: 0 };
  }
  const patternNames = ancestors.length ? names.map((name) => [...ancestors, name].join(' ')) : names;
  const escaped = patternNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const argv = ['--test', `--test-reporter=${reporterUrl}`, ...(names.length ? [`--test-name-pattern=^(?:${escaped.join('|')})$`] : []), testFile];
  let closed = false;
  try {
    return await new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, argv, { cwd: root, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let error;
      let closeGuard;
      const stop = () => {
        if (timedOut || closed) return;
        timedOut = true;
        void terminateProcessTree(child).catch((failure) => { error = failure.message; });
        closeGuard ??= setTimeout(() => reject(Object.assign(new Error('Mutation child did not close after termination; worker must not be reused'), { unsafeWorker: true })), 10000);
      };
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { error = 'Reporter output limit exceeded'; stop(); } });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', (failure) => { error = failure.message; });
      child.once('close', (status, childSignal) => {
        closed = true;
        clearTimeout(timer);
        clearTimeout(closeGuard);
        signal?.removeEventListener('abort', stop);
        const events = [];
        for (const line of stdout.split('\n').filter(Boolean)) {
          try { events.push(JSON.parse(line)); } catch { error = 'Invalid test reporter output'; }
        }
        resolve({ status, signal: childSignal, timedOut, error, events, stderr, requireSummary: Number(process.versions.node.split('.')[0]) >= 22, durationMs: Date.now() - started });
      });
    });
  } finally {
    if (closed) await removeTree(scratch);
  }
}

export async function runMutationGate(mutants, { root = process.cwd(), workers = 4, calibrate = false, selectors = {}, log = console.log, signal, onResult = async () => {}, runTestImpl = runTest } = {}) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new Error('Workers must be an integer between 1 and 16');
  if (!mutants.length || new Set(mutants.map((mutant) => mutant.id)).size !== mutants.length) throw new Error('Empty catalog or duplicate mutant IDs');
  for (const mutant of mutants) {
    for (const relative of [mutant.file, mutant.testFile]) if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Mutant paths must stay inside the worker');
    if (!calibrate && (!selectors[mutant.id]?.tests?.length || selectors[mutant.id]?.mutantHash !== mutantIdentity(mutant))) throw new Error(`Missing or stale selector: ${mutant.id}; run --calibrate`);
  }
  const started = Date.now();
  const parentSignal = signal;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  signal = controller.signal;
  const base = await mkdtemp(path.join(tmpdir(), 'omp-mutation-pool-'));
  const copies = [];
  const results = [];
  const mappings = {};
  // One full-suite baseline per test file: concurrent workers share its promise instead of each running the whole suite.
  const baselineRuns = new Map();
  const focusedBaselines = new Map();
  let unsafeWorker = false;
  let active = 0;
  let maxActive = 0;
  let setupMs = 0;
  const timings = { testMs: 0, resetMs: 0 };
  const inspect = async (copy, file, names, ancestors = [], timeoutMs = undefined) => {
    const result = await runTestImpl(copy.dir, file, names, { signal, stateRoot: base, ancestors, ...(timeoutMs ? { timeoutMs } : {}) });
    timings.testMs += result.durationMs;
    return result;
  };
  const reset = async (copy) => {
    const start = Date.now();
    await restoreTree(copy.dir, copy.baseline);
    timings.resetMs += Date.now() - start;
  };
  try {
    for (let i = 0; i < workers; i++) {
      const dir = path.join(base, `worker-${i}`);
      await mkdir(dir);
      for (const name of [...DIRECTORIES_TO_COPY, ...FILES_TO_COPY]) await cp(path.join(root, name), path.join(dir, name), { recursive: true });
      // The OMP library is 800 MB and read-only for every worker: each worker links the project's node_modules instead of copying it.
      if (existsSync(path.join(root, 'node_modules'))) await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
      const baseline = await captureTree(dir);
      if (copies.length && JSON.stringify(baseline) !== JSON.stringify(copies[0].baseline)) throw new Error('Source changed while worker copies were being created');
      copies.push({ dir, baseline });
    }
    setupMs = Date.now() - started;
    const fingerprint = createHash('sha256').update(JSON.stringify(copies[0].baseline)).update(JSON.stringify(mutants)).update(process.version).update(process.platform).digest('hex');
    // Full-suite calibration discovers the deciding assertions. Ordinary runs use only the proven names.
    const jobs = mutants.map((mutant) => ({ ...mutant, exclusive: exclusiveSuites.has(path.basename(mutant.testFile, '.test.mjs')) }));
    // Group exclusive suites to avoid repeatedly draining a busy parallel lane.
    jobs.sort((a, b) => Number(a.exclusive) - Number(b.exclusive));
    await runPool(jobs, workers, async (mutant, worker) => {
      if (signal?.aborted) throw new Error('Mutation gate interrupted');
      const copy = copies[worker];
      const jobStart = Date.now();
      active++;
      maxActive = Math.max(maxActive, active);
      if (mutant.exclusive && active !== 1) throw new Error('Exclusive mutation overlapped another job');
      let outcome = 'infrastructure_error';
      let names = selectors[mutant.id]?.tests;
      let ancestors = selectors[mutant.id]?.ancestors ?? [];
      let detail;
      try {
        await reset(copy);
        const file = path.join(copy.dir, mutant.file);
        const original = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
        const anchor = mutant.original.replace(/\r\n/g, '\n');
        if (original.split(anchor).length !== 2) throw new Error('Mutation target must match exactly once');
        const mutated = original.replace(anchor, mutant.replacement.replace(/\r\n/g, '\n'));
        // A recorded selector (--calibrate-stale passes it as a hint) is re-proved first: if the recorded names still
        // decide, the focused proof below verifies the kill without a full-suite reference run. When they no longer
        // decide, the reference locates the deciding assertions and the same proof verifies them.
        let provingHint = Boolean(calibrate && names?.length);
        for (;;) {
          if (calibrate && !provingHint) {
            await reset(copy);
            if (!baselineRuns.has(mutant.testFile)) {
              baselineRuns.set(mutant.testFile, inspect(copy, mutant.testFile, [], [], FULL_SUITE_TIMEOUT_MS).then((baseline) => {
                if (classifyTestRun(baseline) !== 'survived') throw new Error(`Full-suite baseline is not green: ${baseline.stderr || JSON.stringify(baseline.events.filter((event) => event.type === 'test:fail')).slice(0, 2000)}`);
              }));
            }
            await baselineRuns.get(mutant.testFile);
            await reset(copy);
            await writeFile(file, mutated);
            const reference = await inspect(copy, mutant.testFile, [], [], FULL_SUITE_TIMEOUT_MS);
            if (reference.timedOut || reference.error || reference.signal || reference.status === null) {
              outcome = classifyTestRun(reference);
              detail = reference.stderr;
              return;
            }
            // A reference suite may contain secondary failures caused by the mutant.
            // Only deciding assertions become selectors; infrastructure failures never prove a kill.
            const deciding = reference.events.filter(assertionFailure).sort((a, b) => a.durationMs - b.durationMs || a.name.localeCompare(b.name))[0];
            names = deciding ? [deciding.name] : [];
            ancestors = deciding?.ancestors ?? [];
            if (!names.length) {
              outcome = 'infrastructure_error';
              detail = reference.stderr || JSON.stringify(reference.events.filter((event) => event.type === 'test:fail')).slice(0, 2000);
              return;
            }
          }
          if (!Array.isArray(names) || !names.length || (!calibrate && (selectors[mutant.id]?.testFile !== mutant.testFile || selectors[mutant.id]?.mutantHash !== mutantIdentity(mutant)))) { outcome = 'selector_invalid'; return; }
          await reset(copy);
          const testHash = createHash('sha256').update((await readFile(path.join(copy.dir, mutant.testFile), 'utf8')).replace(/\r\n/g, '\n')).digest('hex');
          if (!calibrate && selectors[mutant.id]?.testHash !== testHash) { outcome = 'selector_invalid'; detail = 'Deciding test changed; recalibration required'; return; }
          const baselineKey = JSON.stringify([mutant.testFile, names, ancestors]);
          if (!focusedBaselines.has(baselineKey)) {
            const baseline = await inspect(copy, mutant.testFile, names, ancestors);
            if (classifyTestRun(baseline, names) !== 'survived') {
              outcome = 'selector_invalid';
              detail = baseline.stderr;
              if (provingHint) { provingHint = false; continue; }
              return;
            }
            const selected = baseline.events.filter((event) => event.type === 'test:pass' && !event.suite && !event.skipped);
            if (!ancestors.length && selected.length === 1 && selected[0].ancestors?.length) {
              ancestors = selected[0].ancestors;
              const precise = await inspect(copy, mutant.testFile, names, ancestors);
              if (classifyTestRun(precise, names) !== 'survived') {
                outcome = 'selector_invalid';
                if (provingHint) { provingHint = false; continue; }
                return;
              }
            }
            focusedBaselines.set(baselineKey, ancestors);
          } else ancestors = focusedBaselines.get(baselineKey);
          await reset(copy);
          await writeFile(file, mutated);
          const focused = await inspect(copy, mutant.testFile, names, ancestors);
          outcome = classifyTestRun(focused, names);
          detail = outcome === 'killed' ? undefined : focused.stderr || JSON.stringify(focused.events.filter((event) => event.type === 'test:fail')).slice(0, 2000);
          if (outcome === 'killed') mappings[mutant.id] = { testFile: mutant.testFile, tests: names, ancestors, mutantHash: mutantIdentity(mutant), testHash };
          if (provingHint && outcome !== 'killed') { provingHint = false; continue; }
          break;
        }
      } catch (error) {
        if (error.unsafeWorker) { unsafeWorker = true; controller.abort(); throw error; }
        detail = error.message;
      } finally {
        if (!unsafeWorker) await reset(copy);
        const result = { id: mutant.id, outcome, worker, exclusive: mutant.exclusive, tests: names, durationMs: Date.now() - jobStart, ...(detail ? { detail } : {}) };
        results.push(result);
        active--;
        await onResult(result, mappings[mutant.id], fingerprint);
        log(`[${outcome.toUpperCase()}] ${mutant.id} (${results.length}/${mutants.length})${detail ? ` ${detail}` : ''}`);
      }
    });
    if (results.length !== mutants.length || new Set(results.map((result) => result.id)).size !== mutants.length) throw new Error('Incomplete mutation catalog execution');
    return { fingerprint, runtime: process.version, platform: process.platform, workers, maxActive, setupMs, timings, calibrated: calibrate, mappings, results, durationMs: Date.now() - started,
      passed: results.every((result) => result.outcome === 'killed') };
  } finally {
    parentSignal?.removeEventListener('abort', forwardAbort);
    if (!unsafeWorker) await removeTree(base);
  }
}

export const testFileHash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/**
 * Mutants whose recorded selector no longer fits: no mapping, another test file, a changed mutant, or a test file whose bytes changed.
 * Only these need `--calibrate-stale`; every other selector is proven again by each ordinary gate run.
 */
export async function findStaleMutants(mutants, mappings, root = process.cwd()) {
  const hashes = new Map();
  const hashOf = async (testFile) => {
    if (!hashes.has(testFile)) hashes.set(testFile, testFileHash(await readFile(path.join(root, testFile), 'utf8')));
    return hashes.get(testFile);
  };
  const stale = [];
  for (const mutant of mutants) {
    const mapping = mappings[mutant.id];
    if (!mapping?.tests?.length || mapping.testFile !== mutant.testFile || mapping.mutantHash !== mutantIdentity(mutant) || mapping.testHash !== await hashOf(mutant.testFile)) stale.push(mutant);
  }
  return stale;
}

/**
 * Fresh calibration wins and existing entries keep their order; new mutants follow in catalog order; selectors of mutants
 * that left the catalog are dropped. A mutant without any selector is an error,
 * unless the calibration is partial: then the proven selectors are kept so that the next run only repeats the failed mutants.
 */
export function mergeCalibration(mutants, previous, fresh, { complete = true } = {}) {
  const known = new Set(mutants.map((mutant) => mutant.id));
  const merged = {};
  // Entries keep their place, so recalibrating a few mutants rewrites a few lines of the catalog, not all of it.
  for (const id of Object.keys(previous)) if (known.has(id)) merged[id] = fresh[id] ?? previous[id];
  for (const mutant of mutants) {
    if (mutant.id in merged) continue;
    if (!fresh[mutant.id]) {
      if (complete) throw new Error(`No selector for ${mutant.id} after calibration`);
      continue;
    }
    merged[mutant.id] = fresh[mutant.id];
  }
  return merged;
}

// Command line of the mutation gate. The exit code is always a verdict about the whole catalog: 0 only when every curated mutant is
// killed by a deciding assertion, 1 otherwise. `--calibrate-stale` first recalibrates the stale selectors (a survivor there ends the run
// with 1 and keeps the selectors it proved) and then runs the ordinary gate over every mutant, so no invocation exits 0 on a subset or on nothing.
export async function runCli({ mutants, argv = process.argv.slice(2), env = process.env, cwd = process.cwd(),
  selectorPath = new URL('./mutation-selectors.json', import.meta.url), gate = runMutationGate, log = console.log, writeFileImpl = writeFile } = {}) {
  const staleOnly = argv.includes('--calibrate-stale');
  const calibrate = argv.includes('--calibrate');
  const workers = Number(env.OMP_MUTATION_WORKERS ?? 4);
  const resultPath = env.OMP_MUTATION_RESULT ?? path.join(cwd, 'audit-reports', 'mutation-result.json');
  // Workers prove selectors concurrently and each proof rewrites the whole catalog. Writes are queued in call order,
  // so two snapshots never overlap in the file; a failed write does not block the writes after it.
  let catalogWrites = Promise.resolve();
  const writeCatalog = (mappings) => {
    const write = catalogWrites.then(() => writeFileImpl(selectorPath, JSON.stringify({ schema: 'mutation-selectors@1', mappings }, null, 2) + '\n'));
    catalogWrites = write.catch(() => {});
    return write;
  };
  let selectors = {};
  let stale = [];
  let previous = {};
  if (staleOnly) {
    // Maintenance after a catalog or test edit: calibrate only the mutants whose selector no longer fits, keep the rest.
    const catalog = JSON.parse(await readFile(selectorPath, 'utf8'));
    if (catalog.schema !== 'mutation-selectors@1' || !catalog.mappings) throw new Error('Unreadable selector catalog; run --calibrate');
    previous = catalog.mappings;
    stale = await findStaleMutants(mutants, previous, cwd);
    log(`Selector catalog: ${stale.length} of ${mutants.length} mutants need calibration.`);
  } else if (!calibrate) {
    const catalog = JSON.parse(await readFile(selectorPath, 'utf8'));
    if (catalog.schema !== 'mutation-selectors@1' || !catalog.mappings || Object.keys(catalog.mappings).length !== mutants.length) throw new Error('Incomplete selector catalog; run --calibrate');
    selectors = catalog.mappings;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const prove = async (targets, options, mode, subset, onProven) => {
      log(`Starting safety mutation gate: ${targets.length} curated mutants, ${workers} workers, ${mode}...`);
      await writeFile(`${resultPath}.jsonl`, '');
      const result = await gate(targets, { workers, signal: controller.signal, ...options,
        onResult: async (record, mapping, fingerprint) => {
          await appendFile(`${resultPath}.jsonl`, JSON.stringify({ ...record, mapping, fingerprint }) + '\n');
          if (onProven && record.outcome === 'killed' && mapping) await onProven(record.id, mapping);
        } });
      await writeFile(resultPath, JSON.stringify(subset ? { ...result, subset: { mutants: targets.length, catalog: mutants.length } } : result, null, 2) + '\n');
      return result;
    };
    if (staleOnly) {
      if (stale.length) {
        // Every selector the calibration proves is written to the catalog right away: a run that dies halfway keeps the work it proved.
        const provenSelectors = { ...previous };
        // A recorded selector is a hint: when the recorded names still decide after the test file changed, the
        // calibration verifies them with focused runs instead of a full-suite reference.
        const hints = Object.fromEntries(stale.map((mutant) => [mutant.id, previous[mutant.id]]).filter(([, mapping]) => mapping));
        const calibrated = await prove(stale, { calibrate: true, selectors: hints }, 'stale-selector calibration', true, async (id, mapping) => {
          provenSelectors[id] = mapping;
          await writeCatalog(mergeCalibration(mutants, previous, provenSelectors, { complete: false }));
        });
        selectors = mergeCalibration(mutants, previous, calibrated.mappings, { complete: calibrated.passed });
        await writeCatalog(selectors);
        const proven = calibrated.results.filter((item) => item.outcome === 'killed').length;
        log(`Stale-selector calibration ${calibrated.passed ? 'finished' : 'FAILED'}: ${proven}/${stale.length} stale mutants killed; ${calibrated.durationMs}ms.`);
        if (!calibrated.passed) return 1;
      } else {
        selectors = mergeCalibration(mutants, previous, {});
        await writeCatalog(selectors);
        log('Selector catalog is current: no selector needed calibration.');
      }
      log('Proving every selector now: the exit code of --calibrate-stale is the verdict of the full gate.');
    }
    const result = await prove(mutants, { calibrate, selectors }, calibrate ? 'full/focused calibration' : 'verified focused selectors', false);
    if (calibrate && result.passed) await writeCatalog(result.mappings);
    const killed = result.results.filter((item) => item.outcome === 'killed').length;
    log(`Mutation gate result: ${killed}/${mutants.length} killed; ${result.durationMs}ms.`);
    log(result.passed ? 'Mutation gate PASSED: 100% of curated safety mutants killed.' : 'Mutation gate FAILED: unresolved mutation evidence.');
    return result.passed ? 0 : 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}


// What the script entry does with the command line: a Node too old for precise selectors or any failure exits non-zero.
export async function runAsScript({ mutants, nodeVersion = process.versions.node, run = runCli, setExitCode = (code) => { process.exitCode = code; }, report = console.error }) {
  try {
    if (Number(nodeVersion.split('.')[0]) < 22) throw new Error('Precise mutation gate requires Node 22 or newer; runtime plugin still supports Node 18');
    setExitCode(await run({ mutants }));
  } catch (error) {
    report('Fatal mutation gate error:', error.message);
    setExitCode(1);
  }
}
