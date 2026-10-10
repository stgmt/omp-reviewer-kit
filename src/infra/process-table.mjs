import { spawnSync } from 'node:child_process';

const TABLE_TIMEOUT_MS = 60_000;
const TABLE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * One line per process: id, parent id, creation time in round-trip format, and
 * the command line last, because a command line may itself contain '|'.
 */
const CIM_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2:o}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate, $_.CommandLine }",
].join(' ');

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/**
 * Epoch milliseconds of a timestamp, or null. A fraction longer than three
 * digits (PowerShell prints seven) is truncated so that every Node version agrees.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseTimestamp(text) {
  const normalized = String(text).trim().replace(/(\.\d{3})\d+/, '$1');
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parses `ps -A -o pid=,ppid=,lstart=,args=` output (LC_ALL=C). Lines that do
 * not fit the format are dropped.
 *
 * @param {string} text
 * @returns {Array<{ pid: number, ppid: number, startedAt: number|null, commandLine: string }>}
 */
export function parsePsOutput(text) {
  const processes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: parseTimestamp(match[3]),
      commandLine: match[4],
    });
  }
  return processes;
}

/**
 * Parses the PowerShell/CIM listing: `pid|ppid|creation|commandLine`. Only the
 * first three '|' separate fields; the rest of the line is the command line.
 *
 * @param {string} text
 * @returns {Array<{ pid: number, ppid: number, startedAt: number|null, commandLine: string }>}
 */
export function parseCimOutput(text) {
  const processes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const first = line.indexOf('|');
    const second = first < 0 ? -1 : line.indexOf('|', first + 1);
    const third = second < 0 ? -1 : line.indexOf('|', second + 1);
    if (third < 0) continue;
    const pid = Number(line.slice(0, first));
    const ppid = Number(line.slice(first + 1, second));
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || line.slice(0, first).trim() === '') continue;
    processes.push({
      pid,
      ppid,
      startedAt: parseTimestamp(line.slice(second + 1, third)),
      commandLine: line.slice(third + 1),
    });
  }
  return processes;
}

/**
 * Snapshot of the process table. The platform and the spawner are injectable so that both
 * listings can be exercised on any host; callers pass nothing.
 *
 * @param {{ platform?: string, run?: typeof spawnSync }} [options]
 * @returns {Array<{ pid: number, ppid: number, startedAt: number|null, commandLine: string }>|null}
 *   null when the table cannot be read; callers must then treat every process as unverified
 */
export function listProcesses({ platform = process.platform, run = spawnSync } = {}) {
  try {
    if (platform === 'win32') {
      const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CIM_SCRIPT], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: TABLE_TIMEOUT_MS,
        maxBuffer: TABLE_MAX_BUFFER,
      });
      if (result.error || result.status !== 0) return null;
      const processes = parseCimOutput(result.stdout);
      return processes.length > 0 ? processes : null;
    }
    const result = run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: TABLE_TIMEOUT_MS,
      maxBuffer: TABLE_MAX_BUFFER,
    });
    if (result.error || result.status !== 0) return null;
    const processes = parsePsOutput(result.stdout);
    return processes.length > 0 ? processes : null;
  } catch {
    return null;
  }
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `pid` and every process above it, as far as the table shows. */
function ancestorsOf(pid, table) {
  const parentOf = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  const ancestors = new Set();
  let current = pid;
  while (parentOf.has(current) && !ancestors.has(current)) {
    ancestors.add(current);
    current = parentOf.get(current);
  }
  ancestors.add(current);
  return ancestors;
}

/** Descendants of `root` ordered children before parents. */
function descendantsOf(root, table) {
  const children = new Map();
  for (const entry of table) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry.pid);
  }
  const ordered = [];
  const seen = new Set([root]);
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      ordered.push(child);
    }
  };
  walk(root);
  return ordered;
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a process and everything it started. Never signals this process or one
 * of its ancestors; a root that is one of them is refused.
 *
 * Windows uses `taskkill /T /F`. Elsewhere the descendants get SIGTERM first
 * (children before parents), then the root, and whatever is still alive after
 * `graceMs` gets SIGKILL. The platform, the spawner, the signal sender and the
 * liveness probe are parameters, so both branches can be exercised on any host.
 *
 * @param {number} pid
 * @param {{
 *   table?: Array<{ pid: number, ppid: number }>|null,
 *   graceMs?: number,
 *   platform?: string,
 *   run?: typeof spawnSync,
 *   send?: (pid: number, signal: string) => boolean,
 *   gone?: (pid: number) => boolean,
 * }} [options]
 * @returns {Promise<{ signalled: number[], refused: boolean }>}
 */
export async function terminateTree(pid, {
  table = null,
  graceMs = 2000,
  platform = process.platform,
  run = spawnSync,
  send = signal,
  gone = isGone,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { signalled: [], refused: true };
  const protectedPids = new Set([process.pid, process.ppid]);
  if (Array.isArray(table)) for (const ancestor of ancestorsOf(process.pid, table)) protectedPids.add(ancestor);
  if (protectedPids.has(pid)) return { signalled: [], refused: true };

  if (platform === 'win32') {
    const result = run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return { signalled: result.status === 0 ? [pid] : [], refused: false };
  }

  const victims = [...(Array.isArray(table) ? descendantsOf(pid, table) : []), pid]
    .filter((candidate) => !protectedPids.has(candidate));
  const signalled = victims.filter((candidate) => send(candidate, 'SIGTERM'));
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline && !victims.every((candidate) => gone(candidate))) await sleep(50);
  for (const candidate of victims) {
    if (!gone(candidate)) send(candidate, 'SIGKILL');
  }
  return { signalled, refused: false };
}
