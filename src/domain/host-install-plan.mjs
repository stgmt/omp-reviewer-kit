// What the installer would do, decided without touching the disk. One plan per host, so the CLI and
// the tests agree about the answer and a dry run is the same computation as an apply.

import path from 'node:path';

/** Components OpenCode discovers in the user's config directory. */
export const OPENCODE_COMPONENTS = Object.freeze([
  { from: 'opencode/agents', to: 'agents', pattern: '.md' },
  { from: 'skills', to: 'skills', pattern: '/SKILL.md' },
  { from: 'opencode/commands', to: 'commands', pattern: '.md' },
]);

/** The package name this kit installs under. */
export const KIT_PACKAGE = 'omp-reviewer-kit';

/**
 * True for a plugin spec that names this kit, and only this kit: `omp-reviewer-kit` and
 * `omp-reviewer-kit@<anything>` match, while a sibling such as `omp-reviewer-kit-helper` does not.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKitPackageSpec(value) {
  const spec = String(value ?? '');
  return spec === KIT_PACKAGE || spec.startsWith(`${KIT_PACKAGE}@`);
}

/**
 * The OpenCode plugin spec for one release. It names the release tag, because the host keys its Git
 * package cache by the spec string: an unversioned spec keeps serving the bytes it fetched first.
 *
 * @param {string} version
 * @returns {string}
 */
export function opencodePluginEntry(version) {
  return `omp-reviewer-kit@git+https://github.com/stgmt/omp-reviewer-kit.git#v${version}`;
}

/**
 * Canonicalizes the install manifest. Hash-bearing entries let later installs and removals
 * distinguish unchanged kit files from user edits; string entries are retained for legacy manifests.
 *
 * @param {{ version: string, files: Array<string|{path:string, sha256:string}> }} input
 * @returns {{ version: string, files: Array<string|{path:string, sha256:string}> }}
 */
export function installRecord({ version, files }) {
  const byPath = new Map();
  for (const file of files ?? []) {
    if (typeof file === 'string') {
      if (!byPath.has(file)) byPath.set(file, file);
    } else if (file && typeof file.path === 'string' && /^[a-f0-9]{64}$/i.test(String(file.sha256 ?? ''))) {
      byPath.set(file.path, { path: file.path, sha256: String(file.sha256).toLowerCase() });
    }
  }
  return {
    version: String(version),
    files: [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, file]) => file),
  };
}

/** The file the installer writes to remember what it copied. */
export const INSTALL_MANIFEST = '.omp-reviewer-kit-manifest.json';

/**
 * Where OpenCode reads its global config.
 *
 * @param {object} env
 * @param {string} home
 * @returns {string}
 */
export function opencodeConfigDir(env, home) {
  return env?.OPENCODE_CONFIG_DIR ?? path.join(env?.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode');
}

/**
 * The plan for one host.
 *
 * @param {{
 *   host: 'opencode'|'omp'|'claude'|'codex',
 *   version: string,
 *   action: 'install'|'remove',
 *   kitRoot: string,
 *   configDir?: string,
 *   pluginEntry?: string,
 *   findings?: Array<{ code: string, message: string }>,
 * }} input
 * @returns {{
 *   host: string, action: string, blocked: boolean, blockers: Array<{code: string, message: string}>,
 *   steps: Array<{ kind: 'write-config'|'copy-tree'|'remove-tree'|'report', detail: string, path?: string }>,
 * }}
 */
export function planHostInstall({ host, version, action, kitRoot, configDir, pluginEntry, findings = [] }) {
  const blockers = findings.filter(finding => finding.code === 'duplicate-install-mode' || finding.code === 'config-unreadable');
  if (host === 'opencode') {
    const dir = configDir;
    const entry = pluginEntry ?? opencodePluginEntry(version);
    const base = { host, action, blocked: blockers.length > 0, blockers };
    if (action === 'remove') {
      return {
        ...base,
        steps: [
          { kind: 'write-config', detail: `remove ${entry} from the plugin array`, path: dir },
          { kind: 'remove-tree', detail: 'remove only manifest-listed components whose current bytes still match their recorded ownership; preserve edited or conflicting files', path: dir },
          { kind: 'report', detail: 'the OpenCode package cache is left to OpenCode; it is keyed by the spec string' },
        ],
      };
    }
    return {
      ...base,
      steps: [
        { kind: 'copy-tree', detail: 'copy native agents, skills and commands the kit owns', path: dir },
        { kind: 'report', detail: `installed version ${version} from ${kitRoot}` },
      ],
    };
  }
  // The other three hosts install themselves; the plan only reports the command that does it.
  const commands = {
    omp: ['omp plugin marketplace add stgmt/omp-reviewer-kit', 'omp plugin install omp-reviewer-kit@omp-reviewer-kit --scope user'],
    claude: ['claude plugin marketplace add stgmt/omp-reviewer-kit', 'claude plugin install omp-reviewer-kit@omp-reviewer-kit --scope user'],
    codex: ['codex plugin marketplace add stgmt/omp-reviewer-kit --ref main', 'codex plugin add omp-reviewer-kit@omp-reviewer-kit'],
  };
  return {
    host,
    action: 'report',
    blocked: blockers.length > 0,
    blockers,
    steps: (commands[host] ?? []).map(command => ({ kind: 'report', detail: command })),
  };
}

/**
 * Reads the plugin array out of an `opencode.json`/`opencode.jsonc` text without a JSONC parser: it
 * finds the `"plugin"` key and returns the string entries inside its array. Comments inside the array
 * are ignored, which is enough to answer "is this entry present" and to rebuild the array.
 *
 * @param {string} text
 * @returns {{ present: boolean, entries: string[] }}
 */
export function readPluginArray(text) {
  // The key is located in the raw text with comments and strings respected: a commented-out example
  // is documentation, and a `"plugin"` inside another string is not a property.
  const source = String(text ?? '');
  const from = findPluginArrayStart(source);
  if (from === -1) return { present: false, entries: [], items: [] };
  const to = matchingBracket(source, from);
  const body = stripComments(source.slice(from, to));
  const entries = [];
  const items = [];
  for (const item of splitTopLevel(body)) {
    const first = firstString(item);
    if (first === null) continue;
    entries.push(first);
    items.push(item);
  }
  return { present: true, entries, items };
}

/**
 * The index just past the `[` of the active `"plugin"` property, or -1. Comments and string literals
 * are skipped, so a commented-out example never wins.
 *
 * @param {string} source
 * @returns {number}
 */
function findPluginArrayStart(source) {
  let inString = false;
  let comment = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (comment === 'line') { if (character === '\n') comment = null; continue; }
    if (comment === 'block') {
      if (character === '*' && source[index + 1] === '/') { comment = null; index += 1; }
      continue;
    }
    if (inString) {
      if (character === '\\') { index += 1; continue; }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') { comment = 'line'; index += 1; continue; }
    if (character === '/' && source[index + 1] === '*') { comment = 'block'; index += 1; continue; }
    if (character === '"') {
      const match = /^"plugin"\s*:\s*\[/.exec(source.slice(index));
      if (match) return index + match[0].length;
      inString = true;
      continue;
    }
  }
  return -1;
}

/** Removes line and block comments without touching a string literal. */
function stripComments(body) {
  let out = '';
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      out += character;
      if (character === '\\') { out += body[index + 1] ?? ''; index += 1; continue; }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; out += character; continue; }
    if (character === '/' && body[index + 1] === '/') {
      const newline = body.indexOf('\n', index);
      if (newline === -1) break;
      index = newline - 1;
      continue;
    }
    if (character === '/' && body[index + 1] === '*') {
      const close = body.indexOf('*/', index + 2);
      if (close === -1) break;
      index = close + 1;
      continue;
    }
    out += character;
  }
  return out;
}

/** The index just past the `]` matching an already-opened array. */
function matchingBracket(source, from) {
  // Brackets inside a comment are text: a JSONC comment that mentions `[` must not shift the match.
  let index = from;
  let inComment = false;
  let depth = 1;
  let inString = false;
  while (index < source.length && depth > 0) {
    const character = source[index];
    if (inComment) {
      if (character === '\n') inComment = false;
      index += 1;
      continue;
    }
    if (inString) {
      if (character === '\\') { index += 2; continue; }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') { inComment = true; index += 2; continue; }
    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (character === '"') { inString = true; index += 1; continue; }
    if (character === '[' || character === '{') depth += 1;
    if (character === ']' || character === '}') depth -= 1;
    index += 1;
  }
  return index - 1;
}

/** Splits an array body into its top-level elements, respecting nested arrays, objects and strings. */
function splitTopLevel(body) {
  const items = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      current += character;
      if (character === '\\') { current += body[index + 1] ?? ''; index += 1; continue; }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; current += character; continue; }
    if (character === '[' || character === '{') depth += 1;
    if (character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) { items.push(current); current = ''; continue; }
    current += character;
  }
  if (current.trim() !== '') items.push(current);
  return items.map(item => item.trim()).filter(item => item !== '');
}

/** The first string literal of an element: the spec of a plain entry or of a `[spec, options]` tuple. */
function firstString(item) {
  const match = /^\s*(?:\[\s*)?(['"`])((?:\\.|(?!\1).)*)\1/.exec(item);
  return match ? match[2] : null;
}

/**
 * Rewrites the plugin array to contain exactly `entries`, preserving the rest of the file.
 *
 * @param {string} text
 * @param {string[]} entries
 * @returns {string}
 */
export function writePluginArray(text, entries) {
  return writePluginItems(text, entries.map(entry => JSON.stringify(entry)));
}

/**
 * Rewrites the plugin array from raw element texts, so a `[spec, options]` tuple keeps its options
 * exactly as the user wrote them.
 *
 * @param {string} text
 * @param {string[]} items raw element texts
 * @returns {string}
 */
export function writePluginItems(text, items) {
  const source = String(text ?? '{}');
  const rendered = `"plugin": [\n${items.map(item => `    ${item}`).join(',\n')}\n  ]`;
  const arrayStart = findPluginArrayStart(source);
  const key = arrayStart === -1 ? null : { index: source.lastIndexOf('"plugin"', arrayStart), end: arrayStart };
  if (!key) {
    const closing = source.lastIndexOf('}');
    // A config that never closes is not a config: replacing it would delete whatever the user wrote.
    if (closing === -1) return null;
    const head = source.slice(0, closing).trimEnd();
    const needsComma = !/[{,]\s*$/.test(head);
    return `${head}${needsComma ? ',' : ''}\n  ${rendered}\n${source.slice(closing)}`;
  }
  // The same comment-aware walk the reader uses: a `]` inside a comment is text, not the array's end.
  const end = matchingBracket(source, key.end) + 1;
  return `${source.slice(0, key.index)}${rendered}${source.slice(end)}`;
}
