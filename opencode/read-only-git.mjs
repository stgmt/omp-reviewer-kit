import { spawn } from 'node:child_process';
import { z } from 'zod';

const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const MAX_REVISION_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;
const NULL_CONFIG_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

const revisionSchema = z.string()
  .min(1)
  .max(MAX_REVISION_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:(?:~|\^)[0-9]*)*$/, 'Use a ref, object id, or simple commit ancestry expression.')
  .refine(value => {
    const ref = value.split(/[~^]/, 1)[0];
    return !ref.includes('..') && ref.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
  }, {
    message: 'Revision ref segments cannot be empty, dot, or parent segments.',
  });

function isSafeRepoPath(value) {
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

const repoPathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine(isSafeRepoPath, {
  message: 'Path must be a repository-relative path without empty, dot, or parent segments.',
});
const argsShape = {
  operation: z.enum(['status', 'diff_staged', 'show_staged', 'log', 'show', 'diff_range', 'show_file']),
  revision: revisionSchema.optional(),
  base: revisionSchema.optional(),
  head: revisionSchema.optional(),
  path: repoPathSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  names_only: z.boolean().optional(),
};


const argsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('diff_staged'), path: repoPathSchema.optional(), names_only: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('show_staged'), path: repoPathSchema }).strict(),
  z.object({
    operation: z.literal('log'),
    revision: revisionSchema.optional(),
    path: repoPathSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({ operation: z.literal('show'), revision: revisionSchema }).strict(),
  z.object({
    operation: z.literal('diff_range'),
    base: revisionSchema,
    head: revisionSchema,
    path: repoPathSchema.optional(),
    names_only: z.boolean().optional(),
  }).strict(),
  z.object({ operation: z.literal('show_file'), revision: revisionSchema, path: repoPathSchema }).strict(),
]);

const BASE_GIT_ARGS = [
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'pager.diff=false',
  '-c', 'diff.external=',
  '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0',
  '-c', 'color.ui=false',
];

function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_CONFIG_PATH,
    GIT_CONFIG_COUNT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

function commandError(message, cause) {
  const error = new Error(message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function runGit(args, directory, signal, deps) {
  if (signal?.aborted) return Promise.reject(commandError('Git operation aborted.'));

  const gitArgs = [...BASE_GIT_ARGS, ...args];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = deps.spawnImpl('git', gitArgs, {
        cwd: directory,
        env: gitEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(commandError(`Unable to start Git: ${error.message}`, error));
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedStderrBytes = 0;
    let failure = null;
    let settled = false;
    let killTimer = null;
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      failure = commandError(`Git operation timed out after ${deps.timeoutMs} ms.`);
      stopChild();
    }, deps.timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    function stopChild() {
      if (!child.killed) {
        try {
          child.kill();
        } catch {
          // The close event or timeout will still settle the operation.
        }
      }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The process may have exited between the two termination attempts.
          }
        }, 500);
        killTimer.unref?.();
      }
    }
    function onAbort() {
      if (failure === null) failure = commandError('Git operation aborted.');
      stopChild();
    }

    if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => {
      finish(reject, commandError(`Unable to start Git: ${error.message}`, error));
    });
    child.stdout.on('data', chunk => {
      if (settled || failure !== null) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        failure = commandError(`Git output exceeded ${MAX_OUTPUT_BYTES} bytes.`);
        stopChild();
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on('data', chunk => {
      if (settled || failure !== null) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        failure = commandError(`Git output exceeded ${MAX_OUTPUT_BYTES} bytes.`);
        stopChild();
        return;
      }
      const retainedBytes = Math.min(buffer.length, MAX_ERROR_BYTES - capturedStderrBytes);
      if (retainedBytes > 0) {
        stderr.push(buffer.subarray(0, retainedBytes));
        capturedStderrBytes += retainedBytes;
      }
    });
    child.on('close', (code, exitSignal) => {
      if (failure !== null) {
        finish(reject, failure);
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(reject, commandError(detail || `Git command failed with ${exitSignal ?? `exit code ${code}`}.`));
        return;
      }
      finish(resolve, Buffer.concat(stdout).toString('utf8'));
    });

    if (signal?.aborted) onAbort();
  });
}

function asLiteralPathspec(path) {
  return `:(literal)${path}`;
}

async function resolveCommit(revision, directory, signal, deps) {
  const result = await runGit(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], directory, signal, deps);
  const oid = result.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) {
    throw commandError('Git did not resolve the revision to a commit object.');
  }
  return oid;
}

function optionalPathArgs(path) {
  return path === undefined ? [] : ['--', asLiteralPathspec(path)];
}

function gitDiffSafetyArgs() {
  return ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
}

async function executeOperation(args, directory, signal, deps) {
  switch (args.operation) {
    case 'status':
      return runGit(['status', '--short', '--branch', '--untracked-files=normal', '--no-renames'], directory, signal, deps);
    case 'diff_staged':
      return runGit(['diff', '--cached', ...gitDiffSafetyArgs(), ...(args.names_only ? ['--name-only'] : []), ...optionalPathArgs(args.path)], directory, signal, deps);
    case 'show_staged':
      return runGit(['cat-file', 'blob', `:${args.path}`], directory, signal, deps);
    case 'log': {
      const revision = await resolveCommit(args.revision ?? 'HEAD', directory, signal, deps);
      const limit = args.limit ?? 20;
      return runGit([
        'log', '--no-show-signature', '--no-decorate', `--max-count=${limit}`,
        '--format=%H%x09%an%x09%aI%x09%s', revision, ...optionalPathArgs(args.path),
      ], directory, signal, deps);
    }
    case 'show': {
      const revision = await resolveCommit(args.revision, directory, signal, deps);
      return runGit(['show', ...gitDiffSafetyArgs(), '--no-show-signature', '--format=fuller', revision], directory, signal, deps);
    }
    case 'diff_range': {
      const [base, head] = await Promise.all([
        resolveCommit(args.base, directory, signal, deps),
        resolveCommit(args.head, directory, signal, deps),
      ]);
      return runGit(['diff', ...gitDiffSafetyArgs(), ...(args.names_only ? ['--name-only'] : []), base, head, ...optionalPathArgs(args.path)], directory, signal, deps);
    }
    case 'show_file': {
      const revision = await resolveCommit(args.revision, directory, signal, deps);
      return runGit(['cat-file', 'blob', `${revision}:${args.path}`], directory, signal, deps);
    }
    default:
      throw commandError('Unsupported Git operation.');
  }
}

/**
 * The read-only Git tool. The process seam exists so a test can prove the timeout bounds a Git child
 * that never answers; the OpenCode host always uses the real `spawn` and the 10-second budget.
 *
 * @param {{ spawnImpl?: typeof spawn, timeoutMs?: number }} [overrides]
 */
export function createReadOnlyGitTool({ spawnImpl = spawn, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const deps = { spawnImpl, timeoutMs };
  return {
    description: 'Read-only Git inspection for the current OpenCode directory: status, staged patch/blob, commit log/show, commit-range diff, or file contents from a commit. diff_staged exposes the staged patch; show_staged reads the exact index blob; show_file reads the committed tree. None reads the working tree as staged source. Use names_only on staged/range diffs to enumerate paths when patch output is too large; oversized output fails explicitly and is never silently truncated. Output is capped at 128 KiB and each Git process at 10 seconds; log limits are 1–100 commits (20 by default). Paths stay repository-relative and revisions resolve to commits.',
    args: argsShape,
    async execute(input, context = {}) {
      const parsed = argsSchema.safeParse(input);
      if (!parsed.success) {
        throw commandError('Invalid review_git arguments. Use the operation-specific schema.');
      }
      const directory = context?.directory;
      if (typeof directory !== 'string' || directory.length === 0) {
        throw commandError('OpenCode did not provide a repository directory.');
      }
      const signal = context?.abort ?? context?.signal;
      try {
        return await executeOperation(parsed.data, directory, signal, deps);
      } catch (error) {
        if (signal?.aborted && error?.message !== 'Git operation aborted.') {
          throw commandError('Git operation aborted.', error);
        }
        throw error;
      }
    },
  };
}
