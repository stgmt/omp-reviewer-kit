// The commit guard every host calls. It reads the host's tool payload on stdin, decides whether the
// command is a `git commit`, runs the same review launcher the vendored pre-commit hook runs, and
// answers in that host's own deny contract.
//
//   node scripts/hook-guard.mjs           # payload on stdin, JSON answer on stdout
//
// A payload shape the guard cannot read is an allow: the guard exists to add a review, never to break
// a host whose payload changed. The one thing it never does is let a staged commit through without a
// review once it has recognised the command.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitCommitCommand } from '../src/domain/git-commit-command.mjs';
import { isMainModule } from '../src/infra/main-module.mjs';

/** How deep the guard follows command substitutions before it refuses to call the command safe. */
const MAX_SUBSTITUTION_DEPTH = 8;

/** The commands a host may send; the field holding the command differs per host. */
const COMMAND_FIELDS = ['command', 'cmd', 'shell_command', 'bash_command'];

/**
 * The command a tool payload carries, or null.
 *
 * @param {object} payload
 * @returns {string|null}
 */
export function commandOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.args ?? payload,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const field of COMMAND_FIELDS) {
      const value = candidate[field];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return null;
}

/**
 * True for a command that commits. The rule matches the vendored hook: the segment that runs
 * `git commit` decides, and `--help`, `--dry-run` and a bare `git commit --amend` without a hook
 * bypass are still commits.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isCommitCommand(command, depth = 0) {
  const text = String(command ?? '');
  // The guard is the last line of defence — Git's own hook can be skipped with \`--no-verify\` — so it
  // is deliberately a superset: any text that could run \`git … commit\` is reviewed, including
  // subshells, process substitution and nested substitutions. Only text the shell prints literally is
  // ignored (comments, single-quoted spans, and double-quoted text that carries no substitution), and
  // a command that only asks for help is skipped.
  const masked = maskLiterals(text);
  const inner = substitutions(masked);
  const direct = maskQuotedLiterals(masked);
  const segments = direct.split(/&&|&|\|\||;|\||\r?\n/);
  for (const segment of segments) {
    const trimmed = segment.trim().replace(/^[\s(]+/, '').replace(/[\s)]+$/, '');
    if (trimmed === '') continue;
    if (!hasGitCommit(trimmed)) continue;
    if (asksForHelp(trimmed)) continue;
    return true;
  }
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    // Past the traversal bound the guard cannot analyse further: a command that still mentions a
    // commit anywhere is refused rather than called safe.
    return inner.length > 0 && hasGitCommit(masked);
  }
  return inner.some(nested => isCommitCommand(nested, depth + 1));
}

/** True when the text can run a `git … commit` invocation. */
function hasGitCommit(text) {
  return /\bgit(?:\.exe)?\b[\s\S]*?\bcommit\b/i.test(String(text ?? ''));
}

/**
 * The command with double-quoted text blanked, except for the substitutions it carries: Bash expands
 * those, so \`echo "$(git commit)"\` commits while \`echo "git commit"\` only prints.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskQuotedLiterals(text) {
  const source = String(text ?? '');
  const BACKTICK = String.fromCharCode(96);
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '"') { out += source[index]; index += 1; continue; }
    let cursor = index + 1;
    let kept = '';
    while (cursor < source.length && source[cursor] !== '"') {
      if (source[cursor] === '\\') { cursor += 2; continue; }
      if (source[cursor] === '$' && source[cursor + 1] === '(') {
        const close = closingParenFor(source, cursor + 2);
        kept += source.slice(cursor, close + 1);
        cursor = close + 1;
        continue;
      }
      if (source[cursor] === BACKTICK) {
        const close = source.indexOf(BACKTICK, cursor + 1);
        const end = close === -1 ? source.length : close + 1;
        kept += source.slice(cursor, end);
        cursor = end;
        continue;
      }
      cursor += 1;
    }
    out += kept;
    index = cursor + 1;
  }
  return out;
}

/** The index of the `)` matching a `$(` whose content starts at `from`. */
function closingParenFor(source, from) {
  let depth = 1;
  let index = from;
  while (index < source.length && depth > 0) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    index += 1;
  }
  return Math.max(from, index - 1);
}

/**
 * The command with shell comments and single-quoted spans blanked out: Bash prints those literally, so
 * a commit written inside them never runs.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskLiterals(text) {
  const source = String(text ?? '');
  let out = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" ) {
      const close = source.indexOf("'", index + 1);
      const end = close === -1 ? source.length : close + 1;
      out += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(source[index - 1]))) {
      const newline = source.indexOf('\n', index);
      const end = newline === -1 ? source.length : newline;
      out += ' '.repeat(end - index);
      index = end;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * The texts inside `$(…)` and backticks, outermost first.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function substitutions(text) {
  const found = [];
  const source = String(text ?? '');
  const BACKTICK = String.fromCharCode(96);
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      // Inside single quotes the shell expands nothing: `'$(git commit)'` is a literal string.
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') { index += 1; continue; }
      if (character === '"') { quote = null; continue; }
      if (character === '$' && source[index + 1] === '(') {
        const close = closingParen(source, index + 2);
        found.push(source.slice(index + 2, close));
        index = close;
        continue;
      }
      if (character === BACKTICK) {
        const close = source.indexOf(BACKTICK, index + 1);
        if (close === -1) break;
        found.push(source.slice(index + 1, close));
        index = close;
      }
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '$' && source[index + 1] === '(') {
      const close = closingParen(source, index + 2);
      found.push(source.slice(index + 2, close));
      index = close;
      continue;
    }
    if (character === BACKTICK) {
      const close = source.indexOf(BACKTICK, index + 1);
      if (close === -1) break;
      found.push(source.slice(index + 1, close));
      index = close;
    }
  }
  return found;
}

/** The index of the `)` matching a `$(` whose content starts at `from`. */
function closingParen(source, from) {
  let depth = 1;
  let index = from;
  while (index < source.length && depth > 0) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    index += 1;
  }
  return Math.max(from, index - 1);
}

/**
 * The command without a trailing shell comment. Bash executes `git commit -m x # --help` as a commit;
 * the comment is text, and a guard that reads it as a request skips the review.
 *
 * @param {string} segment
 * @returns {string}
 */
export function stripShellComment(segment) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < String(segment ?? '').length; index += 1) {
    const character = segment[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (character === '\\') { escaped = true; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#' && (index === 0 || /\s/.test(segment[index - 1]))) return segment.slice(0, index);
  }
  return String(segment ?? '');
}

/**
 * True when `--help` or `-h` is a bare token of the command. Quoted text is one token, so a message
 * that mentions the flag is not a help request.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function asksForHelp(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const character of String(segment ?? '')) {
    if (escaped) { escaped = false; current += character; continue; }
    if (quote) {
      if (character === '\\') { escaped = true; current += character; continue; }
      if (character === quote) { quote = null; continue; }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) { if (current) { tokens.push(current); current = ''; } continue; }
    current += character;
  }
  if (current) tokens.push(current);
  // Everything after \`--\` is a pathspec, not an option: \`git commit -- -h\` commits a file named \`-h\`.
  const stop = tokens.indexOf('--');
  const options = stop === -1 ? tokens : tokens.slice(0, stop);
  return options.includes('--help') || options.includes('-h');
}

/**
 * What the guard answers. `block` carries the reason a host shows; `allow` carries nothing.
 *
 * @param {{ command: string|null, review: () => { status: number|null, stdout?: string, stderr?: string } }} input
 * @returns {{ decision: 'allow'|'block', reason: string, remark: string }}
 */
export function decideGuard({ command, review }) {
  if (!command || !isCommitCommand(command)) return { decision: 'allow', reason: '', remark: 'not a commit command' };
  const result = review();
  if (result.status === 0) return { decision: 'allow', reason: '', remark: 'review passed' };
  const detail = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim();
  return {
    decision: 'block',
    reason: `The review blocked this commit (exit ${result.status ?? 'unknown'}). Fix the findings, or re-run the review yourself.${detail ? `\n${detail.slice(0, 4000)}` : ''}`,
    remark: 'review blocked the commit',
  };
}

/**
 * The host-specific answer for a decision.
 *
 * @param {'codex'|'opencode'} host
 * @param {{ decision: 'allow'|'block', reason: string }} decision
 * @returns {object}
 */
export function denyContract(host, decision) {
  if (decision.decision !== 'block') return {};
  if (host === 'codex') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  }
  return { deny: true, reason: decision.reason };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.stdout.write('{}\n');
    return 0;
  }
  const host = process.argv.includes('--codex') ? 'codex' : 'opencode';
  // A decoded filesystem path: an install under a directory with a space must still find the launcher.
  const kitRoot = process.env.OMP_REVIEW_KIT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const command = commandOf(payload);
  const decision = decideGuard({
    command,
    review: () => spawnSync(process.execPath, [path.join(kitRoot, 'scripts', 'run-review.mjs')], { encoding: 'utf8', windowsHide: true }),
  });
  process.stderr.write(`guard: ${decision.remark}\n`);
  process.stdout.write(`${JSON.stringify(denyContract(host, decision))}\n`);
  return decision.decision === 'block' ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}
