// omp-reviewer-kit runner v0.20.0
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function unquoteGitPath(quoted) {
  const inner = quoted.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 3 < inner.length && /[0-7]/.test(inner[i + 1]) && /[0-7]/.test(inner[i + 2]) && /[0-7]/.test(inner[i + 3])) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (inner[i] === '\\' && inner[i + 1] === '\\') {
      bytes.push(0x5c);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === '"') {
      bytes.push(0x22);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === 't') {
      bytes.push(0x09);
      i += 1;
    } else if (inner[i] === '\\' && inner[i + 1] === 'n') {
      bytes.push(0x0a);
      i += 1;
    } else {
      bytes.push(inner.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Extracts the old/new paths of one `diff --git` block. The
 * `diff --git a/<old> b/<new>` header is ambiguous for unquoted paths
 * containing ` b/`, so paths are read from single-path lines first:
 * `rename from/to`, `copy from/to`, then `---`/`+++`. The header is the
 * last resort for mode-only blocks that carry none of those lines.
 * `/dev/null` sides yield null.
 * @param {string} blockText - one diff block starting at `diff --git`
 * @returns {{ oldPath: string|null, newPath: string|null }}
 */
function diffBlockPaths(blockText) {
  const decode = (side, stripPrefix) => {
    if (!side || side === '/dev/null') return null;
    const raw = side.startsWith('"') ? unquoteGitPath(side) : side;
    return stripPrefix ? raw.replace(/^[ab]\//, '') : raw;
  };
  const line = (re, stripPrefix) => {
    const match = re.exec(blockText);
    return match ? decode(match[1].trimEnd(), stripPrefix) : null;
  };
  // rename/copy lines carry bare paths; ---/+++ carry a//b/ prefixes.
  let oldPath = line(/^rename from (.+)$/m, false) ?? line(/^copy from (.+)$/m, false) ?? line(/^--- (.+)$/m, true);
  let newPath = line(/^rename to (.+)$/m, false) ?? line(/^copy to (.+)$/m, false) ?? line(/^\+\+\+ (.+)$/m, true);
  if (oldPath === null && newPath === null) {
    // blockText starts right after `diff --git ` — its first line is the header.
    const header = blockText.slice(0, blockText.indexOf('\n') === -1 ? undefined : blockText.indexOf('\n'));
    const sides = /^(?:"((?:[^"\\]|\\.)*)"|(a\/.*?)) (?:"((?:[^"\\]|\\.)*)"|(b\/.*))$/.exec(header.trimEnd());
    if (sides) {
      oldPath = decode(sides[1] !== undefined ? `"${sides[1]}"` : sides[2], true);
      newPath = decode(sides[3] !== undefined ? `"${sides[3]}"` : sides[4], true);
    }
  }
  return { oldPath, newPath };
}

/**
 * ============================================================================
 * Domain Layer (DDD / OOP)
 * ============================================================================
 */

/**
 * Value Object representing a staged Git diff and its deterministic cryptographic identity.
 */
export class DiffIdentity {
  #bytes;
  #hash;
  #excludedPaths;

  /**
   * @param {Buffer} buffer
   * @param {{ excludedPaths?: string[] }} [options] - vendored kit paths left out of
   *   `buffer`; recorded with the run, never part of the hash
   */
  constructor(buffer, { excludedPaths = [] } = {}) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('DiffIdentity expects a Buffer');
    }
    this.#bytes = buffer;
    this.#hash = createHash('sha256').update(buffer).digest('hex');
    this.#excludedPaths = Object.freeze([...excludedPaths]);
  }


  static fromBuffer(buffer, options) {
    return new DiffIdentity(buffer, options);
  }

  static fromString(text) {
    return new DiffIdentity(Buffer.from(text, 'utf8'));
  }

  isEmpty() {
    return this.#bytes.length === 0;
  }

  get hash() {
    return this.#hash;
  }

  get bytes() {
    return this.#bytes;
  }

  get length() {
    return this.#bytes.length;
  }

  /**
   * Vendored kit paths that the staged diff left out of review (see SubprocessGitAdapter).
   * @returns {readonly string[]}
   */
  get excludedPaths() {
    return this.#excludedPaths;
  }

  /**
   * Unique repository-relative paths touched by this diff, parsed from
   * each block's `---`/`+++` lines (both sides for renames).
   * @returns {string[]}
   */
  get changedPaths() {
    const text = this.#bytes.toString('utf8');
    const seen = new Set();
    for (const blockText of text.split(/^diff --git /m).slice(1)) {
      const { oldPath, newPath } = diffBlockPaths(blockText);
      if (oldPath) seen.add(oldPath);
      if (newPath) seen.add(newPath);
    }
    return [...seen];
  }
}


export const DEFAULT_ASSERT_PATTERNS = [
  '\\bassert\\b',
  '\\bexpect\\s*\\(',
  '\\bshould\\b',
  '\\brequire\\s*\\(',
  '\\bt\\.(?:Fatal|Error|Fatalf|Errorf)\\b',
];

export const DEFAULT_TEST_PATH_PATTERNS = [
  '(^|/)tests?/',
  '(^|/)__tests__/',
  '(^|/)spec/',
  '\\.test\\.',
  '\\.spec\\.',
  '_test\\.',
  '(^|/)test_',
];

export const DEFAULT_TEST_DECLARATION_PATTERNS = [
  '\\bdef\\s+test_',
  '\\bit\\s*\\(',
  '\\btest\\s*\\(',
  '\\bdescribe\\s*\\(',
  '\\bfunc\\s+Test',
  '@Test\\b',
];

export function isTestPath(path, patterns = DEFAULT_TEST_PATH_PATTERNS) {
  if (typeof path !== 'string' || path.length === 0) return false;
  return patterns.some((p) => new RegExp(p).test(path));
}
const EXECUTABLE_EXTENSIONS = new Set([
  '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.fs',
  '.rb', '.php', '.swift', '.scala', '.clj', '.ex', '.exs',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  // Script-bearing or auto-executing payloads a renderer/shell can run.
  '.hta', '.wsf', '.vbs', '.svg',
  // Starlark build files execute at build time.
  '.bzl',
  // Make fragments, gem build specs, and desktop entries execute on build/open.
  '.mk', '.gemspec', '.desktop',
  // Groovy (Gradle/Jenkins) and Python launcher scripts execute like .py.
  '.groovy', '.pyw',
  // RPM/DEB build descriptors run %prep/%build/%install shell sections.
  '.spec',
  // Build-executing fragments/systems: CMake modules run execute_process,
  // Gradle/Autotools/Ninja/GYP/MSBuild include-and-run arbitrary commands,
  // Tcl and .m4 macros drive generation, .inc/.mak are make includes.
  '.cmake', '.gradle', '.am', '.ninja', '.m4', '.mak',
  '.gyp', '.gypi', '.props', '.targets', '.proj', '.inc', '.tcl',
  // Shell-opened payloads: .scf/.url/.reg/.command/.applescript/.msc/.cpl
  // run commands on open/import; .ipynb executes embedded code cells.
  '.scf', '.url', '.reg', '.command', '.applescript', '.msc', '.cpl', '.ipynb',
  // Binary payloads execute on load: PE images, native modules, wasm,
  // JVM archives, shared libs, screensavers, and legacy .com/.pif runners.
  '.exe', '.dll', '.wasm', '.node', '.msi', '.jar', '.so', '.dylib',
  '.scr', '.com', '.pif',
  // HTML/CSS are renderer-executable: .html/.htm embed scriptable markup
  // (same rationale as .svg/.hta); .css drives external loads and legacy
  // expression() — a style-only diff can still smuggle behavior.
  '.html', '.htm', '.css',
]);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.xml',
  '.ini', '.cfg', '.conf', '.env', '.lock', '.properties', '.plist',
]);

const DOCS_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc',
]);

const CONFIG_BASENAMES = new Set([
  'tsconfig.json', 'jsconfig.json', 'deno.json',
  '.env', '.gitignore', '.gitattributes',
  '.nvmrc', '.editorconfig',
]);

const EXECUTABLE_BASENAMES = new Set([
  // Build files / wrappers that execute commands at build or commit time.
  'dockerfile', 'makefile', 'gemfile', 'rakefile', 'jenkinsfile',
  'vagrantfile', 'brewfile', 'package.json', 'go.mod', 'docker-bake.hcl',
  'configure', 'configure.ac', 'gradlew', 'mvnw',
  // Commit-time hook configs whose entries run arbitrary commands.
  '.pre-commit-config.yaml', '.pre-commit-hooks.yaml',
  // Standalone CI pipeline files (GitHub/GitLab dirs handled below).
  '.travis.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml',
  '.drone.yml', 'appveyor.yml', 'cloudbuild.yaml',
  // Task/build engines that embed command runners.
  'taskfile', 'sconstruct', 'sconscript', 'meson.build', 'buck', 'workspace',
  // Bazel canonical BUILD (basename 'build') and Ant build.xml execute at
  // build time — '.xml' alone would classify Ant as config.
  'build', 'build.xml',
  'build.bazel', 'module.bazel', 'workspace.bazel', 'workspace.bzlmod',
  'build.sbt', 'build.gradle', 'settings.gradle', 'build.gradle.kts',
  'settings.gradle.kts', 'pom.xml',
  // Supply-chain executables: lockfiles pin resolved URLs/integrity hashes,
  // devcontainer/dependabot configs drive commands or package resolution.
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'devcontainer.json', 'dependabot.yml', 'dependabot.yaml', 'renovate.json',
  '.npmrc',
  // Editor and shell auto-exec surfaces: .vscode tasks run arbitrary
  // commands on folder open, direnv and shell rc files execute on cd/login.
  'justfile', 'snakefile', 'earthfile', 'pipefile',
  '.envrc', '.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile',
  // Non-npm ecosystems, same supply-chain rationale: build manifests declare
  // build backends/hooks that execute at install time; lockfiles pin
  // resolved artifacts whose substitution is silent code execution.
  'pyproject.toml', 'setup.cfg', 'setup.py',
  'cargo.toml', 'cargo.lock',
  'composer.json', 'composer.lock', 'gemfile.lock',
  'go.sum', 'poetry.lock', 'pipfile', 'pipfile.lock',
  'pdm.lock', 'uv.lock', 'bun.lock', 'deno.lock',
  'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt',
  'requirements-prod.txt',
  // Round-7 (P1): build-executing files must never ride spec-docs.
  // CMakeLists execute_process/ExternalProject run arbitrary commands;
  // GNUmakefile/*.mk/build.ninja are make executables; bitrise/pipeline
  // YAML drive CI steps; gemspecs run code at gem build; .desktop files
  // execute on open; shell auto-exec and review-gate (CODEOWNERS) files
  // change what runs or who must approve.
  'cmakelists.txt', 'gnumakefile', 'build.ninja',
  'bitrise.yml', 'pipeline.yml',
  'codeowners', '.htaccess', '.zshenv', '.xinitrc',
  // Deploy executors: Procfile commands run at dyno start; tox/mise/
  // cargo-make/CMakePresets all carry executable command entries.
  'procfile', 'tox.ini', 'mise.toml', 'makefile.toml', 'cmakepresets.json',
]);
const EXECUTABLE_FAMILIES = [
  'docker-compose', 'compose.', 'dockerfile.', '.gitlab-ci',
  '.husky/', 'gradle-wrapper.', 'azure-pipelines', 'bitbucket-pipelines',
  'cloudbuild.', 'taskfile.', 'pre-commit', '.pre-commit',
];

export function classifyFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return 'data';
  const normalized = filePath.replace(/\\/g, '/');
  // NTFS silently strips trailing dots/spaces from EVERY path segment, so the
  // name that materializes on Windows disk is the folded one — classify that
  // name, not the raw staged string. `run.cmd ` writes `run.cmd`; without the
  // fold the executable payload would be classified `data`.
  const lower = normalized
    .split('/')
    .map((segment) => segment.replace(/[. ]+$/, ''))
    .join('/')
    .toLowerCase();
  const basename = lower.split('/').pop() ?? lower;
  const ext = basename.includes('.') ? basename.slice(basename.lastIndexOf('.')) : '';

  // Executable surface first: code, scripts, CI workflows, git hooks, package
  // lifecycle manifests, and build files can run or drive commit-time code
  // regardless of the directory they live in, so they keep the profile `full`.
  if (EXECUTABLE_EXTENSIONS.has(ext)) return 'executable';
  if (lower.startsWith('.githooks/') || lower.includes('/.githooks/')) return 'executable';
  if (lower.startsWith('.github/workflows/') || lower.includes('/.github/workflows/')) return 'executable';
  if (lower.startsWith('.github/actions/') || lower.includes('/.github/actions/')) return 'executable';
  if (lower.startsWith('.circleci/') || lower.includes('/.circleci/')) return 'executable';
  if (lower.startsWith('.buildkite/') || lower.includes('/.buildkite/')) return 'executable';
  if (lower.startsWith('.husky/') || lower.includes('/.husky/')) return 'executable';
  if (lower.startsWith('ci/')) return 'executable';
  if (lower.startsWith('.vscode/') || lower.includes('/.vscode/')) return 'executable';
  if (lower === '.cargo/config.toml' || lower === '.cargo/config') return 'executable';
  // Gitea/Forgejo are GitHub-compatible CI hosts: same workflow/action paths.
  // GitLab's include:local split-out directory: .gitlab/ci/*.yml holds
  // real pipeline YAML, not config.
  if (lower.startsWith('.gitlab/ci/') || lower.includes('/.gitlab/ci/')) return 'executable';
  if (lower.startsWith('.gitea/workflows/') || lower.includes('/.gitea/workflows/')) return 'executable';
  if (lower.startsWith('.gitea/actions/') || lower.includes('/.gitea/actions/')) return 'executable';
  if (lower.startsWith('.forgejo/workflows/') || lower.includes('/.forgejo/workflows/')) return 'executable';
  if (lower.startsWith('.forgejo/actions/') || lower.includes('/.forgejo/actions/')) return 'executable';
  // Woodpecker/Semaphore/Cirrus/Zuul CI surfaces.
  if (lower.startsWith('.woodpecker/') || lower.includes('/.woodpecker/')) return 'executable';
  if (basename === '.woodpecker.yml') return 'executable';
  if (lower.startsWith('.semaphore/') || lower.includes('/.semaphore/')) return 'executable';
  if (lower.startsWith('.cirrus/') || lower.includes('/.cirrus/')) return 'executable';
  if (basename === '.cirrus.yml') return 'executable';
  if (lower.startsWith('zuul.d/') || lower.includes('/zuul.d/')) return 'executable';
  if (basename === '.zuul.yaml') return 'executable';
  // `web.Dockerfile`-style suffixed Dockerfiles build images like Dockerfile.
  if (basename.endsWith('.dockerfile')) return 'executable';
  if (basename === '.gitmodules') return 'executable';
  // Podman/Buildah Containerfile and Arch/Alpine build descriptors execute
  // RUN/prepare/build shell at build time — same trust boundary as Dockerfile.
  if (basename === 'containerfile' || basename.startsWith('containerfile.') || basename === 'pkgbuild' || basename === 'apkbuild') return 'executable';
  // Extensionless payloads staged mode 100644 (every Windows checkout with
  // core.fileMode=false) never reach the 100755 upgrade: the classifier must
  // treat any dotless basename as a shell/script payload by DEFAULT and
  // exempt only the conventional prose names. Directory whitelists were tried
  // first — contrib/, libexec/, hack/, deploy/ gaps kept routing payloads to
  // spec-docs, so the trust boundary inverts: unknown dotless names are
  // executable, documented docs-names keep their doc class.
  const DOTLESS_DOCS = new Set([
    'license', 'license-mit', 'licence', 'copying', 'copying3', 'notice',
    'readme', 'authors', 'contributors', 'changelog', 'changes', 'history',
    'news', 'todo', 'install', 'version', 'thanks', 'credits', 'maintainers',
    'dockerignore', 'gitkeep', 'keep',
  ]);
  if (!basename.includes('.') && !DOTLESS_DOCS.has(basename)) return 'executable';
  // Maven extension/config dir runs args and injected jars at build time.
  if (lower.startsWith('.mvn/') || lower.includes('/.mvn/')) return 'executable';
  // IntelliJ run configurations execute commands in-repo.
  if (lower.startsWith('.idea/runconfigurations/') || lower.includes('/.idea/runconfigurations/')) return 'executable';
  if (EXECUTABLE_BASENAMES.has(basename)) return 'executable';
  if (EXECUTABLE_FAMILIES.some((f) => basename.startsWith(f))) return 'executable';

  // Document-class prefix rules then apply to document/config-class files only.
  if (lower.startsWith('agents/') || lower.includes('/agents/')) return 'prompt';
  if (lower.startsWith('skills/') || lower.includes('/skills/')) return 'prompt';
  if (basename === 'skill.md') return 'prompt';
  if (lower.startsWith('.specs/') || lower.includes('/.specs/')) return 'spec';
  if (basename.endsWith('.feature') || basename.endsWith('_schema.md')) return 'spec';
  if (CONFIG_BASENAMES.has(basename)) return 'config';

  if (DOCS_EXTENSIONS.has(ext)) return 'docs';
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  return 'data';
}

export function classifyChangedPaths(paths, isTest = () => false, modeByPath = new Map()) {
  const result = [];
  for (const p of paths ?? []) {
    let fileClass = classifyFilePath(p);
    if (fileClass !== 'executable' && modeByPath.get(p) === '100755') fileClass = 'executable';
    // Test-path re-tag applies to EVERY non-executable class too: a staged
    // fixture, golden oracle, or .feature under the test tree is the canonical
    // suite-weakening move (assertions stay green while the oracle is tampered),
    // so it must ride the full review profile like test code does.
    if (isTest(p)) fileClass = 'test';
    result.push({ path: p, fileClass });
  }
  return result;
}

export function reviewProfileFor(entries) {
  const hasExecutable = (entries ?? []).some(
    (e) => e.fileClass === 'executable' || e.fileClass === 'test',
  );
  return hasExecutable ? 'full' : 'spec-docs';
}

const VALID_RISK_LANES = new Set(['correctness', 'security', 'content-risk']);

/**
 * Resolve which risk-hunter lanes Stage 2 spawns.
 * `OMP_REVIEW_KIT_LANES` is a comma-separated allowlist over
 * `correctness|security|content-risk`. Unset/empty → `full` runs correctness
 * ONLY (the security lane stays opt-in on request), `spec-docs` runs
 * content-risk. Unknown tokens fail loudly — a typo must never silently
 * disable every hunter lane.
 *
 * @param {'full'|'spec-docs'} profile
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function riskLanesFor(profile, env = {}) {
  const raw = typeof env?.OMP_REVIEW_KIT_LANES === 'string' ? env.OMP_REVIEW_KIT_LANES.trim() : '';
  if (raw.length === 0) return profile === 'spec-docs' ? ['content-risk'] : ['correctness'];
  const lanes = raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (lanes.length === 0) {
    // Separator-only values (',', ' , ') must not silently disable Stage 2.
    throw new Error('OMP_REVIEW_KIT_LANES names no usable lane (allowed: correctness, security, content-risk)');
  }
  for (const lane of lanes) {
    if (!VALID_RISK_LANES.has(lane)) {
      throw new Error(`OMP_REVIEW_KIT_LANES has unknown lane "${lane}" (allowed: correctness, security, content-risk)`);
    }
  }
  return [...new Set(lanes)];
}

export function parseDiffBlocks(diffText) {
  if (typeof diffText !== 'string' || diffText.trim().length === 0) {
    return [];
  }

  const blocks = [];
  const rawBlocks = diffText.split(/^diff --git /m);
  for (let i = 1; i < rawBlocks.length; i += 1) {
    const blockText = rawBlocks[i];
    if (blockText.includes('Binary files ') && blockText.includes(' differ')) {
      continue;
    }

    const { oldPath, newPath } = diffBlockPaths(blockText);
    const path = newPath ?? oldPath;
    if (!path) continue;
    const deleted = /^deleted file mode \d+/m.test(blockText);

    const addedLines = [];
    const removedLines = [];

    const lines = blockText.split('\n');
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) {
        addedLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        removedLines.push(line.slice(1));
      }
    }

    blocks.push({
      path,
      deleted,
      addedLines,
      removedLines,
    });
  }

  return blocks;
}

export class SuspicionMap {
  #entries;

  constructor(entries = []) {
    this.#entries = Object.freeze([...entries]);
  }

  get entries() {
    return this.#entries;
  }

  get isEmpty() {
    return this.#entries.length === 0;
  }

  static compute({
    diffBytes,
    assertPatterns = DEFAULT_ASSERT_PATTERNS,
    testPathPatterns = DEFAULT_TEST_PATH_PATTERNS,
    testDeclarationPatterns = DEFAULT_TEST_DECLARATION_PATTERNS,
  } = {}) {
    if (!diffBytes || diffBytes.length === 0) {
      return new SuspicionMap([]);
    }

    const diffText = Buffer.isBuffer(diffBytes)
      ? diffBytes.toString('utf8')
      : String(diffBytes);

    const blocks = parseDiffBlocks(diffText);
    const entries = [];

    const assertRegexes = assertPatterns.map((p) => new RegExp(p));
    const declRegexes = testDeclarationPatterns.map((p) => new RegExp(p));

    for (const block of blocks) {
      if (!isTestPath(block.path, testPathPatterns)) {
        continue;
      }

      if (block.deleted) {
        entries.push({
          path: block.path,
          kind: 'deleted_test_file',
          added: 0,
          removed: block.removedLines.length,
          net: -block.removedLines.length,
          detail: `${block.removedLines.length} removed lines`,
        });
        continue;
      }

      let addedAsserts = 0;
      for (const line of block.addedLines) {
        if (assertRegexes.some((re) => re.test(line))) {
          addedAsserts += 1;
        }
      }

      let removedAsserts = 0;
      for (const line of block.removedLines) {
        if (assertRegexes.some((re) => re.test(line))) {
          removedAsserts += 1;
        }
      }

      if (addedAsserts !== 0 || removedAsserts !== 0) {
        const net = addedAsserts - removedAsserts;
        entries.push({
          path: block.path,
          kind: 'assert_delta',
          added: addedAsserts,
          removed: removedAsserts,
          net,
          detail: `assert lines +${addedAsserts}/-${removedAsserts} (net ${net > 0 ? `+${net}` : net})`,
        });
      }

      let removedDecls = 0;
      for (const line of block.removedLines) {
        if (declRegexes.some((re) => re.test(line))) {
          removedDecls += 1;
        }
      }

      if (removedDecls > 0) {
        entries.push({
          path: block.path,
          kind: 'removed_test_declarations',
          added: 0,
          removed: removedDecls,
          net: -removedDecls,
          detail: `${removedDecls} test declaration${removedDecls === 1 ? '' : 's'} removed`,
        });
      }
    }

    return new SuspicionMap(entries);
  }

  toPromptText() {
    if (this.isEmpty) {
      return 'Deterministic suspicion map: no test-file assert deltas, deletions, or removed test declarations detected.';
    }

    const lines = [
      'Deterministic suspicion map (computed from the staged diff; every entry must be addressed):',
    ];

    for (const entry of this.#entries) {
      if (entry.kind === 'assert_delta') {
        const netStr = entry.net > 0 ? `+${entry.net}` : `${entry.net}`;
        lines.push(`- ${sanitizePromptToken(entry.path)}: assert lines +${entry.added}/-${entry.removed} (net ${netStr})`);
      } else if (entry.kind === 'deleted_test_file') {
        lines.push(`- ${sanitizePromptToken(entry.path)}: deleted test file (${entry.removed} removed lines)`);
      } else if (entry.kind === 'removed_test_declarations') {
        lines.push(`- ${sanitizePromptToken(entry.path)}: ${entry.removed} test declaration${entry.removed === 1 ? '' : 's'} removed`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Immutable value object containing the complete staged index tree.
 */
export function buildRevertedFiles({
  files = [],
  changedPaths = [],
  testPathPatterns,
  headFiles = new Map(),
} = {}) {
  const changedSet = new Set(changedPaths);
  const resultFiles = [];
  const processedPaths = new Set();

  for (const file of files) {
    processedPaths.add(file.path);
    if (!changedSet.has(file.path) || isTestPath(file.path, testPathPatterns)) {
      resultFiles.push({ path: file.path, content: file.content, mode: file.mode });
      continue;
    }

    const headContent = headFiles.get(file.path);
    if (headContent !== null && headContent !== undefined) {
      resultFiles.push({ path: file.path, content: headContent, mode: file.mode });
    }
  }

  for (const p of changedPaths) {
    if (!processedPaths.has(p) && !isTestPath(p, testPathPatterns)) {
      const headContent = headFiles.get(p);
      if (headContent !== null && headContent !== undefined) {
        resultFiles.push({ path: p, content: headContent });
      }
    }
  }

  return resultFiles;
}

export class ExecutionEvidence {
  #command;
  #timeoutMs;
  #staged;
  #reverted;
  #revertedSkipReason;
  #warnings;

  constructor({
    command = '',
    timeoutMs = 600000,
    staged = null,
    reverted = null,
    revertedSkipReason = '',
    warnings = [],
  } = {}) {
    this.#command = command;
    this.#timeoutMs = timeoutMs;
    this.#staged = staged;
    this.#reverted = reverted;
    this.#revertedSkipReason = revertedSkipReason;
    this.#warnings = Object.freeze([...warnings]);
  }

  get command() {
    return this.#command;
  }

  get staged() {
    return this.#staged;
  }

  get reverted() {
    return this.#reverted;
  }

  get warnings() {
    return this.#warnings;
  }

  static tail(output, maxLines = 20) {
    if (!output || typeof output !== 'string') return '';
    const lines = output.trimEnd().split(/\r?\n/);
    if (lines.length <= maxLines) return lines.join('\n');
    return lines.slice(-maxLines).join('\n');
  }

  toPromptText() {
    const timeoutSec = Math.round(this.#timeoutMs / 1000);
    const lines = [
      'Execution evidence (opt-in, produced by the dispatcher before this review):',
      `- Command: \`${this.#command}\` (timeout ${timeoutSec}s)`,
    ];

    for (const warning of this.#warnings) {
      lines.push(`- Warning: ${warning}`);
    }

    if (!this.#staged) {
      lines.push('- Staged snapshot: not executed');
    } else if (!this.#staged.ok) {
      lines.push(`- Staged snapshot: unavailable (${this.#staged.error})`);
    } else {
      const durationSec = (this.#staged.durationMs / 1000).toFixed(1);
      const timeoutNote = this.#staged.timedOut ? ' (timed out)' : '';
      lines.push(`- Staged snapshot: exit ${this.#staged.exitCode}${timeoutNote} in ${durationSec}s`);
      const combined = `${this.#staged.stdout ?? ''}\n${this.#staged.stderr ?? ''}`.trim();
      const tail = ExecutionEvidence.tail(combined);
      if (tail) {
        lines.push(`  tail: ${tail.replace(/\n/g, '\n  ')}`);
      }
    }

    if (this.#reverted && this.#reverted.ok !== undefined) {
      if (!this.#reverted.ok) {
        lines.push(`- Reverted snapshot: unavailable (${this.#reverted.error})`);
      } else {
        const durationSec = (this.#reverted.durationMs / 1000).toFixed(1);
        const timeoutNote = this.#reverted.timedOut ? ' (timed out)' : '';
        lines.push(`- Reverted snapshot (non-test staged changes reverted to HEAD): exit ${this.#reverted.exitCode}${timeoutNote} in ${durationSec}s`);
        const combined = `${this.#reverted.stdout ?? ''}\n${this.#reverted.stderr ?? ''}`.trim();
        const tail = ExecutionEvidence.tail(combined);
        if (tail) {
          lines.push(`  tail: ${tail.replace(/\n/g, '\n  ')}`);
        }
      }
    } else {
      const reason = this.#revertedSkipReason || (this.#staged && !this.#staged.ok ? 'staged execution unavailable' : 'skipped');
      lines.push(`- Reverted snapshot: skipped (${reason})`);
    }

    lines.push(
      'Interpretation (apply; do not re-derive):',
      '- staged pass + reverted fail => the staged tests prove the staged change (red proof achieved).',
      '- staged pass + reverted pass => the staged tests do not discriminate the staged change; raise a correctness candidate when test files changed.',
      "- staged fail + reverted pass => the staged change breaks the project's own gates; P1 correctness candidate.",
      '- staged fail + reverted fail => pre-existing failure; compare tails; do not attribute it to this change without evidence.',
      '- unavailable => execution evidence is absent; absence proves nothing.',
    );

    return lines.join('\n');
  }
}

export class StagedSnapshot {
  #files;
  #hash;

  /**
   * @param {{ path: string, content: Buffer }[]} files
   */
  constructor(files) {
    if (!Array.isArray(files)) {
      throw new TypeError('StagedSnapshot expects an array of files');
    }

    const normalizedFiles = files.map((file) => {
      if (!file || typeof file.path !== 'string' || !Buffer.isBuffer(file.content)) {
        throw new TypeError('StagedSnapshot files require a string path and Buffer content');
      }
      const normalized = { path: file.path, content: Buffer.from(file.content) };
      if (typeof file.mode === 'string' && file.mode.length > 0) {
        normalized.mode = file.mode;
      }
      return Object.freeze(normalized);
    });

    const hash = createHash('sha256');
    for (const file of normalizedFiles) {
      hash.update(file.path);
      hash.update('\0');
      hash.update(file.content);
      hash.update('\0');
    }

    this.#files = Object.freeze(normalizedFiles);
    this.#hash = hash.digest('hex');
  }

  get files() {
    return this.#files;
  }

  get hash() {
    return this.#hash;
  }
  isEmpty() {
    return this.#files.length === 0;
  }
}

const RESULT_LINE_RE = /^REVIEW_RESULT=(PASS|BLOCK)\r?$/gm;
const RESULT_LINE_RE_TERMINAL = /^REVIEW_RESULT=(PASS|BLOCK)\r?$/;

/**
 * Domain Value Object encapsulating the review verdict and fail-closed validation rules.
 */
export class ReviewVerdict {
  static PASS = 'PASS';
  static BLOCK = 'BLOCK';

  #value;
  #reason;
  #rawOutput;

  /**
   * @param {'PASS'|'BLOCK'} value
   * @param {{ reason?: string, rawOutput?: string }} [meta]
   */
  constructor(value, { reason = '', rawOutput = '' } = {}) {
    if (value !== ReviewVerdict.PASS && value !== ReviewVerdict.BLOCK) {
      throw new Error(`Invalid ReviewVerdict value: ${value}`);
    }
    this.#value = value;
    this.#reason = reason;
    this.#rawOutput = rawOutput;
  }

  /**
   * Evaluates raw reviewer process output and derives a verdict.
   * Fail-closed invariant: only exactly one REVIEW_RESULT=PASS line yields a PASS verdict.
   * Any missing, multiple, or malformed markers strictly yield BLOCK.
   *
   * @param {string} output
   * @returns {ReviewVerdict}
   */
  static fromOutput(output) {
    if (typeof output !== 'string') {
      return new ReviewVerdict(ReviewVerdict.BLOCK, {
        reason: 'non_string_output',
        rawOutput: String(output ?? ''),
      });
    }

    const matches = [...output.matchAll(RESULT_LINE_RE)];
    // A marker is only a verdict when it is the last non-empty line: staged
    // content is quoted verbatim into reviewer output, so a planted
    // REVIEW_RESULT=PASS mid-text must never count. A non-terminal marker
    // degrades to missing_verdict_marker (fail closed).
    // OMP print-mode may append an epilogue/status line AFTER the verdict
    // ('Working...'/'Thinking...'). Scan back over ONLY that shape (and
    // blanks); the first real content line must be the marker, and the
    // marker must be solitary across the WHOLE output — a planted marker
    // earlier in prose plus an epilogue tail must still fail closed.
    const OMP_EPILOGUE_RE = /^\s*(?:Working|Thinking)\.*\s*$/i;
    const lines = output.split(/\r?\n/);
    let cursor = lines.length - 1;
    while (cursor >= 0 && (lines[cursor].trim() === '' || OMP_EPILOGUE_RE.test(lines[cursor]))) cursor--;
    const lastNonEmpty = cursor >= 0 ? lines[cursor].trimEnd() : '';
    const terminal = RESULT_LINE_RE_TERMINAL.test(lastNonEmpty);
    const effective = terminal ? matches : [];

    if (effective.length === 1) {
      const parsedValue = effective[0][1];
      return new ReviewVerdict(parsedValue, {
        reason: parsedValue === ReviewVerdict.PASS ? 'verified' : 'explicit_block',
        rawOutput: output,
      });
    }

    if (effective.length === 0) {
      return new ReviewVerdict(ReviewVerdict.BLOCK, {
        reason: 'missing_verdict_marker',
        rawOutput: output,
      });
    }

    return new ReviewVerdict(ReviewVerdict.BLOCK, {
      reason: 'multiple_verdict_markers',
      rawOutput: output,
    });
  }

  static blockDueToFailure(errorDetails) {
    return new ReviewVerdict(ReviewVerdict.BLOCK, {
      reason: 'execution_failure',
      rawOutput: errorDetails,
    });
  }

  isPass() {
    return this.#value === ReviewVerdict.PASS;
  }

  isBlock() {
    return this.#value === ReviewVerdict.BLOCK;
  }

  get value() {
    return this.#value;
  }

  get reason() {
    return this.#reason;
  }

  get rawOutput() {
    return this.#rawOutput;
  }
}

const ENVELOPE_SCHEMA = 'review-rejection-envelope@1';
const BEGIN_LINE = 'REVIEW_REJECTION_ENVELOPE_BEGIN';
const END_LINE = 'REVIEW_REJECTION_ENVELOPE_END';

const FAILURE_MESSAGES = Object.freeze({
  execution_failure: 'The reviewer process did not complete successfully.',
  missing_verdict_marker: 'No solitary review verdict marker was emitted.',
  multiple_verdict_markers: 'Multiple solitary review verdict markers were emitted.',
  missing_rejection_envelope: 'No rejection envelope was emitted for the BLOCK verdict.',
  malformed_rejection_envelope: 'The rejection envelope was malformed or violated its schema.',
  contradictory_rejection_envelope: 'The rejection envelope contradicted the review verdict.',
});

const TOP_LEVEL_KEYS = Object.freeze(['diff_hash', 'findings', 'kind', 'non_coverable_items', 'schema']);
const FAILURE_TOP_LEVEL_KEYS = Object.freeze([...TOP_LEVEL_KEYS, 'failure'].sort());
const FINDING_KEYS = Object.freeze([
  'blocking',
  'category_kind',
  'counterexample',
  'defect_class',
  'file_path',
  'finding_id',
  'line_end',
  'line_start',
  'priority',
  'severity',
  'source',
  'verifier_argument',
]);
const FAILURE_KEYS = Object.freeze(['code', 'message']);
const COVERAGE_TOP_LEVEL_KEYS = Object.freeze(['coverage_items', 'diff_hash', 'findings', 'kind', 'non_coverable_items', 'schema']);
const COVERAGE_ITEM_KEYS = Object.freeze([
  'behavior',
  'blocking',
  'category_kind',
  'coverage_id',
  'file_path',
  'line_end',
  'line_start',
  'required_tests',
  'severity',
  'source',
]);
const REQUIRED_TEST_KEYS = Object.freeze(['kind', 'mutant', 'scenario']);
// Non-coverable items travel inside the envelope (blocking: false) so the
// report's ### Notes section stays machine-readable; they never block PASS.
const NON_COVERABLE_ITEM_KEYS = Object.freeze([
  'blocking',
  'category_kind',
  'file_path',
  'line_end',
  'line_start',
  'reason',
  'severity',
  'source',
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;

function parseStrictJson(source) {
  let index = 0;

  function fail() {
    throw new SyntaxError('Invalid JSON envelope');
  }

  function skipWhitespace() {
    while (index < source.length && /\s/.test(source[index])) index += 1;
  }

  function parseString() {
    if (source[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < source.length) {
      const current = source[index];
      if (current === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (current === '\\') {
        index += 2;
      } else {
        index += 1;
      }
    }
    fail();
  }

  function parseNumber() {
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail();
    index += match[0].length;
    return Number(match[0]);
  }

  function parseArray() {
    const value = [];
    index += 1;
    skipWhitespace();
    if (source[index] === ']') {
      index += 1;
      return value;
    }
    while (index < source.length) {
      value.push(parseValue());
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return value;
      }
      if (source[index] !== ',') fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseObject() {
    const value = Object.create(null);
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (source[index] === '}') {
      index += 1;
      return value;
    }
    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) fail();
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ':') fail();
      index += 1;
      value[key] = parseValue();
      skipWhitespace();
      if (source[index] === '}') {
        index += 1;
        return value;
      }
      if (source[index] !== ',') fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseValue() {
    skipWhitespace();
    const current = source[index];
    if (current === '"') return parseString();
    if (current === '{') return parseObject();
    if (current === '[') return parseArray();
    if (source.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (source.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (source.startsWith('null', index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== source.length) fail();
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRelativeRepositoryPath(value) {
  if (!isNonEmptyString(value) || value.includes('\\') || value.startsWith('/') || WINDOWS_ABSOLUTE_RE.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function diffHashOf(diffIdentity) {
  const hash = typeof diffIdentity === 'string' ? diffIdentity : diffIdentity?.hash;
  if (!SHA256_RE.test(hash ?? '')) {
    throw new TypeError('ReviewRejectionEnvelope requires a lowercase SHA-256 diff identity');
  }
  return hash;
}

/**
 * Model-emitted envelopes repeatedly drop fields the contract derives
 * deterministically (severity=priority, category_kind, blocking, source
 * mirroring). Filling contract-fixed derivable fields before strict
 * validation is NOT leniency: nothing content-bearing is invented, and
 * without it a schema drop turns a valid BLOCK into
 * malformed_rejection_envelope, discarding every confirmed finding.
 * Prototype-pollution keys (__proto__/constructor/prototype) are NEVER
 * normalized: the item is returned verbatim so strict validation rejects.
 */
const DANGEROUS_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
function hasDangerousKey(item) {
  return DANGEROUS_KEYS.some((k) => Object.hasOwn(item, k));
}
function normalizeFinding(finding) {
  if (!isRecord(finding)) return finding;
  if (hasDangerousKey(finding)) return finding;
  // Whitelist output: verbose model keys (impact, observed, evidence, ...)
  // are not envelope fields — keeping them would fail hasExactKeys.
  return {
    finding_id: isNonEmptyString(finding.finding_id) ? finding.finding_id : finding.candidate_id,
    priority: finding.priority,
    severity: finding.severity === undefined ? finding.priority : finding.severity,
    defect_class: isNonEmptyString(finding.defect_class) ? finding.defect_class : finding.lane,
    category_kind: finding.category_kind === undefined ? 'finding' : finding.category_kind,
    blocking: finding.blocking !== undefined ? finding.blocking : true,
    source: finding.source !== undefined
      ? finding.source
      : (isNonEmptyString(finding.defect_class) ? finding.defect_class : finding.lane),
    file_path: finding.file_path,
    line_start: finding.line_start,
    line_end: finding.line_end,
    verifier_argument: finding.verifier_argument,
    counterexample: finding.counterexample,
  };
}

function normalizeCoverageItem(item) {
  if (!isRecord(item)) return item;
  if (hasDangerousKey(item)) return item;
  // Whitelist output — see normalizeFinding.
  return {
    coverage_id: isNonEmptyString(item.coverage_id) ? item.coverage_id : item.candidate_id,
    category_kind: item.category_kind === undefined ? 'coverage' : item.category_kind,
    // Mandatory coverage gaps are contract-fixed P2 (blockers) — derive.
    severity: item.severity === undefined ? 'P2' : item.severity,
    blocking: item.blocking !== undefined ? item.blocking : true,
    source: item.source !== undefined ? item.source : 'correctness',
    file_path: item.file_path,
    line_start: item.line_start,
    line_end: item.line_end,
    behavior: item.behavior,
    required_tests: item.required_tests,
  };
}

function normalizeNonCoverableItem(item) {
  if (!isRecord(item)) return item;
  if (hasDangerousKey(item)) return item;
  // r34: producers emit different vocabularies — scout records carry
  // `reason`, hunter `ground`, verifier `coverage_id`+`ground`. Map aliases
  // onto the envelope contract and emit ONLY the 8 contract keys: producer
  // bookkeeping ids (coverage_id, candidate_id, ...) are not envelope
  // fields and must be stripped, else hasExactKeys rejects the whole
  // envelope. `source` defaults by producer shape: coverage_id → verifier,
  // ground → hunter, else scout (reason-bearing records).
  const reason = item.reason !== undefined ? item.reason
    : (item.ground !== undefined ? item.ground : item.rejection_ground);
  const source = item.source !== undefined ? item.source
    : (isNonEmptyString(item.producer) ? item.producer
      : (isNonEmptyString(item.stage) ? item.stage
        : (isNonEmptyString(item.lane) ? item.lane
          : (isNonEmptyString(item.coverage_id) ? 'verifier'
            : (isNonEmptyString(item.ground) ? 'hunter' : 'scout')))));
  return {
    category_kind: item.category_kind === undefined ? 'non_coverable' : item.category_kind,
    severity: item.severity === undefined ? 'none' : item.severity,
    blocking: item.blocking !== undefined ? item.blocking : false,
    source,
    file_path: item.file_path,
    line_start: item.line_start,
    line_end: item.line_end,
    reason,
  };
}

function validateFinding(finding, identifiers) {
  if (!hasExactKeys(finding, FINDING_KEYS)) return false;
  if (!isNonEmptyString(finding.finding_id) || identifiers.has(finding.finding_id)) return false;
  if (finding.priority !== 'P1' && finding.priority !== 'P2') return false;
  if (!['correctness', 'security', 'content-risk'].includes(finding.defect_class)) return false;
  if (finding.category_kind !== 'finding') return false;
  if (finding.severity !== finding.priority) return false;
  if (finding.blocking !== true) return false;
  if (!isNonEmptyString(finding.source)) return false;
  if (!isRelativeRepositoryPath(finding.file_path)) return false;
  if (!Number.isInteger(finding.line_start) || finding.line_start < 1) return false;
  if (!Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) return false;
  if (!isNonEmptyString(finding.verifier_argument) || !isNonEmptyString(finding.counterexample)) return false;
  identifiers.add(finding.finding_id);
  return true;
}

function validateRequiredTest(test) {
  if (!hasExactKeys(test, REQUIRED_TEST_KEYS)) return false;
  if (test.kind !== 'edge' && test.kind !== 'mutation') return false;
  if (!isNonEmptyString(test.scenario)) return false;
  if (test.kind === 'mutation' && !isNonEmptyString(test.mutant)) return false;
  if (test.kind === 'edge' && typeof test.mutant !== 'string') return false;
  return true;
}

function validateCoverageItem(item, identifiers) {
  if (!hasExactKeys(item, COVERAGE_ITEM_KEYS)) return false;
  if (!isNonEmptyString(item.coverage_id) || identifiers.has(item.coverage_id)) return false;
  if (item.category_kind !== 'coverage') return false;
  if (item.severity !== 'P1' && item.severity !== 'P2') return false;
  if (item.blocking !== true) return false;
  if (!isNonEmptyString(item.source)) return false;
  if (!isRelativeRepositoryPath(item.file_path)) return false;
  if (!Number.isInteger(item.line_start) || item.line_start < 1) return false;
  if (!Number.isInteger(item.line_end) || item.line_end < item.line_start) return false;
  if (!isNonEmptyString(item.behavior)) return false;
  if (!Array.isArray(item.required_tests) || item.required_tests.length === 0) return false;
  if (!item.required_tests.every(validateRequiredTest)) return false;
  identifiers.add(item.coverage_id);
  return true;
}

function validateNonCoverableItem(item, identifiers) {
  if (!hasExactKeys(item, NON_COVERABLE_ITEM_KEYS)) return false;
  if (item.category_kind !== 'non_coverable') return false;
  if (item.severity !== 'none') return false;
  if (item.blocking !== false) return false;
  if (!isNonEmptyString(item.source)) return false;
  if (!isRelativeRepositoryPath(item.file_path)) return false;
  if (!Number.isInteger(item.line_start) || item.line_start < 1) return false;
  if (!Number.isInteger(item.line_end) || item.line_end < item.line_start) return false;
  if (!isNonEmptyString(item.reason)) return false;
  const identity = `${item.file_path}:${item.line_start}:${item.line_end}:${item.reason}:${item.source}`;
  if (identifiers.has(identity)) return false;
  identifiers.add(identity);
  return true;
}

function validateNonCoverableItems(value) {
  if (!Array.isArray(value)) return false;
  const identifiers = new Set();
  return value.every((item) => validateNonCoverableItem(item, identifiers));
}

function validateEnvelope(value, diffHash) {
  if (!isRecord(value) || value.schema !== ENVELOPE_SCHEMA || value.diff_hash !== diffHash) return false;
  // Contract-fixed absent-means-empty: models repeatedly drop the field
  // wholesale; [] is the only legal meaning, so default before the
  // strict top-level key check rather than discarding the envelope.
  if (value.non_coverable_items === undefined) value.non_coverable_items = [];
  // r32 correctness-2: normalize ONCE at the top so all three kinds —
  // including review_failure — share the same derivable-field contract.
  if (Array.isArray(value.non_coverable_items)) {
    value.non_coverable_items = value.non_coverable_items.map(normalizeNonCoverableItem);
  } else {
    value.non_coverable_items = [];
  }
  if (value.kind === 'confirmed_findings') {
    if (!hasExactKeys(value, TOP_LEVEL_KEYS) || !Array.isArray(value.findings) || value.findings.length === 0) return false;
    value.findings = value.findings.map(normalizeFinding);
    if (!validateNonCoverableItems(value.non_coverable_items)) return false;
    const identifiers = new Set();
    return value.findings.every((finding) => validateFinding(finding, identifiers));
  }
  if (value.kind === 'coverage_required') {
    if (!hasExactKeys(value, COVERAGE_TOP_LEVEL_KEYS)) return false;
    if (!Array.isArray(value.findings) || value.findings.length !== 0) return false;
    if (!Array.isArray(value.coverage_items) || value.coverage_items.length === 0) return false;
    value.coverage_items = value.coverage_items.map(normalizeCoverageItem);
    if (!validateNonCoverableItems(value.non_coverable_items)) return false;
    const identifiers = new Set();
    return value.coverage_items.every((item) => validateCoverageItem(item, identifiers));
  }
  if (value.kind === 'review_failure') {
    return hasExactKeys(value, FAILURE_TOP_LEVEL_KEYS)
      && Array.isArray(value.findings)
      && value.findings.length === 0
      && validateNonCoverableItems(value.non_coverable_items)
      && hasExactKeys(value.failure, FAILURE_KEYS)
      && Object.hasOwn(FAILURE_MESSAGES, value.failure.code)
      && isNonEmptyString(value.failure.message);
  }
  return false;
}

async function badgeEligible(repoRoot) {
  const env = process.env.OMP_REVIEW_KIT_BADGE;
  if (env === '1') return true;
  if (env === '0') return false;
  try {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    return pkg?.name === 'omp-reviewer-kit';
  } catch {
    return false;
  }
}

function failureValue(diffHash, code) {
  return {
    schema: ENVELOPE_SCHEMA,
    kind: 'review_failure',
    diff_hash: diffHash,
    findings: [],
    non_coverable_items: [],
    failure: {
      code,
      message: FAILURE_MESSAGES[code],
    },
  };
}

function blockWithFailure(output, diffHash, code, verdict) {
  return {
    verdict: verdict?.reason === code
      ? verdict
      : new ReviewVerdict(ReviewVerdict.BLOCK, { reason: code, rawOutput: output }),
    envelope: new ReviewRejectionEnvelope(failureValue(diffHash, code)),
  };
}

/**
 * Domain Value Object owning strict caller-readable BLOCK normalization.
 */
export class ReviewRejectionEnvelope {
  static SCHEMA = ENVELOPE_SCHEMA;
  static BEGIN_LINE = BEGIN_LINE;
  static END_LINE = END_LINE;

  #value;

  constructor(value) {
    if (!validateEnvelope(value, value?.diff_hash)) {
      throw new TypeError('Invalid ReviewRejectionEnvelope value');
    }
    this.#value = Object.freeze({
      ...value,
      findings: Object.freeze(value.findings.map((finding) => Object.freeze({ ...finding }))),
      non_coverable_items: Object.freeze(
        value.non_coverable_items.map((item) => Object.freeze({ ...item })),
      ),
      ...(value.coverage_items
        ? {
            coverage_items: Object.freeze(
              value.coverage_items.map((item) =>
                Object.freeze({
                  ...item,
                  required_tests: Object.freeze(item.required_tests.map((test) => Object.freeze({ ...test }))),
                }),
              ),
            ),
          }
        : {}),
      ...(value.failure ? { failure: Object.freeze({ ...value.failure }) } : {}),
    });
  }

  static evaluate({ output, diffIdentity, processStatus, processError }) {
    const rawOutput = typeof output === 'string' ? output : String(output ?? '');
    const diffHash = diffHashOf(diffIdentity);

    if (processStatus !== 0) {
      const verdict = ReviewVerdict.blockDueToFailure(
        isNonEmptyString(processError) ? processError : 'reviewer process exited with non-zero status',
      );
      return blockWithFailure(rawOutput, diffHash, 'execution_failure', verdict);
    }

    const verdict = ReviewVerdict.fromOutput(rawOutput);
    if (verdict.reason === 'missing_verdict_marker') {
      return blockWithFailure(rawOutput, diffHash, 'missing_verdict_marker', verdict);
    }
    if (verdict.reason === 'multiple_verdict_markers') {
      return blockWithFailure(rawOutput, diffHash, 'multiple_verdict_markers', verdict);
    }

    const lines = rawOutput.split(/\r\n|[\n\r\u2028\u2029]/);
    const beginIndexes = [];
    const endIndexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === BEGIN_LINE) beginIndexes.push(index);
      if (lines[index] === END_LINE) endIndexes.push(index);
    }

    if (verdict.isPass()) {
      if (beginIndexes.length > 0 || endIndexes.length > 0) {
        return blockWithFailure(rawOutput, diffHash, 'contradictory_rejection_envelope');
      }
      return { verdict, envelope: null };
    }

    if (beginIndexes.length === 0 && endIndexes.length === 0) {
      return blockWithFailure(rawOutput, diffHash, 'missing_rejection_envelope', verdict);
    }

    const pairs = [];
    let openBegin = -1;
    for (const index of [...beginIndexes, ...endIndexes].sort((a, b) => a - b)) {
      if (beginIndexes.includes(index)) {
        openBegin = index;
      } else if (openBegin >= 0) {
        pairs.push([openBegin, index]);
        openBegin = -1;
      }
    }

    const blockIndex = lines.lastIndexOf('REVIEW_RESULT=BLOCK');
    for (const [beginIndex, endIndex] of pairs) {
      if (endIndex >= blockIndex || blockIndex !== endIndex + 1) continue;
      try {
        const parsed = parseStrictJson(lines.slice(beginIndex + 1, endIndex).join('\n'));
        if (validateEnvelope(parsed, diffHash)) {
          return { verdict, envelope: new ReviewRejectionEnvelope(parsed) };
        }
      } catch {
        // try the next envelope pair
      }
    }
    return blockWithFailure(rawOutput, diffHash, 'malformed_rejection_envelope');
  }

  get schema() {
    return this.#value.schema;
  }

  get kind() {
    return this.#value.kind;
  }

  get diffHash() {
    return this.#value.diff_hash;
  }

  get findings() {
    return this.#value.findings;
  }

  get failure() {
    return this.#value.failure;
  }

  get coverageItems() {
    return this.#value.coverage_items ?? [];
  }

  get nonCoverableItems() {
    return this.#value.non_coverable_items;
  }

  toJSON() {
    return {
      schema: this.#value.schema,
      kind: this.#value.kind,
      diff_hash: this.#value.diff_hash,
      findings: this.#value.findings.map((finding) => ({ ...finding })),
      non_coverable_items: this.#value.non_coverable_items.map((item) => ({ ...item })),
      ...(this.#value.coverage_items
        ? {
            coverage_items: this.#value.coverage_items.map((item) => ({
              ...item,
              required_tests: item.required_tests.map((test) => ({ ...test })),
            })),
          }
        : {}),
      ...(this.#value.failure ? { failure: { ...this.#value.failure } } : {}),
    };
  }

  toString() {
    return JSON.stringify(this.toJSON(), null, 2);
  }
}

export function sanitizePromptToken(value) {
  if (typeof value !== 'string') return '';
  // C0 + DEL + full C1 range, NEL/CSI included as named members of it;
  // Unicode line/paragraph separators; bidi marks (embeddings, overrides,
  // isolates); zero-width and word-joiner characters; variation selectors;
  // TAG characters (U+E0000-E007F, supplement U+E0100-E01EF) and deprecated
  // format marks (ALM U+061C, Mongolian FVS U+180E); BOM. Legal filename
  // bytes that can inject terminal escapes or spoof path lists must never
  // reach prompts/log lines raw.
  return value.replace(/[\x00-\x1f\x7f-\x9f\u00ad\u034f\u070f\u061c\u17b4-\u17b5\u180e\u2028\u2029\u202a-\u202e\u200b-\u200f\u2060-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u115f-\u1160\u3164\uffa0\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    switch (cp) {
      case 0x0a: return '\\n';
      case 0x0d: return '\\r';
      case 0x09: return '\\t';
      default: return cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\u{${cp.toString(16)}}`;
    }
  });
}

const MAX_SYMBOLS = 40;
const MIN_SYMBOL_LENGTH = 4;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_HITS_PER_SYMBOL = 5;
const MAX_TESTS_PER_FILE = 6;
const MAX_LINE_CHARS = 140;
const MAX_PACK_CHARS = 60_000;

const SYMBOL_STOP_WORDS = new Set([
  'function', 'constructor', 'return', 'static', 'async', 'await', 'export', 'default', 'import', 'from',
  'class', 'const', 'else', 'this', 'true', 'false', 'null', 'undefined', 'void', 'main', 'test', 'describe',
  'expect', 'assert', 'switch', 'catch', 'while', 'yield', 'typeof', 'self', 'args', 'data', 'result', 'value',
  'index', 'name', 'path', 'text', 'type', 'error', 'items', 'list', 'file', 'files', 'line', 'lines',
]);

// One pattern per declaration style; group 1 is the declared name.
const DECLARATION_PATTERNS = [
  /\bfunction\*?\s+([A-Za-z_$][\w$]*)/,
  /\bclass\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?#?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
  /\bdef\s+([A-Za-z_]\w*)\s*\(/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /\bfn\s+([A-Za-z_]\w*)/,
  /\binterface\s+([A-Za-z_$][\w$]*)/,
  /\btype\s+([A-Za-z_$][\w$]*)\s*=/,
];

function symbolsFromLine(line) {
  const found = [];
  for (const pattern of DECLARATION_PATTERNS) {
    const match = pattern.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

function acceptableSymbol(name) {
  return name.length >= MIN_SYMBOL_LENGTH && !SYMBOL_STOP_WORDS.has(name.toLowerCase());
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names declared, changed or removed by the diff: the symbols whose users the
 * reviewer has to look at. Taken from added and removed declaration lines and
 * from the enclosing-scope text git prints after `@@` hunk headers.
 *
 * @param {string} diffText
 * @returns {{ name: string, path: string }[]}
 */
export function changedSymbols(diffText) {
  const seen = new Map();
  const add = (name, path) => {
    if (seen.size >= MAX_SYMBOLS || !acceptableSymbol(name) || seen.has(name)) return;
    seen.set(name, path);
  };
  for (const block of parseDiffBlocks(diffText)) {
    for (const line of [...block.addedLines, ...block.removedLines]) {
      for (const name of symbolsFromLine(line)) add(name, block.path);
    }
  }
  // Hunk-header scope text names the function a hunk sits in, which a body
  // edit never declares.
  for (const raw of diffText.split(/^diff --git /m).slice(1)) {
    const { oldPath, newPath } = diffBlockPaths(raw);
    const path = newPath ?? oldPath;
    if (!path) continue;
    for (const header of raw.matchAll(/^@@ [^@]*@@ ?(.*)$/gm)) {
      for (const name of symbolsFromLine(header[1])) add(name, path);
    }
  }
  return [...seen].map(([name, path]) => ({ name, path }));
}

function lineNumberAt(text, index, cursor) {
  let { line, offset } = cursor;
  for (let i = offset; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  cursor.line = line;
  cursor.offset = index;
  return line;
}

function clip(line) {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}...` : trimmed;
}

/**
 * Deterministic context for the scout: what changed, who uses the changed
 * symbols, and which tests touch the changed files. Built from the staged
 * snapshot alone, no model involved, so it is identical for identical input.
 *
 * @param {{ files: { path: string, content: Buffer }[], diffText: string, changedPaths: string[], fileClasses?: { path: string, fileClass: string }[], testPathPatterns?: string[] }} input
 * @returns {{ text: string, stats: { symbols: number, referencedSymbols: number, mappedFiles: number, truncated: boolean } }}
 */
export function buildContextPack({ files, diffText, changedPaths, fileClasses = [], testPathPatterns } = {}) {
  const classByPath = new Map(fileClasses.map((entry) => [entry.path, entry.fileClass]));
  const isTest = (p) => isTestPath(p, testPathPatterns);
  const blocks = new Map(parseDiffBlocks(diffText).map((block) => [block.path, block]));
  const contentByPath = new Map();
  let scanned = 0;
  let scanTruncated = false;
  for (const file of files) {
    if (file.path.startsWith('.review/')) continue;
    if (file.content.length > MAX_FILE_BYTES || file.content.includes(0)) continue;
    if (scanned + file.content.length > MAX_SCAN_BYTES) {
      scanTruncated = true;
      break;
    }
    scanned += file.content.length;
    contentByPath.set(file.path, file.content.toString('utf8'));
  }

  const lines = [
    '# Review context pack',
    '',
    'Deterministic input built by the runner from the staged snapshot (no model involved). Start here: it replaces broad repository sweeps. Verify a hit against the file before relying on it.',
    '',
    '## Changed files',
    '| path | class | status | +added / -removed | lines |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const changed of changedPaths) {
    const block = blocks.get(changed);
    const content = contentByPath.get(changed);
    const status = block?.deleted ? 'deleted' : content === undefined ? 'binary-or-large' : 'present';
    lines.push(`| \`${changed}\` | ${classByPath.get(changed) ?? '-'} | ${status} | +${block?.addedLines.length ?? 0} / -${block?.removedLines.length ?? 0} | ${content === undefined ? '-' : content.split('\n').length} |`);
  }

  const symbols = changedSymbols(diffText);
  lines.push('', '## Changed symbols and who references them', '');
  if (symbols.length === 0) {
    lines.push('No declared symbol was added, changed or removed by the diff.');
  }
  const definingPaths = new Map(symbols.map((s) => [s.name, s.path]));
  const hits = new Map(symbols.map((s) => [s.name, { total: 0, files: new Set(), shown: [], tests: [] }]));
  if (symbols.length > 0) {
    const combined = new RegExp(`(?<![\\w$])(?:${symbols.map((s) => escapeRegex(s.name)).join('|')})(?![\\w$])`, 'g');
    for (const [filePath, text] of contentByPath) {
      const cursor = { line: 1, offset: 0 };
      for (const match of text.matchAll(combined)) {
        const entry = hits.get(match[0]);
        entry.total += 1;
        entry.files.add(filePath);
        if (filePath === definingPaths.get(match[0])) continue;
        const target = isTest(filePath) ? entry.tests : entry.shown;
        if (target.length >= MAX_HITS_PER_SYMBOL || target.some((hit) => hit.path === filePath)) continue;
        const lineNo = lineNumberAt(text, match.index, cursor);
        const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        target.push({ path: filePath, line: lineNo, text: clip(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)) });
      }
    }
  }
  let referenced = 0;
  for (const { name, path } of symbols) {
    const entry = hits.get(name);
    if (entry.total > 0) referenced += 1;
    lines.push(`- \`${name}\` (declared in \`${path}\`): ${entry.total} reference(s) in ${entry.files.size} file(s)`);
    for (const hit of entry.shown) lines.push(`  - \`${hit.path}:${hit.line}\` ${hit.text}`);
    for (const hit of entry.tests) lines.push(`  - test \`${hit.path}:${hit.line}\` ${hit.text}`);
  }

  lines.push('', '## Test mapping', '');
  const testFiles = [...contentByPath.keys()].filter(isTest);
  const symbolsByPath = new Map();
  for (const { name, path } of symbols) symbolsByPath.set(path, [...(symbolsByPath.get(path) ?? []), name]);
  let mapped = 0;
  for (const changed of changedPaths) {
    if (isTest(changed)) continue;
    const stem = changed.split('/').pop().replace(/\.[^.]+$/, '');
    const needles = [stem, ...(symbolsByPath.get(changed) ?? [])].filter((n) => n.length >= 3);
    const covering = [];
    for (const testPath of testFiles) {
      if (testPath === changed) continue;
      const text = contentByPath.get(testPath);
      const matched = needles.find((needle) => new RegExp(`(?<![\\w$])${escapeRegex(needle)}(?![\\w$])`).test(text));
      if (matched) covering.push({ testPath, matched });
      if (covering.length >= MAX_TESTS_PER_FILE) break;
    }
    mapped += covering.length > 0 ? 1 : 0;
    lines.push(covering.length > 0
      ? `- \`${changed}\` is referenced by: ${covering.map((c) => `\`${c.testPath}\` (via \`${c.matched}\`)`).join(', ')}`
      : `- \`${changed}\`: no test file in the snapshot mentions it or its changed symbols`);
  }
  const changedTests = changedPaths.filter(isTest);
  if (changedTests.length > 0) lines.push('', `Changed test files: ${changedTests.map((p) => `\`${p}\``).join(', ')}`);
  if (scanTruncated) lines.push('', `Note: the snapshot scan stopped at ${MAX_SCAN_BYTES} bytes; references from unscanned files are missing.`);

  let text = `${lines.join('\n')}\n`;
  const truncated = text.length > MAX_PACK_CHARS;
  if (truncated) text = `${text.slice(0, MAX_PACK_CHARS)}\n\n[context pack truncated at ${MAX_PACK_CHARS} characters]\n`;
  return { text, stats: { symbols: symbols.length, referencedSymbols: referenced, truncated, mappedFiles: mapped } };
}

const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'init', '__init__', 'readme', 'package', 'config', 'types', 'utils', 'helpers']);

/**
 * Grouping key of a changed file: a source file and its tests share one key
 * (`src/total.mjs`, `tests/total.test.mjs`, `test_total.py` -> `total`), so a
 * shard keeps a behavior and the tests that pin it together. Generic names
 * never merge across directories.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function shardGroupKey(filePath) {
  const parts = filePath.split('/');
  const base = parts.pop().toLowerCase();
  const stem = base
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](?:test|tests|spec)$/, '')
    .replace(/^test[._-]/, '');
  return GENERIC_STEMS.has(stem) ? filePath.toLowerCase() : stem;
}

/**
 * Splits a large diff into file groups of similar size so several hunters can
 * work in parallel. Deterministic: same diff, same plan. Returns null when the
 * diff is small enough for one hunter, when sharding is disabled, or when the
 * files form fewer than two groups.
 *
 * @param {{ diffText: string, thresholdBytes: number, maxShards: number }} input
 * @returns {{ totalBytes: number, shards: { index: number, files: string[], bytes: number }[] }|null}
 */
export function planHunterShards({ diffText, thresholdBytes, maxShards }) {
  if (!Number.isInteger(thresholdBytes) || thresholdBytes <= 0 || !Number.isInteger(maxShards) || maxShards < 2) return null;
  const text = String(diffText ?? '');
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= thresholdBytes) return null;

  const groups = new Map();
  for (const raw of text.split(/^diff --git /m).slice(1)) {
    const { oldPath, newPath } = diffBlockPaths(raw);
    const filePath = newPath ?? oldPath;
    if (!filePath) continue;
    const key = shardGroupKey(filePath);
    const group = groups.get(key) ?? { files: new Set(), bytes: 0 };
    group.files.add(filePath);
    group.bytes += Buffer.byteLength(raw);
    groups.set(key, group);
  }
  const ordered = [...groups.values()]
    .map((group) => ({ files: [...group.files].sort(), bytes: group.bytes }))
    .sort((a, b) => b.bytes - a.bytes || (a.files[0] < b.files[0] ? -1 : 1));
  const shardCount = Math.min(maxShards, Math.ceil(totalBytes / thresholdBytes), ordered.length);
  if (shardCount < 2) return null;

  const shards = Array.from({ length: shardCount }, () => ({ files: [], bytes: 0 }));
  for (const group of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.bytes < best.bytes ? shard : best));
    lightest.files.push(...group.files);
    lightest.bytes += group.bytes;
  }
  return {
    totalBytes,
    shards: shards.map((shard, i) => ({ index: i + 1, files: shard.files.sort(), bytes: shard.bytes })),
  };
}

/**
 * Prompt block instructing the orchestrator to run one correctness hunter per shard.
 *
 * @param {{ totalBytes: number, shards: { index: number, files: string[], bytes: number }[] }} plan
 * @returns {string}
 */
export function formatHunterShards(plan) {
  const count = plan.shards.length;
  return [
    `HUNTER SHARDS for the correctness lane (the staged diff is ${plan.totalBytes} bytes, too large for one hunter): spawn ${count} blocking review-risk-hunter tasks for the correctness lane instead of one, all in the same batch as the other lanes, one per shard below. Every hunter task text carries its shard header, the full scout report, and the shared digest.`,
    ...plan.shards.map((shard) => `- Shard ${shard.index}/${count} (${shard.bytes} diff bytes): ${shard.files.map((f) => sanitizePromptToken(f)).join(', ')}`),
    `Shard rules: (1) Each hunter hunts defects whose location is in its shard files and emits \`candidate_id\` values of the form \`correctness-s<shard>-<ordinal>\` (for example \`correctness-s2-1\`); (2) a hunter may read any other staged file to verify a cross-file contract of its shard's changes, but must not emit a candidate located only in another shard's files; (3) \`coverage_gaps\` and the Neuroslop pass cover only the scout coverage_map entries and assertions of the hunter's own shard files; (4) the shared digest is a single block you write once before spawning, at most 15 lines, listing every changed path with its shard number and the cross-shard contracts from the scout report (callers and callees whose files sit in different shards), and every hunter task embeds it verbatim; (5) after the batch returns, merge the candidate lists and coverage_gaps of all shards into one list for the verifier, dropping exact duplicates (same file, line range and defect), and tell the verifier which shard each candidate came from.`,
  ].join('\n');
}

/**
 * Domain specification and builder for reviewer agent prompt instructions.
 */
export class ReviewPrompt {
  #snapshotDir;
  #diffHash;
  #changedPaths;
  #suspicionMapText;
  #inlineDiff;
  #reviewProfile;
  #fileClasses;
  #executionEvidenceText;
  #roundContextText;
  #scoutBaselineText;
  #reportPath;
  #contextPackPath;
  #riskLanes;
  #hunterShardsText;
  #reemitOutput;
  #repairEnvelope = false;

  constructor(diffHash, snapshotDir = '', changedPaths = [], extras = {}) {
    if (!diffHash || typeof diffHash !== 'string') {
      throw new TypeError('ReviewPrompt requires a non-empty diff hash string');
    }
    if (typeof snapshotDir !== 'string') {
      throw new TypeError('ReviewPrompt snapshotDir must be a string');
    }
    if (!Array.isArray(changedPaths)) {
      throw new TypeError('ReviewPrompt changedPaths must be an array');
    }
    this.#diffHash = diffHash;
    this.#snapshotDir = snapshotDir;
    this.#changedPaths = changedPaths;
    this.#suspicionMapText = typeof extras?.suspicionMapText === 'string' ? extras.suspicionMapText : '';
    this.#executionEvidenceText = typeof extras?.executionEvidenceText === 'string' ? extras.executionEvidenceText : '';
    this.#roundContextText = typeof extras?.roundContextText === 'string' ? extras.roundContextText : '';
    this.#scoutBaselineText = typeof extras?.scoutBaselineText === 'string' ? extras.scoutBaselineText : '';
    this.#inlineDiff = typeof extras?.inlineDiff === 'string' && extras.inlineDiff.length > 0 ? extras.inlineDiff : null;
    this.#reviewProfile = typeof extras?.reviewProfile === 'string' ? extras.reviewProfile : null;
    this.#fileClasses = Array.isArray(extras?.fileClasses) ? extras.fileClasses : [];
    this.#reportPath = typeof extras?.reportPath === 'string' && extras.reportPath.length > 0 ? extras.reportPath : null;
    this.#contextPackPath = typeof extras?.contextPackPath === 'string' && extras.contextPackPath.length > 0 ? extras.contextPackPath : null;
    this.#hunterShardsText = typeof extras?.hunterShardsText === 'string' ? extras.hunterShardsText : '';
    this.#riskLanes = Array.isArray(extras?.riskLanes) && extras.riskLanes.length > 0 ? extras.riskLanes.filter((l) => typeof l === 'string' && l.length > 0) : null;
  }
  static forDiff(target, snapshotDir = '', changedPaths = [], extras = {}) {
    const hash = target instanceof DiffIdentity ? target.hash : target;
    const paths = target instanceof DiffIdentity ? target.changedPaths : changedPaths;
    return new ReviewPrompt(hash, snapshotDir, paths, extras);
  }

  /**
   * Builds the bounded verbatim re-emit re-prompt used to recover a completed
   * review whose output carried no standalone REVIEW_RESULT marker.
   *
   * @param {string} originalOutput
   * @returns {ReviewPrompt}
   */
  static forReemit(originalOutput, { repairEnvelope = false } = {}) {
    const prompt = new ReviewPrompt('verbatim-reemit');
    prompt.#repairEnvelope = repairEnvelope === true;
    prompt.#reemitOutput = String(originalOutput ?? '');
    return prompt;
  }

  toString() {
    if (this.#reemitOutput !== undefined) return this.#toReemitString();
    const lines = [
      'You are the OMP headless review dispatcher.',
      'Run exactly one native task with agent "reviewer-kit".',
      'Your next tool call must be the native task tool directly; do not use eval or JavaScript to dispatch it.',
      'Do not review the change yourself.',
      'The task must inspect only the current staged Git change.',
      'The task must execute the multi-stage review protocol from skill://multi-stage-review and skill://reality-first-review, reading only relevant project or user review skills discovered by OMP.',
      'The task must run exactly the risk lanes named below under "Risk lanes for this diff" (each lane = one blocking review-risk-hunter task in a single batch). A lane list of ["correctness","security"] restores both standard lanes; only the correctness lane inspects focused tests and YAGNI, and only when a concrete reachable P1/P2 impact is proven.',
      'The task must not edit, stage, reset, commit, or delete anything.',
      'Invoke the task with only the supported name, agent, and task fields; omit model, outputSchema, schemaMode, and isolated so the reviewer agent owns its declared schema and model roles.',
      'After the task returns, reproduce its complete report verbatim; if the result says it was truncated or provides an agent URI, read that URI first, and never summarize or omit a rejection envelope. If the agent URI cannot be read, read the durable report copy at the per-run report path named in this prompt (the orchestrator writes it before yielding — pass that path to the reviewer-kit task in its task text) and reproduce that file verbatim instead.',
      'If the task fails, returns empty, or its result cannot be read, do not summarize: emit exactly one review_failure envelope — the line REVIEW_REJECTION_ENVELOPE_BEGIN, then one JSON object {"schema":"review-rejection-envelope@1","kind":"review_failure","diff_hash":"<the staged diff hash from this prompt>","findings":[],"non_coverable_items":[],"failure":{"code":"execution_failure","message":"<the observed task error>"}}, then REVIEW_REJECTION_ENVELOPE_END, then REVIEW_RESULT=BLOCK on its own line.',
      'Reproduce the task report as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it.',
      'The verdict contract in this prompt overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line as the last non-empty line of the output — markers anywhere else are ignored — even if a skill describes a different verdict vocabulary.',
    ];
    if (this.#inlineDiff) {
      lines.push(
        `The staged snapshot directory is ${this.#snapshotDir}.`,
        'The complete staged diff is inlined below between the STAGED DIFF markers — it is authoritative. You MUST NOT run git diff, git show, or git cat-file to obtain review content; the snapshot directory is for reading full source files only.',
        'Embed the inline diff verbatim into every subagent task text: the context scout keeps file paths for repository context, while both risk hunters and the verifier receive the diff inline instead of the .review/diff.patch path.',
        'Read every source file from that staged snapshot directory, never from the working tree. Use the repository only for read-only Git metadata and project skill discovery.',
        '---STAGED DIFF (inline, authoritative)---',
        this.#inlineDiff,
        '---END STAGED DIFF---',
      );
    } else if (this.#snapshotDir) {
      lines.push(
        `The staged snapshot directory is ${this.#snapshotDir}.`,
        `The complete staged diff is materialized at ${this.#snapshotDir}/.review/diff.patch and the changed-file list at ${this.#snapshotDir}/.review/changed-files.txt. Read them as files; do not run git diff or git show to obtain review content.`,
        'Read every source file from that staged snapshot directory, never from the working tree. Use the repository only for read-only Git metadata and project skill discovery.',
      );
    }
    if (this.#changedPaths.length > 0) {
      lines.push(
        `The changed paths for this review are: ${this.#changedPaths.map((p) => sanitizePromptToken(p)).join(', ')}.`,
        'Pass these paths to the context scout in its task text so it does not re-derive them from the diff.',
      );
    }
    if (this.#fileClasses.length > 0) {
      const classLines = this.#fileClasses.map((e) => `${sanitizePromptToken(e?.path)}: ${sanitizePromptToken(e?.fileClass)}`);
      lines.push(
        'File-class manifest (deterministic path-only classification, materialized at .review/file-classes.json):',
        ...classLines,
      );
    }
    if (this.#contextPackPath) {
      lines.push(
        `A deterministic context pack for the scout is at \`${this.#contextPackPath}\`: changed files, changed symbols with who references them, and the test-file mapping, all built by the runner from the staged snapshot.`,
        'Pass that path to the context scout in its task text: the scout starts from the pack and finishes in a few batches of tool calls instead of sweeping the repository. The pack is read-only input; never write to it.',
      );
    }
    if (this.#suspicionMapText) {
      lines.push('', this.#suspicionMapText);
    }
    if (this.#executionEvidenceText) {
      lines.push('', this.#executionEvidenceText);
    }
    if (this.#roundContextText) {
      lines.push('', this.#roundContextText);
    }
    if (this.#scoutBaselineText) {
      lines.push('', 'Embed the SCOUT BASELINE block below verbatim in the context scout task text only (not in the hunter or verifier tasks):', this.#scoutBaselineText);
    }
    lines.push(`The staged diff hash for this hook invocation is ${this.#diffHash}.`);
    if (this.#reportPath) lines.push(`The durable per-run report path for this review is \`${this.#reportPath}\`. Instruct the reviewer-kit task to write its complete final report verbatim to that path before yielding, as a best-effort durable copy: if a project policy guard denies the write, the task must not retry or work around it, because the runner recovers the report from the task session artifacts. It is the only path the task may write.`);
    if (this.#reviewProfile) lines.push(`Review profile for this diff: ${this.#reviewProfile}.`);
    if (Array.isArray(this.#riskLanes)) lines.push(`Risk lanes for this diff: ${JSON.stringify(this.#riskLanes)}.`);
    if (this.#hunterShardsText) lines.push(this.#hunterShardsText);
    return lines.join('\n');
  }

  #toReemitString() {
    const repair = this.#repairEnvelope
      ? 'The original verdict is BLOCK and must stay BLOCK: change no finding, priority, or verdict. Its rejection envelope is missing or malformed, so the output must contain exactly one valid envelope — the line REVIEW_REJECTION_ENVELOPE_BEGIN, one strict JSON object of schema review-rejection-envelope@1 describing exactly the findings already reported, the line REVIEW_REJECTION_ENVELOPE_END — immediately followed by the standalone REVIEW_RESULT=BLOCK line. ' : '';
    return repair + 'Reproduce the following review report verbatim as raw Markdown text exactly as returned; never JSON-encode, wrap, or reformat it. The verdict contract overrides any other format: finish with exactly one standalone REVIEW_RESULT=PASS or REVIEW_RESULT=BLOCK line as the last non-empty line of the output — markers anywhere else are ignored — even if the input describes a different verdict vocabulary.\n\n---ORIGINAL OUTPUT---\n' + this.#reemitOutput;
  }

  get diffHash() {
    return this.#diffHash;
  }

  get reportPath() {
    return this.#reportPath;
  }

  get snapshotDir() {
    return this.#snapshotDir;
  }

  get changedPaths() {
    return [...this.#changedPaths];
  }

  get suspicionMapText() {
    return this.#suspicionMapText;
  }

  get executionEvidenceText() {
    return this.#executionEvidenceText;
  }

  get contextPackPath() {
    return this.#contextPackPath;
  }

  get scoutBaselineText() {
    return this.#scoutBaselineText;
  }

  get hunterShardsText() {
    return this.#hunterShardsText;
  }

  get roundContextText() {
    return this.#roundContextText;
  }
}

/**
 * Domain Entity representing an audit report artifact.
 */
export class ReviewReport {
  #diffHash;
  #verdict;
  #rawOutput;
  #modelsTried;
  #verifiedOk;
  #envelope;
  #timestamp;

  constructor({ diffIdentity, verdict, rawOutput = '', modelsTried, verifiedOk = [], envelope = null, timestamp = new Date() }) {
    this.#diffHash = diffIdentity instanceof DiffIdentity ? diffIdentity.hash : String(diffIdentity);
    this.#verdict = verdict instanceof ReviewVerdict ? verdict.value : String(verdict);
    this.#rawOutput = rawOutput;
    this.#modelsTried = Array.isArray(modelsTried) ? modelsTried.filter((m) => typeof m === 'string') : undefined;
    if (!Array.isArray(verifiedOk) || verifiedOk.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      throw new TypeError('verifiedOk must be an array of non-empty strings');
    }
    this.#verifiedOk = Object.freeze(verifiedOk.map((item) => item.trim()));
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
    this.#timestamp = timestamp instanceof Date ? timestamp : new Date(timestamp);
  }

  static formatTimestamp(date) {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  get filename() {
    const stamp = ReviewReport.formatTimestamp(this.#timestamp);
    return `${stamp}-${this.#diffHash}.md`;
  }

  toMarkdown() {
    const lines = [
      '# OMP Review Kit commit review',
      '',
      `- staged diff hash: ${this.#diffHash}`,
      `- result: ${this.#verdict}`,
    ];
    if (this.#modelsTried && this.#modelsTried.length > 0) {
      lines.push(`- reviewer models tried: ${this.#modelsTried.join(', ')}`);
    }
    if (this.#envelope) {
      lines.push('', '## Normalized rejection envelope', '', '```json', this.#envelope.toString(), '```');
    }
    const rawOutput = this.#rawOutput.trim();
    if (this.#verifiedOk.length > 0 && !/^### Verified-OK\s*$/m.test(rawOutput)) {
      lines.push('', '### Verified-OK', ...this.#verifiedOk.map((item) => `- ${item}`));
    }
    lines.push('', rawOutput, '');
    return lines.join('\n');
  }

  get diffHash() {
    return this.#diffHash;
  }

  get verdict() {
    return this.#verdict;
  }

  get rawOutput() {
    return this.#rawOutput;
  }

  get modelsTried() {
    return this.#modelsTried;
  }

  get verifiedOk() {
    return this.#verifiedOk;
  }

  get envelope() {
    return this.#envelope;
  }

  get timestamp() {
    return this.#timestamp;
  }
}

export class ReviewExecutionResult {
  #exitCode;
  #skipped;
  #verdict;
  #reportPath;
  #details;
  #modelsTried;
  #envelope;

  /**
   * @param {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   details?: string,
   *   modelsTried?: string[],
   *   envelope?: ReviewRejectionEnvelope|null
   * }} params
   */
  constructor({ exitCode, skipped, verdict, reportPath, details, modelsTried, envelope = null }) {
    this.#exitCode = exitCode;
    this.#skipped = skipped;
    this.#verdict = verdict;
    this.#reportPath = reportPath;
    this.#details = details;
    if (modelsTried !== undefined && (!Array.isArray(modelsTried) || modelsTried.some((model) => typeof model !== 'string'))) {
      throw new TypeError('modelsTried must be an array of strings');
    }
    this.#modelsTried = modelsTried;
    if (envelope !== null && !(envelope instanceof ReviewRejectionEnvelope)) {
      throw new TypeError('envelope must be a ReviewRejectionEnvelope or null');
    }
    this.#envelope = envelope;
  }

  /**
   * Factory for clean commits with no staged modifications.
   *
   * @returns {ReviewExecutionResult}
   */
  static skipped() {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: true,
    });
  }

  /**
   * Factory for approved changes.
   *
   * @param {string} reportPath
   * @param {'PASS'} [verdict='PASS']
   * @param {string[]} [modelsTried]
   * @returns {ReviewExecutionResult}
   */
  static pass(reportPath, verdict = 'PASS', modelsTried) {
    return new ReviewExecutionResult({
      exitCode: 0,
      skipped: false,
      verdict,
      reportPath,
      modelsTried,
    });
  }

  /**
   * Factory for rejected changes.
   *
   * @param {string} [reportPath]
   * @param {string} [details]
   * @param {string[]} [modelsTried]
   * @param {ReviewRejectionEnvelope} envelope
   * @returns {ReviewExecutionResult}
   */
  static block(reportPath, details = '', modelsTried, envelope) {
    return new ReviewExecutionResult({
      exitCode: 1,
      skipped: false,
      verdict: 'BLOCK',
      reportPath,
      details,
      modelsTried,
      envelope,
    });
  }

  get exitCode() {
    return this.#exitCode;
  }

  get skipped() {
    return this.#skipped;
  }

  get verdict() {
    return this.#verdict;
  }

  get reportPath() {
    return this.#reportPath;
  }

  get details() {
    return this.#details;
  }

  get modelsTried() {
    return this.#modelsTried;
  }

  get envelope() {
    return this.#envelope;
  }

  /**
   * Plain object representation for backward-compatible consumption.
   *
   * @returns {{
   *   exitCode: number,
   *   skipped: boolean,
   *   verdict?: 'PASS'|'BLOCK',
   *   reportPath?: string,
   *   details?: string,
   *   modelsTried?: string[],
   *   envelope?: object
   * }}
   */
  toJSON() {
    const obj = {
      exitCode: this.#exitCode,
      skipped: this.#skipped,
    };
    if (this.#verdict !== undefined) obj.verdict = this.#verdict;
    if (this.#reportPath !== undefined) obj.reportPath = this.#reportPath;
    if (this.#details !== undefined) obj.details = this.#details;
    if (this.#modelsTried !== undefined && this.#modelsTried.length > 0) {
      obj.modelsTried = this.#modelsTried;
    }
    if (this.#envelope) obj.envelope = this.#envelope.toJSON();
    return obj;
  }
}

export class GitPort {
  getRepoRoot(cwd) {
    throw new Error('GitPort.getRepoRoot must be implemented');
  }

  getStagedDiff(repoRoot) {
    throw new Error('GitPort.getStagedDiff must be implemented');
  }

  getSnapshot(repoRoot) {
    throw new Error('GitPort.getSnapshot must be implemented');
  }

  getHeadFile(repoRoot, path) {
    throw new Error('GitPort.getHeadFile must be implemented');
  }

  /**
   * Object id of the staged index tree (`git write-tree`), or null when it
   * cannot be determined (e.g. unmerged entries). Optional capability.
   *
   * @param {string} repoRoot
   * @returns {Promise<string|null>|string|null}
   */
  getIndexTree(repoRoot) {
    throw new Error('GitPort.getIndexTree must be implemented');
  }

  /**
   * HEAD commit id, or null on an unborn branch. Optional capability.
   *
   * @param {string} repoRoot
   * @returns {Promise<string|null>|string|null}
   */
  getHeadSha(repoRoot) {
    throw new Error('GitPort.getHeadSha must be implemented');
  }
}

export class SnapshotStorePort {
  create(snapshot, artifacts) {
    throw new Error('SnapshotStorePort.create must be implemented');
  }

  remove(snapshotDir) {
    throw new Error('SnapshotStorePort.remove must be implemented');
  }

  /**
   * Optional: releases an in-use marker without deleting the directory.
   * Implementations that retain created dirs as cache entries may override;
   * callers feature-detect the method.
   */
  async release(snapshotDir) {}
}

export class ExecutionPort {
  run({ command, cwd, timeoutMs }) {
    throw new Error('ExecutionPort.run must be implemented');
  }
}

export class ReviewerPort {
  executeReview(params) {
    throw new Error('ReviewerPort.executeReview must be implemented');
  }

  /**
   * Re-emits a completed review output verbatim through one bounded no-tools
   * re-prompt on the same model. Recovery path for exit-0 reviews that
   * produced output but no standalone REVIEW_RESULT marker.
   *
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string,
   *   timeoutMs?: number,
   *   telemetry?: { record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> },
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number, attempts: object[] }>}
   */
  reemitVerbatim(params) {
    throw new Error('ReviewerPort.reemitVerbatim must be implemented');
  }
}

export class ReportStorePort {
  saveReport(repoRoot, report) {
    throw new Error('ReportStorePort.saveReport must be implemented');
  }
}

/**
 * Port remembering reusable PASS verdicts keyed by staged tree + diff hash.
 */
export class RoundStorePort {
  /** @param {string} repoRoot @returns {Promise<object|null>|object|null} */
  load(repoRoot) {
    throw new Error('RoundStorePort.load must be implemented');
  }

  /** @param {string} repoRoot @param {object} record @returns {Promise<void>|void} */
  save(repoRoot, record) {
    throw new Error('RoundStorePort.save must be implemented');
  }

  /** @param {string} repoRoot @returns {Promise<void>|void} */
  clear(repoRoot) {
    throw new Error('RoundStorePort.clear must be implemented');
  }
}

export class VerdictCachePort {
  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string }} key
   * @returns {Promise<{ reportPath: string, at: string }|null>|{ reportPath: string, at: string }|null}
   */
  lookup(key) {
    throw new Error('VerdictCachePort.lookup must be implemented');
  }

  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string, reportPath: string }} entry
   * @returns {Promise<void>|void}
   */
  record(entry) {
    throw new Error('VerdictCachePort.record must be implemented');
  }
}

/**
 * Port representing the run telemetry sink factory.
 * A port creates a run-scoped sink per review; the sink persists observability
 * events and the live/last-run state without ever influencing the verdict.
 *
 * @interface
 */
export class TelemetryPort {
  /**
   * @param {{ repoRoot: string, runId: string }} context
   * @returns {RunTelemetry-like sink with record() and updateLastRun()}
   */
  forRun(context) {
    throw new Error('TelemetryPort.forRun must be implemented');
  }
}

/**
 * Signal guard for review runs.
 * Traps SIGINT / SIGTERM to record failure telemetry and update live state
 * before forcing process termination.
 */

/**
 * Creates an interruption signal handler that updates telemetry and exits.
 *
 * @param {{
 *   telemetry?: { record?: (type: string, payload?: object) => Promise<void>, updateLastRun?: (state: object, opts?: { force?: boolean }) => Promise<void> },
 *   runId?: string,
 *   exit?: (code: number) => void,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {(signal: string) => Promise<void>}
 */
export function createSignalHandler({
  telemetry,
  runId,
  cleanup,
  exit = process.exit,
  timeoutMs = 500,
} = {}) {
  return async function handler(signal) {
    const error = `interrupted by signal ${signal}`;
    const code = signal === 'SIGTERM' ? 143 : 130;

    const telemetryWork = (async () => {
      try {
        await telemetry?.record?.('run_failed', { error });
      } catch {
        // Telemetry calls must never throw out of the handler
      }
      try {
        await telemetry?.updateLastRun?.({
          state: 'interrupted',
          error,
          runId,
          finishedAt: new Date().toISOString(),
          exitCode: 1,
        }, { force: true });
      } catch {
        // Telemetry calls must never throw out of the handler
      }
      // Snapshot dirs are removed here because exit() below never returns,
      // so the normal finally cleanup cannot run.
      try {
        await cleanup?.();
      } catch {
        // Cleanup must never throw out of the handler
      }
    })();

    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    });

    try {
      await Promise.race([telemetryWork, timeoutPromise]);
    } catch {
      // Guard against any race rejection
    } finally {
      clearTimeout(timer);
    }

    try {
      exit(code);
    } catch {
      // Guard against injectable exit throwing
    }
  };
}

/**
 * Installs one-shot SIGINT/SIGTERM handlers for a review run.
 *
 * @param {{
 *   telemetry?: { record?: (type: string, payload?: object) => Promise<void>, updateLastRun?: (state: object, opts?: { force?: boolean }) => Promise<void> },
 *   runId?: string,
 *   exit?: (code: number) => void,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {() => void}
 */
export function installRunSignalGuard({
  telemetry,
  runId,
  cleanup,
  exit = process.exit,
  timeoutMs = 500,
} = {}) {
  // Accepted E10 race: OS pid reuse can theoretically misattribute liveness — safety-neutral, verdict path untouched.
  const handler = createSignalHandler({ telemetry, runId, cleanup, exit, timeoutMs });

  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);

  return function uninstall() {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}

// Per-process run sequence so two concurrent execute() calls on identical
// staged content never share one runReportPath within a millisecond tick.
let REPORT_SEQ = 0;

/**
 * Decides how a snapshot dir is disposed when a run ends (normally or by
 * signal): transient mkdtemp dirs are destroyed (`remove`); the deterministic
 * content-addressed reuseDir only drops the caller's lease (`release`) so a
 * concurrent review serving from it — or a later retry — keeps its input.
 *
 * @param {string} snapshotDir
 * @param {string|null} reuseDir
 * @returns {'remove'|'release'}
 */
export function snapshotDirDisposition(snapshotDir, reuseDir) {
  return snapshotDir !== reuseDir ? 'remove' : 'release';
}

// Lease heartbeat period: reviews outliving the 24h marker TTL refresh
// their `.live-<pid>` marker this often, keeping sweep protection whole.
const LEASE_REFRESH_MS = 15 * 60 * 1000;
const ROUND_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ROUND_MAX_DIFF_CHARS = 2_000_000;

/**
 * Renders a path for committed observability artifacts: repo-relative when
 * inside the repo, otherwise the bare basename. Absolute operator paths
 * must never leak into public git history via badge side-cars.
 *
 * @param {string} repoRoot
 * @param {string} absolutePath
 * @returns {string}
 */
export function toCommittedPath(repoRoot, absolutePath) {
  const rel = path.relative(repoRoot, absolutePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return path.basename(absolutePath);
}

/**
 * Application Orchestrator Service implementing the staged code review lifecycle use case.
 */
export class ReviewWorkflowService {
  #gitPort;
  #reviewerPort;
  #reportStorePort;
  #snapshotStorePort;
  #telemetryPort;
  #verdictCachePort;
  #roundStorePort;
  #clock;
  #logger;
  #assertPatterns;
  #testPathPatterns;
  #testDeclarationPatterns;
  #executionPort;
  #execution;

  constructor({
    gitPort,
    reviewerPort,
    reportStorePort,
    snapshotStorePort,
    telemetryPort,
    verdictCachePort = null,
    roundStorePort = null,
    clock = () => new Date(),
    logger = {
      log: (msg) => process.stdout.write(msg),
      error: (msg) => process.stderr.write(msg),
    },
    assertPatterns,
    testPathPatterns,
    testDeclarationPatterns,
    executionPort,
    execution = {},
  }) {
    if (!gitPort) throw new TypeError('ReviewWorkflowService requires gitPort');
    if (!reviewerPort) throw new TypeError('ReviewWorkflowService requires reviewerPort');
    if (!reportStorePort) throw new TypeError('ReviewWorkflowService requires reportStorePort');
    if (!snapshotStorePort) throw new TypeError('ReviewWorkflowService requires snapshotStorePort');

    this.#gitPort = gitPort;
    this.#reviewerPort = reviewerPort;
    this.#reportStorePort = reportStorePort;
    this.#snapshotStorePort = snapshotStorePort;
    this.#telemetryPort = telemetryPort ?? new FileSystemTelemetryAdapter();
    this.#verdictCachePort = verdictCachePort;
    this.#roundStorePort = roundStorePort;
    this.#clock = clock;
    this.#logger = logger;
    const envAssert = process.env.OMP_REVIEW_KIT_ASSERT_PATTERNS?.trim();
    const envTestPaths = process.env.OMP_REVIEW_KIT_TEST_PATH_PATTERNS?.trim();
    this.#assertPatterns = assertPatterns ?? (envAssert ? envAssert.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ASSERT_PATTERNS);
    this.#testPathPatterns = testPathPatterns ?? (envTestPaths ? envTestPaths.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TEST_PATH_PATTERNS);
    this.#testDeclarationPatterns = testDeclarationPatterns ?? DEFAULT_TEST_DECLARATION_PATTERNS;

    const envExecute = process.env.OMP_REVIEW_KIT_EXECUTE === '1';
    const envCommand = process.env.OMP_REVIEW_KIT_EXECUTE_COMMAND?.trim() ?? '';
    const envTimeout = configuredInteger(process.env.OMP_REVIEW_KIT_EXECUTE_TIMEOUT_MS, 600000, 0);
    const envLinkDirs = process.env.OMP_REVIEW_KIT_EXECUTE_LINK_DIRS
      ? process.env.OMP_REVIEW_KIT_EXECUTE_LINK_DIRS.split(',').map((s) => s.trim()).filter(Boolean)
      : ['node_modules', '.venv', 'venv'];
    const envRedProof = process.env.OMP_REVIEW_KIT_RED_PROOF === '1';

    const execEnabled = execution.enabled ?? envExecute;
    const execCommand = execution.command ?? envCommand;

    this.#executionPort = executionPort ?? ((execEnabled || execCommand) ? new SubprocessExecutionAdapter() : null);
    this.#execution = {
      enabled: execEnabled,
      command: execCommand,
      timeoutMs: execution.timeoutMs ?? envTimeout,
      linkDirs: execution.linkDirs ?? envLinkDirs,
      redProof: execution.redProof ?? envRedProof,
    };
  }

  /**
   * Tells the committer which run to follow and how many other reviews of this
   * repository are live. Concurrent reviews never block each other, so this only
   * informs; a count that cannot be read counts as none. Without a recorded run
   * (telemetry off) there is nothing to follow, so nothing is announced.
   */
  async #announceRun(repoRoot, runId, recorded) {
    if (!recorded) return;
    let others = 0;
    try {
      const counted = await this.#telemetryPort.countOtherLiveRuns?.({ repoRoot, runId });
      others = Number.isInteger(counted) && counted > 0 ? counted : 0;
    } catch {
      others = 0;
    }
    this.#logger.error(`reviewer-kit run ${runId}: follow it with review-progress --run ${runId} --follow\n`);
    if (others > 0) {
      this.#logger.error(`reviewer-kit: ${others} other review(s) running in this repository; they do not block this commit\n`);
    }
  }

  async execute({ cwd = process.cwd() } = {}) {
    const startedAt = Date.now();
    const repoRoot = (await this.#gitPort.getRepoRoot(cwd)).trim();
    const diff = await this.#gitPort.getStagedDiff(repoRoot);

    const runStamp = ReviewReport.formatTimestamp(new Date(startedAt));
    const runId = diff.isEmpty() ? `${runStamp}-skipped` : `${runStamp}-${diff.hash.slice(0, 12)}`;
    // Durable per-run report copy: the dispatcher falls back to it when the
    // agent URI is unreadable. It lives OUTSIDE the shared content-addressed
    // snapshot dir (run-unique, not diff-addressed) so concurrent reviews
    // on identical staged content never share, delete, or overwrite each
    // other's fallback — the cache dir stays read-only for the run lifetime.
    // Name: runId(timestamp+hash) + per-process seq + random nonce + pid
    // tail. The nonce makes the path unpredictable to same-user processes
    // (a predictable name can be pre-created as a planted PASS report the
    // dispatcher would reproduce verbatim); the pid tail feeds the
    // orphan-sweep owner check (`-<pid>.md$`).
    const runReportPath = path.join(tmpdir(), `reviewer-kit-report-${runId}-${REPORT_SEQ++}-${randomBytes(8).toString('hex')}-${process.pid}.md`);
    // Deterministic scout context pack, written next to the report (same
    // `reviewer-kit-report-` prefix and `-<pid>.md` tail, so the orphan sweep owns it).
    const contextPackPath = path.join(tmpdir(), path.basename(runReportPath).replace('reviewer-kit-report-', 'reviewer-kit-report-ctx-'));
    let contextPackWritten = false;
    let telemetry;
    try {
      telemetry = safeRunTelemetry(this.#telemetryPort.forRun({ repoRoot, runId }));
    } catch {
      telemetry = NULL_RUN_TELEMETRY;
    }
    // Snapshot dirs created during this run; the signal guard removes them
    // before exit() since the finally blocks below never run on SIGINT/SIGTERM.
    // Transient mkdtemp dirs are destroyed; the deterministic content-addressed
    // reuseDir only drops this process's `.live-<pid>` lease (release) so a
    // concurrent review serving from it — or a later retry — keeps its input.
    const transientSnapshotDirs = new Set();
    let retainedSnapshotDir = null;
    let clearLeaseTimer = async () => {};
    const cleanupSnapshots = async () => {
      await clearLeaseTimer();
      for (const dir of transientSnapshotDirs) {
        await this.#snapshotStorePort.remove(dir).catch(() => {});
      }
      if (retainedSnapshotDir && typeof this.#snapshotStorePort.release === 'function') {
        await this.#snapshotStorePort.release(retainedSnapshotDir).catch(async (error) => {
          await telemetry.record('snapshot_release_failed', {
            dir: retainedSnapshotDir,
            error: String(error?.message ?? error),
          }).catch(() => {});
        });
      }
      await rm(runReportPath, { force: true }).catch(() => {});
      await rm(contextPackPath, { force: true }).catch(() => {});
    };
    const uninstall = installRunSignalGuard({ telemetry, runId, cleanup: cleanupSnapshots });
    // HEAD at hook time is the commit's parent: `review-progress --commit` matches
    // a commit to its run through it. Optional capability, never a review input.
    let parentSha = null;
    try {
      parentSha = typeof this.#gitPort.getHeadSha === 'function' ? await this.#gitPort.getHeadSha(repoRoot) : null;
    } catch {
      parentSha = null;
    }
    await telemetry.updateLastRun({
      state: 'started',
      runId,
      repoRoot,
      startedAt: new Date(startedAt).toISOString(),
      progressAt: new Date(startedAt).toISOString(),
      diffHash: diff.hash,
      excludedPaths: [...(diff.excludedPaths ?? [])],
      parentSha,
    }, { force: true });

    try {
      await telemetry.record('run_started', {
        cwd,
        repoRoot,
        node: process.version,
        platform: process.platform,
      });

      if (diff.isEmpty()) {
        await telemetry.record('run_skipped', { reason: 'no staged changes' });
        await telemetry.updateLastRun({
          state: 'skipped',
          verdict: 'SKIPPED',
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        }, { force: true });
        return ReviewExecutionResult.skipped();
      }

      await this.#announceRun(repoRoot, runId, telemetry.recorded);

      await telemetry.record('diff_collected', {
        diffHash: diff.hash,
        diffBytes: diff.length,
        excludedPaths: [...(diff.excludedPaths ?? [])],
      });

      // PASS reuse: an identical staged tree + diff that already passed review
      // (merge, cherry-pick, amend, retried commit) is not reviewed again. Any
      // lookup problem is a plain miss; BLOCK is never cached.
      let cacheTreeSha = null;
      if (this.#verdictCachePort && process.env.OMP_REVIEW_KIT_CACHE !== '0'
        && typeof this.#gitPort.getIndexTree === 'function') {
        try {
          cacheTreeSha = await this.#gitPort.getIndexTree(repoRoot);
          const cached = cacheTreeSha
            ? await this.#verdictCachePort.lookup({ repoRoot, treeSha: cacheTreeSha, diffHash: diff.hash })
            : null;
          if (cached) {
            if (this.#roundStorePort) await this.#roundStorePort.clear(repoRoot).catch(() => {});
            await telemetry.record('verdict_cache_hit', { reportPath: cached.reportPath, cachedAt: cached.at });
            await telemetry.record('run_finished', {
              verdict: 'PASS',
              exitCode: 0,
              durationMs: Date.now() - startedAt,
              cached: true,
            });
            await telemetry.updateLastRun({
              state: 'passed',
              verdict: 'PASS',
              exitCode: 0,
              reportPath: cached.reportPath,
              cached: true,
              durationMs: Date.now() - startedAt,
              finishedAt: new Date().toISOString(),
            }, { force: true });
            this.#logger.log(`reviewer-kit PASS (cached identical tree+diff): ${cached.reportPath}\n`);
            return ReviewExecutionResult.pass(cached.reportPath, 'PASS', []);
          }
        } catch {
          // cache trouble is a miss, never a verdict
        }
      }

      // Delta round: when the previous review of this repository BLOCKed a
      // different diff with confirmed findings, the prompt carries those
      // findings and the lines added since, so the reviewer verifies the fixes
      // and keeps new P2 candidates inside the delta instead of drifting.
      let reviewRound = null;
      if (this.#roundStorePort && process.env.OMP_REVIEW_KIT_ROUNDS !== '0') {
        try {
          reviewRound = ReviewRound.fromRecord({
            record: await this.#roundStorePort.load(repoRoot),
            currentDiffText: diff.bytes.toString('utf8'),
            currentHash: diff.hash,
            now: this.#clock(),
            maxAgeMs: ROUND_MAX_AGE_MS,
          });
          if (reviewRound) {
            await telemetry.record('review_round_context', {
              round: reviewRound.number,
              previousHash: reviewRound.previousHash,
              findings: reviewRound.findings.length,
              deltaFiles: reviewRound.delta === null ? null : reviewRound.delta.length,
            });
          }
        } catch {
          reviewRound = null;
        }
      }

      const suspicionMap = SuspicionMap.compute({
        diffBytes: diff.bytes,
        assertPatterns: this.#assertPatterns,
        testPathPatterns: this.#testPathPatterns,
        testDeclarationPatterns: this.#testDeclarationPatterns,
      });

      await telemetry.record('suspicion_map_computed', {
        entries: suspicionMap.entries.length,
        assertDelta: suspicionMap.entries.filter((e) => e.kind === 'assert_delta').length,
        deletedTestFiles: suspicionMap.entries.filter((e) => e.kind === 'deleted_test_file').length,
        removedTestDeclarations: suspicionMap.entries.filter((e) => e.kind === 'removed_test_declarations').length,
      });

      const snapshotStartedAt = Date.now();
      const snapshot = await this.#gitPort.getSnapshot(repoRoot);
      const fileClasses = classifyChangedPaths(
        diff.changedPaths,
        (p) => isTestPath(p, this.#testPathPatterns),
        new Map(snapshot.files.map((f) => [f.path, f.mode])),
      );
      const shaByPath = new Map(
        snapshot.files.map((f) => [f.path, createHash('sha256').update(f.content).digest('hex')]),
      );
      const fileClassRows = fileClasses.map((entry) => ({
        ...entry,
        sha256: shaByPath.get(entry.path) ?? null,
      }));
      // Resolve the profile + lanes BEFORE any lease is claimed: an invalid
      // OMP_REVIEW_KIT_LANES must fail before create() stamps a .live marker,
      // otherwise the throw leaks a foreign-live lease for its 24h TTL.
      const reviewProfile = reviewProfileFor(fileClasses);
      const riskLanes = riskLanesFor(reviewProfile, process.env);
      // A large diff splits the correctness hunt into parallel shards: the
      // hunter is the longest stage and grows with the diff.
      let hunterShardsText = '';
      if (reviewProfile === 'full' && riskLanes.includes('correctness')) {
        const plan = planHunterShards({
          diffText: diff.bytes.toString('utf8'),
          thresholdBytes: configuredInteger(process.env.OMP_REVIEW_KIT_SHARD_BYTES, 40_000, 0),
          maxShards: configuredInteger(process.env.OMP_REVIEW_KIT_MAX_SHARDS, 3, 2),
        });
        if (plan) {
          hunterShardsText = formatHunterShards(plan);
          await telemetry.record('hunter_shards_planned', {
            diffBytes: plan.totalBytes,
            shards: plan.shards.map((shard) => ({ files: shard.files.length, bytes: shard.bytes })),
          });
        }
      }
      const reuseDir = path.join(tmpdir(), `reviewer-kit-snapshot-${diff.hash.slice(0, 24)}`);
      const snapshotDir = await this.#snapshotStorePort.create(snapshot, {
        diffBytes: diff.bytes,
        changedPaths: diff.changedPaths,
        fileClasses: fileClassRows,
        reuseDir,
      });
      if (snapshotDir !== reuseDir) {
        transientSnapshotDirs.add(snapshotDir);
      } else {
        retainedSnapshotDir = snapshotDir;
      }
      const storePort = this.#snapshotStorePort;
      let leaseRefresh = Promise.resolve();
      const leaseTimer = (typeof storePort.refreshLease === 'function' && typeof setInterval === 'function')
        ? setInterval(() => {
          // Ticks serialize on the chain: a second interval can never
          // interleave inside refreshLease itself.
          leaseRefresh = leaseRefresh.then(() => storePort.refreshLease(snapshotDir)).catch(() => {});
        }, LEASE_REFRESH_MS)
        : null;
      leaseTimer?.unref?.();
      clearLeaseTimer = async () => {
        clearInterval(leaseTimer);
        // Drain the in-flight tick before the caller releases: a refresh
        // still racing release() is a fire-and-forget write that could
        // re-stamp the marker on the retained dir after release() ran.
        await leaseRefresh.catch(() => {});
      };
      await telemetry.record('snapshot_materialized', {
        files: snapshot.files.length,
        bytes: snapshot.files.reduce((total, file) => total + file.content.length, 0),
        durationMs: Date.now() - snapshotStartedAt,
      });

      let executionEvidence = null;
      if (this.#execution.enabled || this.#execution.command) {
        if (!this.#execution.command) {
          executionEvidence = new ExecutionEvidence({
            command: '',
            staged: { ok: false, error: 'no command configured' },
            reverted: null,
          });
        } else if (this.#executionPort) {
          try {
            await telemetry.updateLastRun({
              state: 'executing',
              phase: 'staged',
              command: this.#execution.command,
              runId,
              repoRoot,
            }, { force: true });

            await telemetry.record('execution_started', {
              phase: 'staged',
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
            });

            const linkWarnings = await linkDependencyDirs(repoRoot, snapshotDir, this.#execution.linkDirs);
            const stagedResult = await this.#executionPort.run({
              command: this.#execution.command,
              cwd: snapshotDir,
              timeoutMs: this.#execution.timeoutMs,
            });

            await telemetry.record('execution_finished', {
              phase: 'staged',
              exitCode: stagedResult.exitCode,
              timedOut: stagedResult.timedOut,
              durationMs: stagedResult.durationMs,
              stdoutBytes: Buffer.byteLength(stagedResult.stdout ?? ''),
              stderrBytes: Buffer.byteLength(stagedResult.stderr ?? ''),
            });

            let revertedResult = null;
            let revertedSkipReason = '';

            if (this.#execution.redProof && stagedResult.ok) {
              const hasTest = diff.changedPaths.some((p) => isTestPath(p, this.#testPathPatterns));
              const hasNonTest = diff.changedPaths.some((p) => !isTestPath(p, this.#testPathPatterns));

              if (hasTest && hasNonTest) {
                const headFiles = new Map();
                for (const p of diff.changedPaths) {
                  if (!isTestPath(p, this.#testPathPatterns)) {
                    headFiles.set(p, await this.#gitPort.getHeadFile(repoRoot, p));
                  }
                }

                const revertedFiles = buildRevertedFiles({
                  files: snapshot.files,
                  changedPaths: diff.changedPaths,
                  testPathPatterns: this.#testPathPatterns,
                  headFiles,
                });

                const revertedSnapshot = new StagedSnapshot(revertedFiles);
                const revertedDir = await this.#snapshotStorePort.create(revertedSnapshot, {
                  artifacts: false,
                });
                transientSnapshotDirs.add(revertedDir);

                try {
                  await telemetry.updateLastRun({
                    state: 'executing',
                    phase: 'reverted',
                    command: this.#execution.command,
                    runId,
                    repoRoot,
                  }, { force: true });

                  await telemetry.record('execution_started', {
                    phase: 'reverted',
                    command: this.#execution.command,
                    timeoutMs: this.#execution.timeoutMs,
                  });

                  await linkDependencyDirs(repoRoot, revertedDir, this.#execution.linkDirs);
                  revertedResult = await this.#executionPort.run({
                    command: this.#execution.command,
                    cwd: revertedDir,
                    timeoutMs: this.#execution.timeoutMs,
                  });

                  await telemetry.record('execution_finished', {
                    phase: 'reverted',
                    exitCode: revertedResult.exitCode,
                    timedOut: revertedResult.timedOut,
                    durationMs: revertedResult.durationMs,
                    stdoutBytes: Buffer.byteLength(revertedResult.stdout ?? ''),
                    stderrBytes: Buffer.byteLength(revertedResult.stderr ?? ''),
                  });
                } finally {
                  await this.#snapshotStorePort.remove(revertedDir);
                  transientSnapshotDirs.delete(revertedDir);
                }
              } else {
                revertedSkipReason = !hasTest ? 'no test changes staged' : 'no non-test changes staged';
              }
            } else if (!this.#execution.redProof) {
              revertedSkipReason = 'red proof disabled';
            }

            executionEvidence = new ExecutionEvidence({
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
              staged: stagedResult,
              reverted: revertedResult,
              revertedSkipReason,
              warnings: linkWarnings,
            });
          } catch (err) {
            executionEvidence = new ExecutionEvidence({
              command: this.#execution.command,
              timeoutMs: this.#execution.timeoutMs,
              staged: { ok: false, error: err.message },
              reverted: null,
            });
          }
        }
      }

      try {
        const pack = buildContextPack({
          files: snapshot.files,
          diffText: diff.bytes.toString('utf8'),
          changedPaths: diff.changedPaths,
          fileClasses: fileClassRows,
          testPathPatterns: this.#testPathPatterns,
        });
        await writeFile(contextPackPath, pack.text, { mode: 0o600 });
        contextPackWritten = true;
        await telemetry.record('context_pack_built', { bytes: Buffer.byteLength(pack.text), ...pack.stats });
      } catch {
        // The pack is an accelerator for the scout, never a gate.
        contextPackWritten = false;
      }

      let execResult;
      try {
        const prompt = ReviewPrompt.forDiff(diff, snapshotDir, diff.changedPaths, {
          suspicionMapText: suspicionMap.toPromptText(),
          executionEvidenceText: executionEvidence ? executionEvidence.toPromptText() : '',
          roundContextText: reviewRound ? reviewRound.toPromptText() : '',
          scoutBaselineText: reviewRound ? reviewRound.toScoutBaselineText() : '',
          reviewProfile,
          riskLanes,
          hunterShardsText,
          fileClasses: fileClassRows,
          reportPath: runReportPath,
          contextPackPath: contextPackWritten ? contextPackPath : '',
          inlineDiff: diff.length <= 50_000 ? diff.bytes.toString('utf8') : '',
        });
        execResult = await this.#reviewerPort.executeReview({
          prompt,
          cwd: repoRoot,
          telemetry,
        });
      } finally {
        await clearLeaseTimer();
        if (snapshotDirDisposition(snapshotDir, reuseDir) === 'remove') {
          // Transient mkdtemp dirs are removed immediately; the deterministic
          // content-addressed reuseDir is left in place so a later identical
          // diff can reuse it (the adapter's retention sweep bounds its age).
          await this.#snapshotStorePort.remove(snapshotDir);
          transientSnapshotDirs.delete(snapshotDir);
        } else if (typeof this.#snapshotStorePort.release === 'function') {
          // The retained cache dir drops its in-use marker so the retention
          // sweep can prune it once this run no longer references it.
          await this.#snapshotStorePort.release(snapshotDir).catch(async (error) => {
            await telemetry.record('snapshot_release_failed', {
              dir: snapshotDir,
              error: String(error?.message ?? error),
            }).catch(() => {});
          });
        }
        // The dispatcher consumed the durable report (or never needed it);
        // remove this run's copy so per-run fallbacks never accumulate.
        await rm(runReportPath, { force: true }).catch(() => {});
        await rm(contextPackPath, { force: true }).catch(() => {});
      }

      let combinedOutput = execResult.combined ?? `${execResult.stdout ?? ''}\n${execResult.stderr ?? ''}`;
      const modelsTried = execResult.modelsTried;

      let { verdict, envelope } = ReviewRejectionEnvelope.evaluate({
        output: combinedOutput,
        diffIdentity: diff,
        processStatus: execResult.status,
        processError: execResult.stderr,
      });

      // Fail-closed verbatim re-emit recovery. Two recoverable shapes, one
      // attempt total, no tools, bounded timeout:
      //  - missing_verdict_marker: the reviewer finished but forgot the marker;
      //    the re-emit is re-evaluated in full and may yield PASS or BLOCK.
      //  - missing/malformed rejection envelope on an explicit BLOCK: only the
      //    envelope shape is repaired; the re-emit is accepted solely when it is
      //    again a BLOCK carrying a valid non-failure envelope, so a repair can
      //    never downgrade a BLOCK to PASS.
      // A failed re-emit keeps the original verdict.
      const envelopeFailureCode = envelope?.kind === 'review_failure' ? envelope.failure?.code : null;
      const markerRecovery = verdict.reason === 'missing_verdict_marker';
      const envelopeRecovery = !markerRecovery
        && (envelopeFailureCode === 'missing_rejection_envelope' || envelopeFailureCode === 'malformed_rejection_envelope');
      if (
        (markerRecovery || envelopeRecovery)
        && execResult.status === 0
        && combinedOutput.trim() !== ''
        && process.env.OMP_REVIEW_KIT_REEMIT !== '0'
      ) {
        const reemitStartedAt = Date.now();
        const originalBytes = Buffer.byteLength(combinedOutput);
        const reemitResult = await this.#reviewerPort.reemitVerbatim({
          prompt: ReviewPrompt.forReemit(combinedOutput, { repairEnvelope: envelopeRecovery }),
          cwd: repoRoot,
          telemetry,
        });
        if (Array.isArray(reemitResult?.attempts)) {
          execResult.attempts = [
            ...(Array.isArray(execResult.attempts) ? execResult.attempts : []),
            ...reemitResult.attempts,
          ];
        }
        let recovered = false;
        if (reemitResult?.status === 0) {
          const reemittedOutput = reemitResult.combined ?? `${reemitResult.stdout ?? ''}
${reemitResult.stderr ?? ''}`;
          const reevaluated = ReviewRejectionEnvelope.evaluate({
            output: reemittedOutput,
            diffIdentity: diff,
            processStatus: reemitResult.status,
            processError: reemitResult.stderr,
          });
          const accepted = markerRecovery
            ? reevaluated.verdict.reason !== 'missing_verdict_marker'
            : !reevaluated.verdict.isPass()
              && reevaluated.envelope != null
              && reevaluated.envelope.kind !== 'review_failure';
          if (markerRecovery || accepted) {
            verdict = reevaluated.verdict;
            envelope = reevaluated.envelope;
            combinedOutput = reemittedOutput;
          }
          recovered = accepted;
        }
        await telemetry.record('reemit_recovery', {
          originalBytes,
          recovered,
          mode: envelopeRecovery ? 'envelope_repair' : 'missing_marker',
          reemitStatus: reemitResult?.status ?? null,
          durationMs: Date.now() - reemitStartedAt,
        });
      }

      await telemetry.record('verdict_evaluated', {
        verdict: verdict.value,
        envelopeKind: envelope ? envelope.kind : null,
        failureCode: envelope?.failure?.code ?? null,
        findings: envelope ? envelope.findings.length : 0,
      });

      const verifiedOk = [
        'The staged index was materialized into a temporary snapshot before review.',
        'The reviewer ran from the repository root, preserving Git and project context.',
      ];
      if (execResult.status === 0) {
        verifiedOk.push('The reviewer process exited successfully and its verdict was normalized.');
      }

      const report = new ReviewReport({
        diffIdentity: diff,
        verdict,
        rawOutput: combinedOutput,
        modelsTried,
        verifiedOk,
        envelope,
        timestamp: this.#clock(),
      });

      const reportStartedAt = Date.now();
      const reportPath = await this.#reportStorePort.saveReport(repoRoot, report);
      await telemetry.record('report_written', {
        reportPath,
        durationMs: Date.now() - reportStartedAt,
      });

      const childPids = [
        ...(Array.isArray(execResult.attempts) ? execResult.attempts : []),
        ...(Array.isArray(execResult.probes) ? execResult.probes : []),
      ].map((entry) => entry?.pid).filter((pid) => Number.isInteger(pid));
      await telemetry.record('run_finished', {
        verdict: verdict.value,
        exitCode: verdict.isPass() ? 0 : 1,
        durationMs: Date.now() - startedAt,
        modelsTried,
        attemptCount: Array.isArray(execResult.attempts) ? execResult.attempts.length : 0,
        probeCount: Array.isArray(execResult.probes) ? execResult.probes.length : 0,
        ompLogHints: [...new Set(childPids)].map((pid) => `~/.omp/logs/omp.*.${pid}.log`),
      });
      await telemetry.updateLastRun({
        state: verdict.isPass() ? 'passed' : 'blocked',
        verdict: verdict.value,
        exitCode: verdict.isPass() ? 0 : 1,
        reportPath,
        durationMs: Date.now() - startedAt,
        modelsTried,
        finishedAt: new Date().toISOString(),
      }, { force: true });

      // Per-stage stats + README badge: best-effort, never gates the verdict.
      // r26 correctness-2: only the kit's own repo (or an explicit opt-in)
      // receives badge artifacts — a consumer repo under review must not
      // accumulate unrequested committable files.
      if (await badgeEligible(repoRoot)) try {
        const stageHistory = (Array.isArray(execResult.attempts) ? execResult.attempts : [])
          .flatMap((a) => Array.isArray(a?.stageHistory) ? a.stageHistory : []);
        const badgeColor = verdict.isPass() ? 'brightgreen' : 'red';
        const stageParts = stageHistory.map((s) => s.stage).filter(Boolean);
        const badge = {
          schemaVersion: 1,
          label: 'review-kit',
          message: `${verdict.value} · ${Math.round((Date.now() - startedAt) / 1000)}s`,
          color: badgeColor,
        };
        const badgeDir = path.join(repoRoot, 'audit-reports');
        await mkdir(badgeDir, { recursive: true });
        await writeFile(
          path.join(badgeDir, 'review-badge.json'),
          JSON.stringify(badge, null, 2) + '\n',
          'utf8',
        );
        await writeFile(
          path.join(badgeDir, 'review-badge.full.json'),
          JSON.stringify({
            schema: 'review-badge@1',
            runId,
            diffHash: diff.hash,
            verdict: verdict.value,
            reviewProfile,
            durationMs: Date.now() - startedAt,
            stageHistory,
            stageTrail: stageParts.join('→'),
            modelsTried,
            // Committed artifact: repo-relative, never an absolute operator
            // path (machine layout must not leak into public git history).
            reportPath: toCommittedPath(repoRoot, reportPath),
            generatedAt: new Date().toISOString(),
          }, null, 2) + '\n',
          'utf8',
        );
      } catch {
        // Badge writing is observability sugar; a failure must never fail the review.
      }

      if (this.#roundStorePort) {
        // PASS ends the chain; a BLOCK with confirmed findings or coverage
        // gaps starts/extends it; an infrastructure failure leaves it as is.
        try {
          const confirmedKinds = ['confirmed_findings', 'coverage_required'];
          if (verdict.isPass()) {
            await this.#roundStorePort.clear(repoRoot);
          } else if (envelope && confirmedKinds.includes(envelope.kind)) {
            const diffText = diff.bytes.toString('utf8');
            await this.#roundStorePort.save(repoRoot, {
              schema: ReviewRound.SCHEMA,
              diffHash: diff.hash,
              at: this.#clock().toISOString(),
              round: reviewRound ? reviewRound.number : 1,
              envelopeKind: envelope.kind,
              findings: roundFindingsFromEnvelope(envelope.toJSON()),
              findingsTotal: roundFindingsTotal(envelope.toJSON()),
              ...((execResult.scoutBaseline ?? reviewRound?.scoutBaseline) ? { scout: execResult.scoutBaseline ?? reviewRound.scoutBaseline } : {}),
              ...(diffText.length <= ROUND_MAX_DIFF_CHARS ? { diffText } : {}),
            });
          }
        } catch {
          // round bookkeeping never gates the verdict
        }
      }

      if (verdict.isPass()) {
        if (this.#verdictCachePort && cacheTreeSha) {
          await this.#verdictCachePort
            .record({ repoRoot, treeSha: cacheTreeSha, diffHash: diff.hash, reportPath })
            .catch(() => {});
        }
        this.#logger.log(`reviewer-kit PASS: ${reportPath}\n`);
        return ReviewExecutionResult.pass(reportPath, verdict.value, modelsTried);
      }

      if (envelope && envelope.kind === 'review_failure' && typeof execResult.stderr === 'string') {
        const detail = execResult.stderr.trim();
        if (detail) {
          this.#logger.error(detail.split(/\r?\n/).slice(-8).join('\n') + '\n');
        }
      }
      this.#logger.error(`reviewer-kit BLOCK: ${reportPath}\n`);
      this.#logger.error(`REVIEW_REJECTION_REPORT=${reportPath}\n`);

      return ReviewExecutionResult.block(reportPath, combinedOutput.trim(), modelsTried, envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await telemetry.record('run_failed', { error: message });
      await telemetry.updateLastRun({
        state: 'failed',
        error: message,
        exitCode: 1,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      }, { force: true });
      throw error;
    } finally {
      uninstall?.();
    }
  }
}

/**
 * ============================================================================
 * Infrastructure Layer (Adapters)
 * ============================================================================
 */

/**
 * Files the kit vendors into target repositories. They are the review plugin
 * itself, not the committer's work: a staged copy that is byte-identical to the
 * installed kit's canonical file is not reviewed.
 */
export const VENDORED_KIT_FILES = Object.freeze([
  Object.freeze({ target: '.omp/review-kit/run-review.mjs', source: 'templates/review-kit/run-review.mjs' }),
  Object.freeze({ target: '.githooks/pre-commit', source: 'templates/githooks/pre-commit' }),
]);

/**
 * Reads the canonical vendored files from the installed OMP plugin
 * (OMP_REVIEW_KIT_PLUGIN_DIR first, then ~/.omp/plugins/node_modules).
 * Any problem yields an empty map, so nothing is exempted from review.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {Promise<Map<string, string>>} target path -> canonical content
 */
export async function loadCanonicalVendoredFiles({ env = process.env, home = homedir() } = {}) {
  const candidates = [
    env.OMP_REVIEW_KIT_PLUGIN_DIR,
    path.join(home, '.omp', 'plugins', 'node_modules', 'omp-reviewer-kit'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (manifest.name !== 'omp-reviewer-kit') continue;
      const files = new Map();
      for (const { target, source } of VENDORED_KIT_FILES) {
        files.set(target, await readFile(path.join(dir, source), 'utf8'));
      }
      return files;
    } catch {
      // try the next candidate
    }
  }
  return new Map();
}

export class SubprocessGitAdapter extends GitPort {
  #runner;
  #vendoredFiles;

  constructor(runner, { vendoredFiles } = {}) {
    super();
    this.#runner = runner ?? SubprocessGitAdapter.defaultRunner;
    this.#vendoredFiles = vendoredFiles;
  }

  static defaultRunner(args, cwd, input) {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const chunks = [];
      const errChunks = [];
      proc.stdout.on('data', (chunk) => chunks.push(chunk));
      proc.stderr.on('data', (chunk) => errChunks.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(errChunks).toString('utf8').trim();
          reject(new Error(detail || `git ${args[0] ?? 'command'} failed with exit ${code ?? 'unknown'}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      if (input) {
        proc.stdin.on('error', () => {});
        proc.stdin.end(input);
      }
    });
  }

  async getRepoRoot(cwd) {
    const output = await this.#runner(['rev-parse', '--show-toplevel'], cwd);
    return output.toString('utf8').trim();
  }

  async getStagedDiff(repoRoot) {
    const excluded = await this.#identicalVendoredPaths(repoRoot);
    // Pinned: the review diff must not depend on the committer's git configuration.
    // diff.mnemonicPrefix renames the a/ and b/ prefixes, color.diff adds escape codes.
    const args = ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--'];
    if (excluded.length > 0) args.push('.', ...excluded.map((p) => `:(exclude,literal)${p}`));
    const output = await this.#runner(args, repoRoot);
    return DiffIdentity.fromBuffer(output, { excludedPaths: excluded });
  }

  /**
   * Staged vendored kit files (runner stub, hook) that are byte-identical to the
   * installed kit's canonical copy: they are the review plugin, not the
   * committer's work, so the review diff leaves them out. Any doubt (no
   * canonical copy, unreadable blob, different bytes) keeps the file in review.
   *
   * @param {string} repoRoot
   * @returns {Promise<string[]>}
   */
  async #identicalVendoredPaths(repoRoot) {
    let canonical = new Map();
    if (typeof this.#vendoredFiles === 'function') {
      try {
        const loaded = await this.#vendoredFiles();
        if (loaded instanceof Map) canonical = loaded;
      } catch {
        canonical = new Map();
      }
    }
    const fields = (await this.#runner(['diff', '--cached', '--raw', '--no-renames', '-z', '--'], repoRoot))
      .toString('utf8').split('\0');
    const normalize = (text) => String(text).replace(/\r\n/g, '\n');
    const regularModes = new Set(['100644', '100755']);
    const stagedText = async (name) => (await this.#runner(['show', `:${name}`], repoRoot)).toString('utf8');
    const identical = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(fields[i]);
      const name = fields[i + 1];
      if (!meta) continue;
      if (!canonical.has(name)) continue;
      // A mode change (the hook losing its executable bit, a symlink in place
      // of the file) changes behaviour even when the bytes are canonical.
      const [, oldMode, newMode, status] = meta;
      const modeOk = status === 'M' ? oldMode === newMode : status === 'A' && regularModes.has(newMode);
      if (!modeOk) continue;
      try {
        const staged = normalize(await stagedText(name));
        if (staged === normalize(canonical.get(name))) identical.push(name);
      } catch {
        // unreadable staged blob stays in review
      }
    }
    return identical;
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<string|null>}
   */
  async getIndexTree(repoRoot) {
    try {
      const id = (await this.#runner(['write-tree'], repoRoot)).toString('utf8').trim();
      return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * HEAD commit id, or null on an unborn branch. The commit under review is
   * HEAD's child, so this is the parent that `review-progress --commit` matches on.
   *
   * @param {string} repoRoot
   * @returns {Promise<string|null>}
   */
  async getHeadSha(repoRoot) {
    try {
      const id = (await this.#runner(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot)).toString('utf8').trim();
      return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  async getHeadFile(repoRoot, filePath) {
    try {
      const buffer = await this.#runner(['cat-file', 'blob', `HEAD:${filePath}`], repoRoot);
      return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    } catch (error) {
      // Only a genuinely absent blob means "new file at HEAD": every other
      // failure (corrupt object store, missing HEAD, unreadable repo) must
      // propagate so the reverted snapshot is skipped rather than silently
      // dropping the file.
      const message = String(error?.message ?? error);
      if (/Not a valid object name|does not exist|exists on disk, but not in/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  async getSnapshot(repoRoot) {
    const listing = await this.#runner(['ls-files', '--cached', '-z', '--stage', '--'], repoRoot);
    const entries = listing.toString('utf8').split('\0').filter(Boolean);
    const pending = [];

    for (const entry of entries) {
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error('git ls-files returned an invalid staged entry');
      const metadata = entry.slice(0, separator).split(' ');
      const mode = metadata[0];
      const stage = metadata[2];
      if (stage !== '0') throw new Error('Cannot review an unmerged staged index');
      if (mode === '160000') continue;
      pending.push({
        path: entry.slice(separator + 1),
        mode,
        objectId: metadata[1],
      });
    }

    // One `cat-file --batch` process streams every blob: a per-file spawn
    // costs ~20-45ms each, which made every commit pay minutes on large
    // indexes and pushed users toward --no-verify.
    if (pending.length === 0) {
      return new StagedSnapshot([]);
    }
    const batchInput = Buffer.from(pending.map((f) => f.objectId).join('\n') + '\n', 'utf8');
    const batchOutput = await this.#runner(['cat-file', '--batch'], repoRoot, batchInput);

    const files = [];
    let offset = 0;
    for (const item of pending) {
      const headerEnd = batchOutput.indexOf(0x0a, offset);
      if (headerEnd < 0) throw new Error('git cat-file --batch returned a truncated stream');
      const header = batchOutput.toString('utf8', offset, headerEnd);
      const [headerId, headerType, headerSize] = header.split(' ');
      if (headerId !== item.objectId || headerType !== 'blob') {
        throw new Error(`git cat-file --batch returned ${header} for ${item.path}`);
      }
      const size = Number.parseInt(headerSize, 10);
      if (!Number.isInteger(size) || size < 0) {
        throw new Error(`git cat-file --batch returned an invalid size for ${item.path}`);
      }
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      if (contentEnd >= batchOutput.length || batchOutput[contentEnd] !== 0x0a) {
        throw new Error(`git cat-file --batch truncated the blob for ${item.path}`);
      }
      files.push({
        path: item.path,
        content: Buffer.from(batchOutput.subarray(contentStart, contentEnd)),
        mode: item.mode,
      });
      offset = contentEnd + 1;
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return new StagedSnapshot(files);
  }
}


export const REVIEW_PROGRESS_PREFIX = 'reviewer-kit progress: ';

const REVIEW_PROGRESS_RE = /^reviewer-kit progress: \[([a-z-]+)\] (.+)$/;

/**
 * Formats one human-readable, machine-detectable progress line for the Git hook.
 * The line is written to stderr so Git and OMP can display it while the hook runs.
 *
 * @param {{ state: string, message: string, model?: string, elapsedMs?: number }} event
 * @returns {string}
 */
export function formatReviewProgress({ state, message, model, elapsedMs }) {
  const details = [message];
  if (model) details.push('model ' + model);
  if (Number.isFinite(elapsedMs)) details.push('elapsed ' + Math.floor(elapsedMs / 1000) + 's');
  return REVIEW_PROGRESS_PREFIX + '[' + state + '] ' + details.join(' | ');
}

/**
 * Extracts the last progress line from streamed OMP/Git output.
 *
 * @param {unknown} value
 * @returns {{ state: string, text: string }|undefined}
 */
export function parseReviewProgress(value) {
  const lines = String(value ?? '').split(/\r?\n/);
  let parsed;
  for (const line of lines) {
    const match = line.match(REVIEW_PROGRESS_RE);
    if (match) parsed = { state: match[1], text: match[2] };
  }
  return parsed;
}

export function writeReviewProgress(event) {
  process.stderr.write(formatReviewProgress(event) + '\n');
}

// OMP reports an MCP server that failed to start on stderr, possibly after the verdict; it is not reviewer output.
const OMP_MCP_WARNING_RE = /^\s*Warning: MCP server "[^"]*" failed to connect\b/;

/**
 * Sanitizes stderr from reviewer execution:
 * (a) removes every line matching /^\s*Working\.\.\.\s*$/i (OMP print-mode progress noise),
 * (b) removes every line matching OMP_MCP_WARNING_RE (MCP connection warning, which can follow the verdict),
 * (c) normalizes CRLF to LF.
 *
 * @param {string} stderr
 * @returns {string}
 */
export function sanitizeReviewerOutput(stderr) {
  if (typeof stderr !== 'string' || stderr === '') return '';
  return stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*Working\.\.\.\s*$/i.test(line))
    .filter((line) => !OMP_MCP_WARNING_RE.test(line))
    .join('\n');
}

/**
 * Provider-refusal signal (quota, rate limit, auth, capacity). Same pattern
 * historically inlined in isModelProviderFailure; hoisted so the quota-stall
 * watchdog can test streaming stderr while the child is still alive.
 */
const PROVIDER_REFUSAL_RE = /(quota|rate ?limit|RESOURCE_EXHAUSTED|insufficient[ _-]?(?:quota|capacity|credits|balance)|model (not )?(found|available|supported)|model [^\n]{0,80}(not found|unavailable|unsupported)|no endpoints found|provider (error|unavailable)|invalid api[-_ ]?key|set an api key environment variable|upgrade your subscription|(?:status(?: code)?|error code|response code)\s*[:=]?\s*(?:401|403|429)\b[^\n]{0,30}\b(?:Unauthorized|Forbidden|Too Many Requests)\b|\b(?:401|403|429)\s*(?:Unauthorized|Forbidden|Too Many Requests)\b|(?:^|\n)\s*(?:(?:(?:error|failure|failed)\s*:?\s*)?HTTP\s+(?:401|403|429)\b|status(?: code)?\s*[:=]?\s*(?:401|403|429)\b|(?:error|response) code\s*[:=]?\s*(?:401|403|429)\b))/i;

/**
 * Streaming chunk test for provider refusals. Pure predicate over text, no
 * verdict awareness: callers decide what a refusal means mid-run.
 */
export function containsProviderRefusal(text) {
  return typeof text === 'string' && PROVIDER_REFUSAL_RE.test(text);
}

/**
 * Reads only the last `maxTailBytes` of a (possibly multi-MB) log file via a
 * positioned read — the stage/quota pollers run every ~10s for the whole
 * review, so a whole-file readFile+slice per tick was O(log size) memory and
 * I/O per poll. A mid-UTF-8 start byte yields a truncated first line that
 * never parses — same semantics as the old string slice.
 *
 * @param {string} filePath
 * @param {number} maxTailBytes
 * @returns {Promise<string>}
 */
async function readLogTail(filePath, maxTailBytes) {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxTailBytes);
    const length = size - start;
    if (length <= 0) return '';
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

const STAGE_AGENT_IDS = Object.freeze({
  'review-context-scout': 'scout',
  'review-risk-hunter': 'risk',
  'review-finding-verifier': 'verifier',
});

// `Configured subagent …` events carry DISPLAY names (`role: "subagent:<Parent>.<Display>"`),
// never the agent-type id — only `subagent launch timing` events do. The
// orchestrator picks display names at run time (CorrectnessHunter, HunterS1,
// HunterS2, …), so the stage word inside the name decides. Those names map by
// pattern, and a name with no stage word (the orchestrator's own row) maps to
// nothing and never pins a stage.
const STAGE_DISPLAY_PATTERNS = Object.freeze([
  [/Scout/, 'scout'],
  [/Hunter/, 'risk'],
  [/Verifier/, 'verifier'],
]);

/**
 * @param {string} display
 * @returns {string|undefined}
 */
function stageForDisplay(display) {
  for (const [pattern, stage] of STAGE_DISPLAY_PATTERNS) {
    if (pattern.test(display)) return stage;
  }
  return undefined;
}

/**
 * Best-effort stage derivation from the child OMP log. Reads the newest
 * `omp.<date>.<pid>.log`, scans for `Configured subagent` (stage start) and
 * `subagent launch timing` (stage end) JSON entries, and returns the current
 * stage label for `last-run.json`. `logAt` is the log's modification time: the
 * activity signal behind the quiet judgement, not a stage change. Never throws:
 * an unreadable or absent log yields `undefined`, leaving the caller to keep the
 * prior stage value.
 */
export async function childLogReadStage({ logDir, pid, maxTailBytes = 262_144 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const dir = logDir ?? path.join(homedir(), '.omp', 'logs');
    const suffix = `.${pid}.log`;
    const entries = await readdir(dir);
    const matches = entries.filter((name) => name.startsWith('omp.') && name.endsWith(suffix));
    if (matches.length === 0) return undefined;
    matches.sort().reverse();
    const logFile = path.join(dir, matches[0]);
    const logAt = new Date((await stat(logFile)).mtimeMs).toISOString();
    const tail = await readLogTail(logFile, maxTailBytes);
    const configuredRoles = [];
    const launchedAgents = [];
    for (const line of tail.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const message = String(entry.message ?? '');
      if (message === 'Configured subagent runtime model fallback chain') {
        configuredRoles.push(String(entry.role ?? ''));
      } else if (message === 'subagent launch timing') {
        launchedAgents.push(String(entry.agent ?? ''));
      }
    }
    // Stage-matched pairing, launch-side ground truth: a Configured dispatch
    // only pairs with a launch event when their stages agree. The outer
    // orchestrator's own Configured (role "subagent:<Parent>.ReviewerKit",
    // no stage) and non-stage dispatches pair with NOTHING and cannot shift
    // positional indices into wrong labels. A duplicated/retried/cancelled
    // Configured for a stage that already launched is a phantom: it must
    // not create an unfinished agent that pins the reported stage forever.
    const dispatchQueueByStage = new Map();
    for (const role of configuredRoles) {
      const display = (role ?? '').split('.').pop() ?? '';
      const stage = stageForDisplay(display);
      if (!stage) continue;
      const queue = dispatchQueueByStage.get(stage) ?? [];
      queue.push(role);
      dispatchQueueByStage.set(stage, queue);
    }
    const started = [];
    for (const agent of launchedAgents) {
      const agentStage = STAGE_AGENT_IDS[agent];
      const queue = agentStage ? (dispatchQueueByStage.get(agentStage) ?? []) : [];
      const dispatch = queue.length > 0 ? queue.shift() : undefined;
      const display = (dispatch ?? '').split('.').pop() ?? '';
      const stage = stageForDisplay(display) ?? agentStage;
      if (stage) started.push(stage);
    }
    // Configured-but-never-launched stages (dispatch issued, launch event
    // not yet in the tail): the stage is started only while it owns ZERO
    // launches — a launch for that stage consumes its dispatch, so a
    // surplus Configured for an already-launched stage is ignored.
    for (const [stage, queue] of dispatchQueueByStage) {
      const hadLaunches = launchedAgents.some((agent) => STAGE_AGENT_IDS[agent] === stage);
      if (!hadLaunches && queue.length > 0) started.push(stage);
    }
    // Per-agent completion: the two parallel risk hunters must BOTH finish
    // before the risk stage counts as complete; a Set of stage labels would
    // collapse them into one 'risk' entry and falsely conclude `allDone`
    // (regressing the reported stage back to 'scout').
    const finishedAgents = launchedAgents
      .map((agent) => STAGE_AGENT_IDS[agent])
      .filter(Boolean);
    const finishedCounts = new Map();
    for (const stage of finishedAgents) {
      finishedCounts.set(stage, (finishedCounts.get(stage) ?? 0) + 1);
    }
    const startedCounts = new Map();
    for (const stage of started) {
      startedCounts.set(stage, (startedCounts.get(stage) ?? 0) + 1);
    }
    // Current stage = the first observed stage whose agents are unfinished;
    // when every observed agent finished, the review sits in the gap before
    // the NEXT stage's Configured line — report the last completed stage
    // (never 'synthesis', which only begins after the verifier completes).
    let stage = 'scouting';
    let lastCompleted;
    for (let i = 0; i < started.length; i += 1) {
      const s = started[i];
      if ((finishedCounts.get(s) ?? 0) < (startedCounts.get(s) ?? 0)) {
        stage = s;
        lastCompleted = null;
        break;
      }
      lastCompleted = s;
    }
    if (lastCompleted) stage = lastCompleted === 'verifier' ? 'synthesis' : lastCompleted;
    // `completed` counts fully-finished STAGES: a stage is done when every
    // agent dispatched for it (Configured rows by stage) has launched and
    // finished. Configured-but-unlaunched dispatches count against the stage,
    // so hunter#2 pending keeps risk out of the finished set.
    const expectedByStage = new Map();
    for (const role of configuredRoles) {
      const disp = (role ?? '').split('.').pop() ?? '';
      const st = stageForDisplay(disp);
      if (st) expectedByStage.set(st, (expectedByStage.get(st) ?? 0) + 1);
    }
    const completedStages = new Set();
    for (const [s, n] of finishedCounts) {
      const expected = Math.max(expectedByStage.get(s) ?? 0, startedCounts.get(s) ?? 0);
      if (n >= expected && expected > 0) completedStages.add(s);
    }
    return { stage, completed: completedStages.size, logAt };
  } catch {
    return undefined;
  }
}
/**
 * Static heuristic proving a review attempt failed because the model provider
 * refused the request (quota, rate limit, auth, or capacity), rather than
 * because the review itself produced a verdict or timed out. A provider
 * failure ends the run with an infrastructure error: the kit never switches
 * models, that is OMP's own configuration (default role + fallbackChains).
 *
 * @param {{ status: number, stdout?: string, stderr?: string }} result
 * @returns {boolean}
 */
export function isModelProviderFailure(result) {
  if (result.status === 0) return false;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // A timeout is not a provider verdict.
  if (/Review timed out after/.test(combined)) return false;

  // A provider-side refusal can be wrapped in a synthetic BLOCK marker by
  // the orchestrator when dispatch fails. Detect it before treating BLOCK as
  // a completed review — but only when the envelope declares review_failure;
  // a confirmed_findings BLOCK that quotes refusal text is a real verdict.
  // Marker presence (not verdict validity) decides: a marker followed by
  // trailing stderr noise is still verdict-shaped output, not a dispatch
  // failure.
  const hasMarker = /^REVIEW_RESULT=(PASS|BLOCK)\r?$/m.test(combined);
  if (hasMarker) {
    const failureBlock = /"kind"\s*:\s*"review_failure"/.test(combined);
    return failureBlock && containsProviderRefusal(combined);
  }

  if (containsProviderRefusal(combined)) return true;

  // A real verdict means the review ran; the non-zero status may be OMP
  // reporting a BLOCK exit code.
  return false;
}

// Windows STATUS_STACK_BUFFER_OVERRUN (0xC0000409) and generic -1 exits: the
// child crashed before producing any review output.
// Second report channel: no bash write needed. Each review attempt runs the
// OMP child with its own `--session-dir`, so the task tool persists every
// task's complete result as `<session>/<artifacts>/<TaskId>.md`. The
// dispatcher's stdout can still lose the report (truncated task preview,
// unreadable `agent://` URI) and the durable per-run report file depends on
// a bash heredoc that project policy guards may deny; this artifact needs
// neither, so the runner reads it directly after the child exits.
const TASK_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const REPORT_MARKER_LINE_RE = /^REVIEW_RESULT=(PASS|BLOCK)\r?$/m;
const EXECUTION_FAILURE_CODE_RE = /"code"\s*:\s*"execution_failure"/;

/**
 * A task artifact stores the `yield` payload JSON-encoded: a plain string for
 * schema-less agents, an object for `reviewer-kit` whose `report` field holds
 * the complete Markdown. Decode either back to the raw report text; anything
 * else is returned as-is.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeTaskArtifact(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === 'string') return decoded;
      if (decoded && typeof decoded === 'object' && typeof decoded.report === 'string') return decoded.report;
    } catch {
      // Not decodable JSON: fall through to the raw text.
    }
  }
  return raw;
}

/**
 * True when the dispatcher stdout cannot be trusted to carry the reviewer's
 * report: no standalone verdict marker, or the dispatcher itself reported an
 * execution_failure envelope (typically "full report unreadable").
 *
 * @param {string|undefined} stdout
 * @returns {boolean}
 */
export function reviewOutputNeedsRecovery(stdout) {
  const text = String(stdout ?? '');
  return !REPORT_MARKER_LINE_RE.test(text) || EXECUTION_FAILURE_CODE_RE.test(text);
}

/**
 * Reads the newest top-level task result (one directory below the session
 * dir) that carries a standalone verdict marker. Subagent transcripts live a
 * level deeper and never qualify. Returns null when nothing usable exists.
 *
 * @param {string|null|undefined} sessionDir
 * @returns {Promise<{ text: string, file: string, bytes: number }|null>}
 */
export async function recoverTaskReport(sessionDir) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) return null;
  let best = null;
  try {
    for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const artifactsDir = path.join(sessionDir, entry.name);
      for (const file of await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile() || !file.name.endsWith('.md')) continue;
        const full = path.join(artifactsDir, file.name);
        const info = await stat(full).catch(() => null);
        if (!info || info.size === 0 || info.size > TASK_ARTIFACT_MAX_BYTES) continue;
        const text = decodeTaskArtifact(await readFile(full, 'utf8'));
        if (!REPORT_MARKER_LINE_RE.test(text)) continue;
        // Newest wins; equal mtimes (coarse-timestamp filesystems) fall back to the
        // greater path so the choice never depends on readdir order.
        if (!best || info.mtimeMs > best.mtimeMs || (info.mtimeMs === best.mtimeMs && full > best.file)) {
          best = { text, file: full, mtimeMs: info.mtimeMs };
        }
      }
    }
  } catch {
    return null;
  }
  return best ? { text: best.text, file: best.file, bytes: Buffer.byteLength(best.text) } : null;
}

const CHILD_CRASH_STATUSES = new Set([3221226505, -1073740791, 4294967295, -1]);

/**
 * True when the OMP child died with a hard crash code and printed nothing:
 * a runtime fault, not a verdict, worth exactly one re-run.
 */
export function isChildCrash(result) {
  return CHILD_CRASH_STATUSES.has(result?.status) && String(result?.stdout ?? '').trim() === '';
}

function configuredInteger(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Raw `--max-time` values accepted from OMP_REVIEW_KIT_MAX_TIME and forwarded
 * to the OMP child: plain seconds (`600`) or suffixed durations (`10m`, `1h`)
 * - exactly the shapes `omp --max-time` documents. Anything else disables
 * the bound (historical unbounded behavior).
 */
const REVIEW_MAX_TIME_RE = /^(\d+)([smh])?$/;

/**
 * Parses the review attempt bound into the raw `--max-time` arg for the OMP
 * child plus its millisecond equivalent for telemetry. `0`/empty/invalid
 * disables the bound and returns nulls.
 */
export function parseReviewMaxTime(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '' || raw === '0') return { arg: null, ms: null };
  const match = REVIEW_MAX_TIME_RE.exec(raw);
  if (!match) return { arg: null, ms: null };
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { arg: null, ms: null };
  const factor = match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : 1_000;
  const ms = amount * factor;
  if (!Number.isSafeInteger(ms)) return { arg: null, ms: null };
  return { arg: raw, ms };
}

/**
 * Heuristic: max-time expiry is observable only as exit-0-with-empty-stdout
 * at ~the bound (verified live: `--max-time 20s` exits 0 with no output).
 * The 30s tolerance absorbs spawn/teardown overhead; a model that genuinely
 * returned empty well before the bound is not misclassified.
 */
export function isMaxTimeExpiry({ stdout, durationMs, maxTimeMs }) {
  if (!(maxTimeMs > 0)) return false;
  if ((stdout ?? '').trim() !== '') return false;
  return durationMs >= maxTimeMs - 30_000;
}

/**
 * Skill catalog visible to the review child. The catalog is resent with every
 * request of every stage, and an autolearn-grown store of hundreds of skills
 * made the base request ~213KB (measured; ~92KB with review-domain skills
 * only), so the child lists only the plugin's own skills plus plugin-named
 * skills by default. The plugin skills are always included: the orchestrator
 * autoloads the protocol skills, and a filter that hides them empties the
 * catalog and breaks every skill:// read. OMP_REVIEW_KIT_SKILLS: unset = the
 * default extra patterns, a comma-separated glob list = extra patterns added
 * to the plugin skills, `all` (any case, anywhere in the list) = the full
 * catalog. An invalid list falls back to the default extra patterns.
 */
const REVIEW_PLUGIN_SKILLS = ['multi-stage-review', 'reality-first-review', 'range-audit', 'slop'];
const DEFAULT_REVIEW_SKILL_PATTERNS = '*reviewer-kit*,*review-kit*';
const REVIEW_SKILL_PATTERN_RE = /^[A-Za-z0-9_.*?-]+$/;
function reviewSkillsSelection() {
  const requested = (process.env.OMP_REVIEW_KIT_SKILLS ?? '').split(',').map((pattern) => pattern.trim()).filter(Boolean);
  if (requested.some((pattern) => pattern.toLowerCase() === 'all')) return { args: [], label: 'all' };
  const valid = requested.length > 0 && requested.every((pattern) => REVIEW_SKILL_PATTERN_RE.test(pattern));
  const extra = valid ? requested : DEFAULT_REVIEW_SKILL_PATTERNS.split(',');
  const value = [...new Set([...REVIEW_PLUGIN_SKILLS, ...extra])].join(',');
  return { args: [`--skills=${value}`], label: value };
}


async function terminateProcessTree(proc) {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(resolve, 250);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', finish);
    });
    return;
  }

  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('close', onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('close', onClose);
    if (proc.exitCode !== null || proc.signalCode !== null) finish(true);
  });
  const signalTree = (signal) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };

  signalTree('SIGTERM');
  if (await waitForExit(250)) return;
  signalTree('SIGKILL');
  await waitForExit(250);
}

const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPTS = 40;

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction))];
}

/**
 * Stage label from a transcript file name: `ReviewerKit.Scout.jsonl` -> `Scout`,
 * the orchestrator's own `ReviewerKit.jsonl` keeps its name.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function stageLabelFromTranscript(fileName) {
  const stem = String(fileName).replace(/\.jsonl$/i, '');
  const dot = stem.indexOf('.');
  return dot >= 0 ? stem.slice(dot + 1) : stem;
}

/**
 * Condenses one OMP session transcript (JSONL) into latency counters: how many
 * model turns and tool calls a stage took and how long a turn takes. Lines
 * that are not JSON are ignored.
 *
 * @param {string} text
 * @param {string} stage
 * @returns {{ stage: string, turns: number, toolCalls: number, tools: Record<string, number>, startedAtMs: number, spanMs: number, turnGapMedianMs: number|null, turnGapP90Ms: number|null, turnGapMaxMs: number|null, model: string|null }}
 */
export function summarizeTranscript(text, stage) {
  const tools = {};
  const turnTimes = [];
  let firstAt = Infinity;
  let lastAt = -Infinity;
  let model = null;
  let subagentModel = null;
  let toolCalls = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) {
      if (at < firstAt) firstAt = at;
      if (at > lastAt) lastAt = at;
    }
    if (entry.type === 'model_change' && typeof entry.model === 'string') {
      if (String(entry.role ?? '').startsWith('subagent:')) subagentModel ??= entry.model;
      else model ??= entry.model;
    }
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    if (Number.isFinite(at)) turnTimes.push(at);
    for (const item of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (item?.type !== 'toolCall' && item?.type !== 'tool_use') continue;
      toolCalls += 1;
      const name = String(item.name ?? item.toolName ?? 'unknown');
      tools[name] = (tools[name] ?? 0) + 1;
    }
  }
  const gaps = [];
  for (let i = 1; i < turnTimes.length; i += 1) gaps.push(turnTimes[i] - turnTimes[i - 1]);
  gaps.sort((a, b) => a - b);
  return {
    stage,
    turns: turnTimes.length,
    toolCalls,
    tools,
    startedAtMs: Number.isFinite(firstAt) ? firstAt : 0,
    spanMs: lastAt > firstAt ? lastAt - firstAt : 0,
    turnGapMedianMs: percentile(gaps, 0.5),
    turnGapP90Ms: percentile(gaps, 0.9),
    turnGapMaxMs: gaps.length > 0 ? gaps[gaps.length - 1] : null,
    model: subagentModel ?? model,
  };
}

/**
 * Summarises every stage transcript an OMP review child left in its
 * `--session-dir` (`<session>/<artifacts>/<Parent>/<Parent>.<Stage>.jsonl`, plus the
 * orchestrator's `<artifacts>/<Parent>.jsonl`). Never throws: telemetry must
 * not be able to change a verdict.
 *
 * @param {string|null|undefined} sessionDir
 * @returns {Promise<ReturnType<typeof summarizeTranscript>[]>}
 */
export async function summarizeStageTranscripts(sessionDir) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) return [];
  const stages = [];
  try {
    for (const artifacts of await readdir(sessionDir, { withFileTypes: true })) {
      if (!artifacts.isDirectory()) continue;
      const artifactsDir = path.join(sessionDir, artifacts.name);
      const files = [];
      for (const entry of await readdir(artifactsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(artifactsDir, entry.name));
        if (!entry.isDirectory()) continue;
        const nested = path.join(artifactsDir, entry.name);
        for (const inner of await readdir(nested, { withFileTypes: true })) {
          if (inner.isFile() && inner.name.endsWith('.jsonl')) files.push(path.join(nested, inner.name));
        }
      }
      for (const file of files.slice(0, MAX_TRANSCRIPTS)) {
        const info = await stat(file).catch(() => null);
        if (!info || info.size === 0 || info.size > TRANSCRIPT_MAX_BYTES) continue;
        stages.push(summarizeTranscript(await readFile(file, 'utf8'), stageLabelFromTranscript(path.basename(file))));
      }
    }
  } catch {
    // keep whatever was read before the failure
  }
  return stages.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

const STAGE_RESULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Newest stage result artifact (`<artifacts>/<Parent>/<Parent>.<Stage>.md`)
 * whose stage label matches `labelPattern`, as text; empty when none exists.
 * Never throws.
 *
 * @param {string|null|undefined} sessionDir
 * @param {RegExp} labelPattern
 * @returns {Promise<string>}
 */
export async function readStageResult(sessionDir, labelPattern) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) return '';
  let best = null;
  try {
    for (const artifacts of await readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
      if (!artifacts.isDirectory()) continue;
      const artifactsDir = path.join(sessionDir, artifacts.name);
      for (const entry of await readdir(artifactsDir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(artifactsDir, entry.name);
        for (const inner of await readdir(nested, { withFileTypes: true }).catch(() => [])) {
          if (!inner.isFile() || !inner.name.endsWith('.md')) continue;
          if (!labelPattern.test(stageLabelFromTranscript(inner.name.replace(/\.md$/i, '.jsonl')))) continue;
          const full = path.join(nested, inner.name);
          const info = await stat(full).catch(() => null);
          if (!info || info.size === 0 || info.size > STAGE_RESULT_MAX_BYTES) continue;
          if (!best || info.mtimeMs > best.mtimeMs || (full > best.file && info.mtimeMs === best.mtimeMs)) {
            best = { file: full, mtimeMs: info.mtimeMs };
          }
        }
      }
    }
    return best ? await readFile(best.file, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Infrastructure adapter running headless OMP CLI reviews.
 */
export class OmpCliReviewerAdapter extends ReviewerPort {
  #runner;
  #preflight;
  #preflightTimeoutMs;
  #reviewMaxTime;
  #progress;

  /**
   * The adapter never selects, resolves, or falls back between models: OMP is
   * the user's configured tool (default role, `retry.fallbackChains`,
   * `modelFallback`) and the review child inherits it untouched. The only
   * pre-check is a short model-less health call so a missing login or dead
   * provider fails in seconds instead of after a full review.
   *
   * @param {{
   *   runner?: (prompt: string, cwd: string, timeoutMs?: number, options?: object) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string },
   *   preflight?: ((cwd: string, timeoutMs: number) => Promise<{ status: number, stdout?: string, stderr?: string }>|{ status: number, stdout?: string, stderr?: string })|null,
   *   preflightTimeoutMs?: number,
   *   maxTime?: string,
   *   progress?: (event: { state: string, message: string, elapsedMs?: number }) => void
   * }} [options]
   */
  constructor({
    runner,
    preflight,
    preflightTimeoutMs = configuredInteger(process.env.OMP_REVIEW_KIT_PREFLIGHT_TIMEOUT_MS, 90_000, 1),
    maxTime = process.env.OMP_REVIEW_KIT_MAX_TIME ?? null,
    progress,
  } = {}) {
    super();
    this.#runner = runner ?? OmpCliReviewerAdapter.defaultRunner;
    // An injected runner replaces the real OMP child, so the real health call
    // would be meaningless (and spawn a real process); it is opt-in then.
    this.#preflight = preflight === undefined
      ? (runner ? null : OmpCliReviewerAdapter.defaultPreflight)
      : preflight;
    this.#preflightTimeoutMs = configuredInteger(preflightTimeoutMs, 90_000, 1);
    this.#reviewMaxTime = parseReviewMaxTime(maxTime);
    this.#progress = progress ?? (() => {});
  }

  #emitProgress(event) {
    try {
      this.#progress(event);
    } catch {
      // Progress is observability only and must never change the review verdict.
    }
  }

  async #runReviewAttempt(promptText, cwd, telemetry, attempts, attemptIndex, { reportPath = null } = {}) {
    const startedAt = Date.now();
    const record = { attemptIndex, startedAt: new Date(startedAt).toISOString() };
    const stageHistory = [];
    // Latest mtime of the OMP child's log: the activity signal behind the quiet judgement.
    let childLogAt = null;
    attempts.push(record);
    let responseObserved = false;
    let workingSignalObserved = false;
    const emitRunning = () => {
      this.#emitProgress({
        state: 'reviewing',
        message: 'commit hook review running; waiting for model response',
        elapsedMs: Date.now() - startedAt,
      });
      void telemetry.updateLastRun({
        state: 'reviewing',
        pid: record.pid,
        ...(childLogAt ? { childLogAt } : {}),
        elapsedMs: Date.now() - startedAt,
      });
    };

    this.#emitProgress({
      state: 'reviewing',
      message: 'commit hook review started; waiting for model response',
      elapsedMs: 0,
    });
    const heartbeat = setInterval(emitRunning, 5_000);
    heartbeat.unref?.();
    let sessionDir = null;
    try {
      sessionDir = await mkdtemp(path.join(tmpdir(), `reviewer-kit-session-${process.pid}-`));
    } catch {
      sessionDir = null;
    }
    try {
      const result = await this.#runner(promptText, cwd, undefined, {
        maxTime: this.#reviewMaxTime.arg,
        ...(sessionDir ? { sessionDir } : {}),
        // Lets project policy guards recognize the one write the reviewer
        // may perform (its durable report) without pattern-matching the command.
        ...(reportPath ? { env: { OMP_REVIEW_KIT_REPORT_PATH: reportPath } } : {}),
        onSpawn: (pid) => {
          record.pid = pid;
          void telemetry.record('review_attempt_started', { ...record, pid });
          void telemetry.updateLastRun({ state: 'reviewing', pid });
        },
        onOutput: (chunk, stream) => {
          const text = String(chunk);
          if (stream === 'stderr' && !workingSignalObserved && /Working\.\.\./i.test(text)) {
            workingSignalObserved = true;
            this.#emitProgress({
              state: 'working',
              message: 'OMP child process is active; waiting for model response',
              elapsedMs: Date.now() - startedAt,
            });
            void telemetry.record('review_attempt_working', {
              attemptIndex, pid: record.pid, elapsedMs: Date.now() - startedAt,
            });
          }
          if (stream === 'stdout' && !responseObserved && text.trim()) {
            responseObserved = true;
            this.#emitProgress({
              state: 'response',
              message: 'model response received; checking verdict',
              elapsedMs: Date.now() - startedAt,
            });
            void telemetry.record('review_attempt_first_output', {
              attemptIndex, pid: record.pid, elapsedMs: Date.now() - startedAt,
            });
          }
        },
        onActivity: (logAt) => {
          childLogAt = logAt;
        },
        onStage: ({ stage, completed }) => {
          if (!stage) return;
          stageHistory.push({ stage, completed, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
          this.#emitProgress({
            state: 'reviewing',
            message: `review stage ${stage}${completed > 0 ? ` (${completed} done)` : ''}`,
            elapsedMs: Date.now() - startedAt,
          });
          void telemetry.updateLastRun({
            state: 'reviewing',
            pid: record.pid,
            stage,
            stagesCompleted: completed,
            stageHistory,
            progressAt: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
          }, { force: true });
        },
      });
      record.status = result?.status;
      record.durationMs = Date.now() - startedAt;
      record.providerFailure = isModelProviderFailure(result ?? {});
      record.timedOut = isMaxTimeExpiry({
        stdout: result?.stdout,
        durationMs: record.durationMs,
        maxTimeMs: this.#reviewMaxTime.ms,
      });
      record.stdoutBytes = typeof result?.stdout === 'string' ? Buffer.byteLength(result.stdout) : 0;
      if (stageHistory.length > 0) record.stageHistory = stageHistory;
      record.stderrBytes = typeof result?.stderr === 'string' ? Buffer.byteLength(result.stderr) : 0;
      let outcome = result;
      if (sessionDir && reviewOutputNeedsRecovery(result?.stdout)) {
        const recovered = await recoverTaskReport(sessionDir);
        if (recovered) {
          const reason = EXECUTION_FAILURE_CODE_RE.test(String(result?.stdout ?? '')) ? 'execution_failure' : 'missing_marker';
          record.reportRecovered = { reason, bytes: recovered.bytes };
          await telemetry.record('report_artifact_recovered', { attemptIndex, pid: record.pid, reason, bytes: recovered.bytes });
          outcome = { ...result, stdout: recovered.text };
        }
      }
      // Per-stage turn and tool-call counts: a stage lasts turns x turn latency,
      // so this is what explains a slow review. Read before the session dir goes.
      const stages = await summarizeStageTranscripts(sessionDir);
      if (stages.length > 0) await telemetry.record('stage_stats', { attemptIndex, pid: record.pid, stages });
      // The scout's map is carried to the next round so coverage does not drift.
      const scoutBaseline = parseScoutBaseline(await readStageResult(sessionDir, /scout$/i));
      if (scoutBaseline) outcome = { ...outcome, scoutBaseline };
      await telemetry.record('review_attempt_finished', { ...record });
      return outcome;
    } finally {
      clearInterval(heartbeat);
      if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Model-less health call: proves OMP can answer at all with the user's own
   * configuration (default role plus whatever fallbacks they configured).
   * Returns null when healthy, otherwise the failing result.
   */
  async #runPreflight(cwd, telemetry) {
    if (!this.#preflight) return null;
    const startedAt = Date.now();
    const record = { startedAt: new Date(startedAt).toISOString() };
    await telemetry.record('preflight_started', { ...record });
    this.#emitProgress({ state: 'probe', message: 'checking that OMP can reach a model', elapsedMs: 0 });
    void telemetry.updateLastRun({ state: 'probing' });
    const heartbeat = setInterval(() => this.#emitProgress({
      state: 'probe',
      message: 'checking that OMP can reach a model',
      elapsedMs: Date.now() - startedAt,
    }), 5_000);
    heartbeat.unref?.();
    let result;
    try {
      result = await this.#preflight(cwd, this.#preflightTimeoutMs);
    } catch (error) {
      result = { status: 1, stdout: '', stderr: error?.message ?? String(error) };
    } finally {
      clearInterval(heartbeat);
    }
    record.pid = result?.pid;
    record.status = result?.status;
    record.durationMs = Date.now() - startedAt;
    // Healthy = exit 0 with an actual answer. Provider-error text on stderr alone
    // is not a failure here: OMP prints auxiliary-request noise (e.g. 403 on a
    // side model) while the main flow still answers.
    const healthy = result?.status === 0 && String(result?.stdout ?? '').trim() !== '';
    record.healthy = healthy;
    await telemetry.record('preflight_finished', { ...record });
    return healthy ? null : (result ?? { status: 1, stdout: '', stderr: '' });
  }

  /**
   * Standard OMP CLI runner using async spawn to avoid pipe buffer deadlocks.
   * No model flags are ever passed: OMP resolves its own default role.
   *
   * @param {string} prompt
   * @param {string} cwd
   * @param {number} [timeout]
   * @param {{ noTools?: boolean, maxTime?: string|null, stagePollMs?: number, logDir?: string|null, onOutput?: (chunk: unknown, stream: 'stdout'|'stderr') => void, onSpawn?: (pid: number|undefined) => void, onStage?: (info: { stage: string, completed: number }) => void, onActivity?: (logAt: string) => void, registryEnv?: string|null, sessionDir?: string, env?: Record<string, string> }} [options]
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number }>}
   */
  static defaultRunner(prompt, cwd, timeout, { noTools = false, maxTime, stagePollMs = 10_000, logDir = null, onOutput, onSpawn, onStage, onActivity, registryEnv, sessionDir, env: extraEnv } = {}) {
    return new Promise((resolve) => {
      const command = process.env.OMP_REVIEW_KIT_OMP ?? 'omp';
      const isWindowsWrapper = /\.(cmd|bat)$/i.test(command);
      // Read-only review child: session titles are never displayed in print
      // mode and project rules guard edits the child cannot perform (its
      // tools are task/read plus read-only specialists), so skip title
      // generation and rules discovery on every spawned session. No model
      // flag: the child resolves the user's own OMP configuration.
      // A review attempt persists its session under its own directory so the
      // task artifacts (the full reviewer result) survive until the runner
      // has read them; no-tools probes stay ephemeral.
      const sessionArgs = typeof sessionDir === 'string' && sessionDir.length > 0 ? ['--session-dir', sessionDir] : ['--no-session'];
      const commandArgs = ['-p', ...(noTools ? ['--no-tools'] : ['--tools', 'task,read']), ...sessionArgs, '--no-title', '--no-rules'];
      commandArgs.push(...reviewSkillsSelection().args);
      if (typeof maxTime === 'string' && REVIEW_MAX_TIME_RE.test(maxTime)) {
        commandArgs.push('--max-time', maxTime);
      }
      const dispatchPrompt = `${prompt}\nUse task calls without model, outputSchema, schemaMode, or isolated fields.`;
      const executable = isWindowsWrapper ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const args = isWindowsWrapper
        ? ['/d', '/c', 'call', command, ...commandArgs]
        : commandArgs;

      const proc = spawn(executable, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Stale-parent guard: pull PI_PROXY_* from the user registry when the
        // inherited env lacks them — children otherwise die at OAuth refresh.
        env: {
          ...mergeRegistryProxyEnv(process.env, registryEnv ?? undefined),
          ...Object.fromEntries(Object.entries(extraEnv ?? {}).filter(([, value]) => typeof value === 'string')),
        },
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const pid = Number.isInteger(proc.pid) ? proc.pid : undefined;
      try {
        onSpawn?.(pid);
      } catch {
        // Telemetry callbacks must never affect the review process.
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer;
      let stagePoller;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stagePoller) clearInterval(stagePoller);
        resolve({ pid, ...result });
      };

      if (timeout && timeout > 0) {
        timer = setTimeout(async () => {
          timedOut = true;
          await terminateProcessTree(proc);
          finish({
            status: 1,
            stdout,
            stderr: 'Review timed out after ' + timeout + 'ms\n' + stderr,
          });
        }, timeout);
      }

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        onOutput?.(chunk, 'stdout');
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        onOutput?.(chunk, 'stderr');
      });

      if (Number.isInteger(pid) && pid > 0 && typeof onStage === 'function') {
        let pollRunning = false;
        let lastStage;
        stagePoller = setInterval(() => {
          if (pollRunning || settled) return;
          pollRunning = true;
          void childLogReadStage({ logDir, pid })
            .then((stageInfo) => {
              // Post-settle guard: an in-flight tick resolving after close()
              // must not deliver stage updates — updateLastRun would regress
              // the terminal state back to 'reviewing'.
              if (settled) return;
              // Child-log activity feeds the quiet judgement; it is not a stage change.
              if (stageInfo?.logAt) {
                try { onActivity?.(stageInfo.logAt); } catch {}
              }
              if (stageInfo) {
                // Monotonic progress: a truncated tail can make the log look
                // earlier than it is; never report a regression — neither the
                // stage label nor the completed count may move backward.
                const rank = (s) => ['scouting', 'scout', 'risk', 'verifier', 'synthesis'].indexOf(s);
                if (lastStage && rank(stageInfo.stage) >= 0 && rank(stageInfo.stage) < rank(lastStage.stage)) {
                  stageInfo = { ...stageInfo, stage: lastStage.stage };
                }
                const prevCompleted = lastStage?.completed ?? -1;
                // r28 correctness-1: tail-window eviction can shrink the
                // recomputed count while the stage still advances — clamp
                // completed to monotonic before reporting/tracking.
                if ((stageInfo.completed ?? 0) < prevCompleted) {
                  stageInfo = { ...stageInfo, completed: prevCompleted };
                }
                const advanced = stageInfo.stage !== lastStage?.stage
                  || (stageInfo.completed ?? 0) > prevCompleted;
                if (advanced) {
                  lastStage = { stage: stageInfo.stage, completed: stageInfo.completed };
                  try { onStage?.(stageInfo); } catch {}
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              pollRunning = false;
            });
        }, stagePollMs > 0 ? stagePollMs : 10_000);
      }

      proc.on('close', (code) => {
        if (timedOut) return;
        finish({ status: code ?? 1, stdout, stderr });
      });

      proc.on('error', (err) => {
        if (timedOut) return;
        finish({ status: 1, stdout, stderr: `${err.message || err}\n${stderr}` });
      });

      // Guard against EPIPE if process terminates before reading stdin
      proc.stdin.on('error', () => {});
      try {
        proc.stdin.write(dispatchPrompt);
        proc.stdin.end();
      } catch {
        // Ignore write failures on closed streams
      }
    });
  }

  /**
   * Minimal no-tools, model-less request confirming OMP can reach a model.
   *
   * @param {string} cwd
   * @param {number} timeout
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  static defaultPreflight(cwd, timeout) {
    return OmpCliReviewerAdapter.defaultRunner(
      'Respond with exactly READY. Do not use tools.',
      cwd,
      configuredInteger(timeout, 90_000, 1),
      { noTools: true },
    );
  }

  /**
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string,
   *   telemetry?: { record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> },
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, combined: string, modelsTried: string[], attempts: object[], probes: object[] }>}
   */
  async executeReview({ prompt, cwd, telemetry = NULL_RUN_TELEMETRY }) {
    telemetry = safeRunTelemetry(telemetry);
    await telemetry.record('review_chain', {
      preflightTimeoutMs: this.#preflight ? this.#preflightTimeoutMs : null,
      maxTime: this.#reviewMaxTime.arg,
      skills: reviewSkillsSelection().label,
    });
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const reportPath = typeof prompt === 'object' && typeof prompt?.reportPath === 'string' ? prompt.reportPath : null;
    const attempts = [];
    const probes = [];

    const preflightFailure = await this.#runPreflight(cwd, telemetry);
    let result;
    if (preflightFailure) {
      probes.push({ kind: 'preflight', status: preflightFailure.status });
      result = {
        status: 1,
        stdout: '',
        stderr: formatProviderOutageError(preflightFailure.stderr || preflightFailure.stdout),
      };
    } else {
      result = await this.#runReviewAttempt(promptText, cwd, telemetry, attempts, 0, { reportPath });
      // A hard child crash (Windows 0xC0000409 / -1) with no output is a
      // runtime fault, not a verdict: one more run with the same command.
      if (isChildCrash(result)) {
        result = await this.#runReviewAttempt(promptText, cwd, telemetry, attempts, 1, { reportPath });
      }
      if (isModelProviderFailure(result)) {
        result = {
          status: 1,
          stdout: result.stdout ?? '',
          stderr: formatProviderOutageError(result.stderr),
        };
      }
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = `${stdout}\n${sanitizeReviewerOutput(stderr)}`;

    return {
      status: result.status ?? 1,
      stdout,
      stderr,
      combined,
      modelsTried: [],
      attempts,
      probes,
      ...(result.scoutBaseline ? { scoutBaseline: result.scoutBaseline } : {}),
    };
  }

  /**
   * Runs exactly one bounded no-tools re-prompt asking OMP to reproduce its
   * previous output verbatim under the verdict contract. Reuses the
   * single-shot runner path and the preflight-timeout budget.
   *
   * @param {{
   *   prompt: import('../domain/review-prompt.mjs').ReviewPrompt|string,
   *   cwd: string,
   *   timeoutMs?: number,
   *   telemetry?: { record: (type: string, payload?: object) => Promise<void>, updateLastRun: (state: object, opts?: { force?: boolean }) => Promise<void> },
   * }} params
   * @returns {Promise<{ status: number, stdout: string, stderr: string, pid?: number, attempts: object[] }>}
   */
  async reemitVerbatim({ prompt, cwd, timeoutMs, telemetry = NULL_RUN_TELEMETRY }) {
    telemetry = safeRunTelemetry(telemetry);
    const promptText = typeof prompt === 'string' ? prompt : prompt.toString();
    const timeout = configuredInteger(timeoutMs, this.#preflightTimeoutMs, 1);
    const startedAt = Date.now();
    const record = { kind: 'reemit', startedAt: new Date(startedAt).toISOString() };
    const attempts = [record];
    await telemetry.record('reemit_started', { ...record });
    void telemetry.updateLastRun({ state: 'reemitting' });
    try {
      const result = await this.#runner(promptText, cwd, timeout, {
        noTools: true,
        onSpawn: (pid) => {
          record.pid = pid;
          void telemetry.updateLastRun({ state: 'reemitting', pid });
        },
      });
      record.pid = record.pid ?? result?.pid;
      record.status = result?.status;
      record.durationMs = Date.now() - startedAt;
      record.stdoutBytes = typeof result?.stdout === 'string' ? Buffer.byteLength(result.stdout) : 0;
      record.stderrBytes = typeof result?.stderr === 'string' ? Buffer.byteLength(result.stderr) : 0;
      await telemetry.record('reemit_finished', { ...record });
      return {
        status: result?.status ?? 1,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
        pid: record.pid,
        attempts,
      };
    } catch (error) {
      record.status = 1;
      record.durationMs = Date.now() - startedAt;
      record.stderrBytes = 0;
      record.error = error?.message ?? String(error);
      await telemetry.record('reemit_finished', { ...record });
      return { status: 1, stdout: '', stderr: record.error, pid: record.pid, attempts };
    }
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
    // Literal '..' plus NTFS-folded forms ('.. ', '.. .', '...') all
    // resolve to the parent on Windows — reject both shapes.
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
    // err.message flows into review_failure/last-run sinks — the raw staged
    // path's control bytes must be escaped before it reaches them.
    throw new Error(`Unsafe staged path in snapshot: ${sanitizePromptToken(filePath)}`);
  }
}

export async function linkDependencyDirs(repoRoot, snapshotDir, dirNames = ['node_modules', '.venv', 'venv']) {
  const warnings = [];
  const { stat, symlink } = await import('node:fs/promises');
  for (const name of dirNames) {
    const source = path.join(repoRoot, name);
    const destination = path.join(snapshotDir, name);
    try {
      const srcStat = await stat(source).catch(() => null);
      if (!srcStat || !srcStat.isDirectory()) continue;
      const destStat = await stat(destination).catch(() => null);
      if (destStat) continue;

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(source, destination, symlinkType);
    } catch (err) {
      warnings.push(`Failed to link ${name}: ${err.message}`);
    }
  }
  return warnings;
}

// Provider-proxy env vars that MUST reach every spawned `omp` child. On this
// box google-antigravity OAuth refresh dies with a TLS cert error when the
// request leaves the box without 127.0.0.1:3128, and children spawned from a
// stale parent (started before the user-scope vars existed) inherit nothing —
// reviewers die with "Use /login". Merge the user registry's PI_PROXY_* into
// the child env when the inherited env lacks them; never overwrite values the
// parent did set (scoped-off runs keep full control).
const REGISTRY_PROXY_VARS = /^PI_(?:PROXY|CA_BUNDLE)_/;
const REG_SZ_ROW_RE = /^\s+(\S+)\s+REG_SZ\s+(.+)$/;

export function mergeRegistryProxyEnv(env = process.env, registryOut = readUserEnvironmentBlock()) {
  const merged = { ...env };
  const parentKeys = Object.keys(merged);
  for (const line of String(registryOut ?? '').split(/\r?\n/)) {
    const row = line.match(REG_SZ_ROW_RE);
    if (!row) continue;
    const [, name, value] = row;
    if (!REGISTRY_PROXY_VARS.test(name)) continue;
    if (merged[name] !== undefined) continue;
    // Windows env lookup is case-insensitive but Node preserves the
    // inherited spelling in enumeration: a parent-set `pi_proxy_meta`
    // must still suppress the registry PI_PROXY_META row, else both
    // spellings reach the child env block with unpredictable resolution.
    if (process.platform === 'win32'
      && parentKeys.some((k) => k.toUpperCase() === name.toUpperCase())) continue;
    merged[name] = value.trim();
  }
  return merged;
}

function readUserEnvironmentBlock() {
  if (process.platform !== 'win32') return '';
  try {
    const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}

export class SubprocessExecutionAdapter extends ExecutionPort {
  async run({ command, cwd, timeoutMs = 600000 }) {
    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return { ok: false, error: 'No command specified' };
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let timedOut = false;
      let timer = null;

      let child;
      try {
        child = spawn(command, {
          shell: true,
          cwd,
          env: mergeRegistryProxyEnv(),
          windowsHide: true,
        });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }

      const MAX_LINES = 200;
      let stdoutLines = [];
      let stderrLines = [];

      child.stdout?.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        stdoutLines = stdoutLines.concat(lines).slice(-MAX_LINES);
      });

      child.stderr?.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        stderrLines = stderrLines.concat(lines).slice(-MAX_LINES);
      });

      if (timeoutMs > 0) {
        timer = setTimeout(async () => {
          timedOut = true;
          await terminateProcessTree(child);
        }, timeoutMs);
        if (typeof timer?.unref === 'function') {
          timer.unref();
        }
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });

      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startedAt;
        resolve({
          ok: true,
          // A signal-killed child reports exitCode null; surface it as a
          // failure, never as exit 0.
          exitCode: exitCode ?? 1,
          timedOut,
          durationMs,
          stdout: stdoutLines.join('\n'),
          stderr: stderrLines.join('\n'),
        });
      });
    });
  }
}

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
      this.lastReused = reuseDir;
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

  get reusedDir() {
    return this.lastReused ?? null;
  }

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
      // Orphan per-attempt session dirs (crashed runs never reach their
      // finally): TTL-bounded and only once the owning pid is gone.
      for (const name of names) {
        if (!name.startsWith('reviewer-kit-session-')) continue;
        const full = path.join(base, name);
        const info = await lstat(full).catch(() => null);
        if (!info || !info.isDirectory()) continue;
        if (now - info.mtimeMs <= SNAPSHOT_TTL_MS) continue;
        const owner = Number(name.match(/^reviewer-kit-session-(\d+)-/)?.[1]);
        if (Number.isInteger(owner) && isPidAlive(owner)) continue;
        await rm(full, { recursive: true, force: true }).catch(() => {});
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
   * their own lease.
   *
   * Throws: a lease that failed to stamp must never leave the caller
   * serving from an unprotected diff-addressed dir.
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
   * Fails closed when this process's own `.live-<pid>` lease disappeared
   * from dir — proof a concurrent actor destroyed or replaced the
   * diff-addressed dir while we were still serving from it.
   */
  async #assertOwnLease(dir) {
    const name = this.#leaseByDir.get(dir);
    const info = name ? await stat(path.join(dir, name)).catch(() => null) : null;
    if (!info || !info.isFile()) {
      throw new Error(`snapshot lease lost for ${dir}`);
    }
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
    // Only this consumer's lease is released — resolve the marker from the
    // DIRECTORY, not the current #leaseName: execute() can call create()
    // twice on one adapter (reverted-evidence dir), and the second call
    // re-rolls the name — a field lookup would orphan the first dir's stamp.
    const name = await this.#ownMarkerIn(snapshotDir);
    if (!name) return;
    const marker = path.join(snapshotDir, name);
    const info = await lstat(marker).catch(() => null);
    // A non-regular marker at our lease name is foreign content (symlink,
    // planted file) — never unlink it, and fail loudly: lease state was
    // tampered with mid-run.
    if (info && !info.isFile()) {
      throw new Error(`snapshot lease marker is not a regular file: ${marker}`);
    }
    await rm(marker, { force: true }).catch(() => {});
    this.#leaseByDir.delete(snapshotDir);
  }

  /**
   * Lease heartbeat: refreshes ONLY this process's `.live-<pid>` marker
   * mtime. Missing marker → NO-OP, always: the marker is absent because
   * release() already ran (an in-flight tick landing after release must
   * never resurrect the lease as a foreign-live marker for up to 24h) or
   * the dir was swept. A non-regular marker at our lease name is removed
   * (lease tamper) instead of updated.
   *
   * @param {string} snapshotDir
   * @returns {Promise<void>}
   */
  async refreshLease(snapshotDir) {
    const name = await this.#ownMarkerIn(snapshotDir);
    if (!name) return;
    const marker = path.join(snapshotDir, name);
    const info = await lstat(marker).catch(() => null);
    // Missing marker -> NO-OP, always: release() may land between our
    // readdir and lstat, and a sweep can take the marker — a vanished
    // lease is a no-op, never a TypeError.
    if (info === null) return;
    if (!info.isFile()) {
      await rm(marker, { recursive: true, force: true }).catch(() => {});
      return;
    }
    const now = new Date();
    await utimes(marker, now, now).catch(() => {});
  }

  async remove(snapshotDir) {
    this.#leaseByDir.delete(snapshotDir);
    await rm(snapshotDir, { recursive: true, force: true });
  }

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
      const rows = artifacts.fileClasses.map((entry) => ({
        // Paths sanitize identically to changed-files.txt: deleted staged
        // paths never pass assertSafeSnapshotPath and their raw bytes (bidi,
        // zero-width, C1) must not reach the reviewer-facing manifest.
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


export class FileSystemReportStoreAdapter extends ReportStorePort {
  #relativeDir;

  constructor(relativeDir = path.join('audit-reports', 'commit-reviews')) {
    super();
    this.#relativeDir = relativeDir;
  }

  async saveReport(repoRoot, report) {
    const reportDir = path.join(repoRoot, this.#relativeDir);
    await mkdir(reportDir, { recursive: true });

    const reportPath = path.join(reportDir, report.filename);
    await writeFile(reportPath, report.toMarkdown(), 'utf8');

    return reportPath;
  }
}

const REVIEW_EVENT_SCHEMA = 'review-run-event@1';
const REVIEW_LAST_RUN_SCHEMA = 'review-last-run@1';
const LAST_RUN_THROTTLE_MS = 2_000;
export const REVIEW_RUN_RECORD_SCHEMA = 'review-run-record@1';
const RUN_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_RECORD_PRUNE_LIMIT = 2_000;
/** States that never change again: a record in one of them has finished. */
export const TERMINAL_RUN_STATES = new Set(['passed', 'blocked', 'failed', 'skipped', 'interrupted']);

/**
 * Non-terminal last-run states: a live run must keep the recorded pid alive.
 * Kept in sync with LIVE_LAST_RUN_STATES in
 * src/application/installer-service.mjs.
 */
const LIVE_LAST_RUN_STATES = new Set([
  'started',
  'executing',
  'reviewing',
  'working',
  'response',
  'probe',
  'probing',
  'reemitting',
]);

/**
 * Signal-0 liveness probe used by the stale last-run sweep. Mirrors
 * checkProcessLiveness in the application layer.
 *
 * @param {number} pid
 * @returns {'alive'|'dead'|'unknown'}
 */
function pidLiveness(pid) {
  if (!Number.isInteger(pid)) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err?.code === 'ESRCH') return 'dead';
    if (err?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Builds the user-facing message emitted when every model in the chain failed
 * with a provider/availability error. The review produced no verdict; the
 * commit is blocked by infrastructure, not by findings.
 */
function formatProviderOutageError(lastStderr) {
  const lines = [
    'reviewer-kit infrastructure failure: no review verdict was produced.',
    'OMP could not get an answer from a model (this is an outage or a configuration problem, not a code verdict).',
    'Fix: reviewer-kit does not choose models. Check the login and the default model role in OMP itself,',
    '  and configure fallbacks there (modelRoles / retry.fallbackChains in ~/.omp/agent/config.yml).',
    'The detailed report and run telemetry are under audit-reports/commit-reviews/.',
  ];
  const tail = typeof lastStderr === 'string'
    ? lastStderr.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(' | ')
    : '';
  if (tail) lines.push(`Last provider error: ${tail}`);
  return `${lines.join('\n')}\n`;
}

const NULL_RUN_TELEMETRY = Object.freeze({
  recorded: false,
  record: async () => {},
  updateLastRun: async () => {},
});

/**
 * Wraps a run telemetry sink so that throwing/rejecting sinks (custom ports,
 * injected doubles) can never change the review verdict or exit code.
 */
function safeRunTelemetry(sink) {
  if (!sink || typeof sink.record !== 'function' || typeof sink.updateLastRun !== 'function') {
    return NULL_RUN_TELEMETRY;
  }
  // Read on every access, not copied once: a run record written after this wrapper exists must count.
  // Only the null sink reports recorded: false; a sink that does not report it counts as recorded.
  return {
    get recorded() {
      return sink.recorded !== false;
    },
    record: (type, payload) => {
      try {
        return Promise.resolve(sink.record(type, payload)).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    },
    updateLastRun: (state, opts) => {
      try {
        return Promise.resolve(sink.updateLastRun(state, opts)).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    },
  };
}

export class NullTelemetryAdapter extends TelemetryPort {
  forRun() {
    return NULL_RUN_TELEMETRY;
  }
}

// `d:runs` names a folder of drive D's current directory, not of home, so it has no fixed location.
const DRIVE_RELATIVE_OVERRIDE = /^[A-Za-z]:(?![\\/])/;

/**
 * Per-run records live outside any repository, so `review-progress` can list
 * every run of every session at once. Overridable for tests and sandboxes. A
 * relative override is resolved against the home directory, never the working
 * directory: the hook and `review-progress` run from different folders and must
 * still agree on one place. A drive-relative override falls back to the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
function resolveRunsDir(env = process.env, home = homedir()) {
  const override = typeof env.OMP_REVIEW_KIT_RUNS_DIR === 'string' ? env.OMP_REVIEW_KIT_RUNS_DIR.trim() : '';
  if (!override || DRIVE_RELATIVE_OVERRIDE.test(override)) return path.join(home, '.omp', 'review-kit-runs');
  return path.resolve(home, override);
}

/**
 * Session tag exported by the Claude Code SessionStart hook as
 * `OMP_REVIEW_KIT_RUN_TAG`. Anything that is not a plain token is dropped.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function runTagFromEnv(env = process.env) {
  const raw = typeof env.OMP_REVIEW_KIT_RUN_TAG === 'string' ? env.OMP_REVIEW_KIT_RUN_TAG.trim() : '';
  return /^[A-Za-z0-9._:-]{1,200}$/.test(raw) ? raw : null;
}

/**
 * Run-scoped telemetry sink. Appends one JSONL event per record() call to
 * <reportDir>/runs.jsonl and maintains <reportDir>/last-run.json as the live
 * state channel (throttled, last-writer-wins), plus this run's own record in
 * the runs directory (see resolveRunsDir). All failures are swallowed: telemetry
 * must never change the review verdict or exit code.
 */
class RunTelemetry {
  #eventsFile;
  #lastRunFile;
  #runRecordFile;
  #runId;
  #doc;
  #lastWriteAt = 0;
  #pendingWrite = Promise.resolve();
  #recordWritten = false;

  constructor({ reportDir, runsDir = null, runId, base }) {
    this.#eventsFile = path.join(reportDir, 'runs.jsonl');
    this.#lastRunFile = path.join(reportDir, 'last-run.json');
    this.#runRecordFile = runsDir ? path.join(runsDir, `${runId}.json`) : null;
    this.#runId = runId;
    // The state document of this run, merged field by field (see updateLastRun).
    this.#doc = { runId, ...base };
    // A previous run that died without a finish event leaves last-run.json
    // stuck in a live state forever — readers then keep showing "reviewing".
    // Tombstone it before this run's own writes land (state:'started' would
    // otherwise clobber the evidence).
    this.#pendingWrite = this.#pendingWrite
      .then(() => this.#sweepStaleLastRun())
      .then(() => this.#pruneRunRecords(runsDir))
      .catch(() => {});
  }

  record(type, payload = {}) {
    const event = {
      schema: REVIEW_EVENT_SCHEMA,
      runId: this.#runId,
      type,
      at: new Date().toISOString(),
      ...payload,
    };
    return this.#enqueue(async () => {
      await mkdir(path.dirname(this.#eventsFile), { recursive: true });
      await appendFile(this.#eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  /**
   * Drops per-run records that can no longer matter: finished ones, and
   * abandoned ones (runner gone) past the retention window. A live record is
   * never removed, whatever its age.
   */
  async #pruneRunRecords(runsDir) {
    if (!runsDir) return;
    let names;
    try {
      names = await readdir(runsDir);
    } catch {
      return; // No runs directory yet: nothing to prune.
    }
    const cutoff = Date.now() - RUN_RECORD_RETENTION_MS;
    for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, RUN_RECORD_PRUNE_LIMIT)) {
      const file = path.join(runsDir, name);
      try {
        if ((await stat(file)).mtimeMs > cutoff) continue;
        const record = JSON.parse(await readFile(file, 'utf8'));
        // Only kit run records are removed: a foreign JSON file in the runs folder is never ours to delete.
        const isKitRecord = record?.schema === REVIEW_RUN_RECORD_SCHEMA && typeof record.runId === 'string';
        if (isKitRecord && (TERMINAL_RUN_STATES.has(record.state) || pidLiveness(record.runnerPid) === 'dead')) {
          await rm(file, { force: true });
        }
      } catch {
        // Unreadable, or racing with another run: a later sweep decides.
      }
    }
  }

  async #sweepStaleLastRun() {
    let previous;
    try {
      previous = JSON.parse(await readFile(this.#lastRunFile, 'utf8'));
    } catch {
      return; // Missing or corrupt: nothing to tombstone.
    }
    if (
      !previous ||
      typeof previous !== 'object' ||
      previous.runId === this.#runId ||
      !LIVE_LAST_RUN_STATES.has(previous.state) ||
      pidLiveness(Number.isInteger(previous.runnerPid) ? previous.runnerPid : previous.pid) !== 'dead'
    ) {
      return;
    }
    const detail = 'review process gone; no finish event recorded';
    await mkdir(path.dirname(this.#eventsFile), { recursive: true });
    await appendFile(this.#eventsFile, `${JSON.stringify({
      schema: REVIEW_EVENT_SCHEMA,
      runId: previous.runId,
      type: 'run_abandoned',
      at: new Date().toISOString(),
      pid: previous.pid,
      state: previous.state,
      error: detail,
    })}\n`, 'utf8');
    await writeFile(this.#lastRunFile, `${JSON.stringify({
      ...previous,
      state: 'interrupted',
      error: previous.error ?? detail,
      message: previous.message ?? detail,
      abandonedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  }


  /** True once this run's own record is on disk: the only record review-progress can follow. */
  get recorded() {
    return this.#recordWritten;
  }

  updateLastRun(state, { force = false } = {}) {
    const now = Date.now();
    // Merge, never replace: a field this update leaves out keeps its last value,
    // so a heartbeat cannot erase the stage that an earlier write recorded.
    Object.assign(this.#doc, state);
    if (!force && now - this.#lastWriteAt < LAST_RUN_THROTTLE_MS) {
      return Promise.resolve();
    }
    this.#lastWriteAt = now;
    const doc = {
      ...this.#doc,
      schema: REVIEW_LAST_RUN_SCHEMA,
      updatedAt: new Date(now).toISOString(),
    };
    return this.#enqueue(async () => {
      if (this.#runRecordFile) {
        // The per-run record is what review-progress reads. A failure there must
        // not stop the pointer file below, and the other way round.
        await mkdir(path.dirname(this.#runRecordFile), { recursive: true }).catch(() => {});
        const written = await writeFile(this.#runRecordFile, `${JSON.stringify({ ...doc, schema: REVIEW_RUN_RECORD_SCHEMA }, null, 2)}\n`, 'utf8')
          .then(() => true, () => false);
        // Sticky: a later failed write does not hide a record that is already on disk.
        if (written) this.#recordWritten = true;
      }
      await mkdir(path.dirname(this.#lastRunFile), { recursive: true });
      await writeFile(this.#lastRunFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    });
  }

  async #enqueue(operation) {
    this.#pendingWrite = this.#pendingWrite.then(operation, operation).catch(() => {});
    await this.#pendingWrite;
  }
}

/** Repository roots may differ in case between sessions on Windows, so they are compared resolved. */
function sameRepoRoot(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const key = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return key(left) === key(right);
}

export class FileSystemTelemetryAdapter extends TelemetryPort {
  #relativeDir;

  constructor(relativeDir = path.join('audit-reports', 'commit-reviews')) {
    super();
    this.#relativeDir = relativeDir;
  }

  forRun({ repoRoot, runId }) {
    if (process.env.OMP_REVIEW_KIT_TELEMETRY === '0') {
      return NULL_RUN_TELEMETRY;
    }
    const override = process.env.OMP_REVIEW_KIT_TELEMETRY_DIR;
    const reportDir = override
      ? (path.isAbsolute(override) ? override : path.join(repoRoot, override))
      : path.join(repoRoot, this.#relativeDir);
    return new RunTelemetry({
      reportDir,
      runsDir: resolveRunsDir(),
      runId,
      base: { repoRoot, runnerPid: process.pid, tag: runTagFromEnv() },
    });
  }

  /**
   * Live runs of the same repository other than `runId`. A run is live while its
   * state is non-terminal and its runner process is not dead. Unreadable records
   * are skipped: the count only informs the committer and never decides a verdict.
   *
   * @param {{ repoRoot: string, runId: string }} context
   * @returns {Promise<number>}
   */
  async countOtherLiveRuns({ repoRoot, runId }) {
    if (process.env.OMP_REVIEW_KIT_TELEMETRY === '0') return 0;
    const runsDir = resolveRunsDir();
    let names;
    try {
      names = await readdir(runsDir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || name === `${runId}.json`) continue;
      let record;
      try {
        record = JSON.parse(await readFile(path.join(runsDir, name), 'utf8'));
      } catch {
        continue;
      }
      if (!sameRepoRoot(record?.repoRoot, repoRoot)) continue;
      if (!LIVE_LAST_RUN_STATES.has(record.state)) continue;
      if (!Number.isInteger(record.runnerPid) || pidLiveness(record.runnerPid) === 'dead') continue;
      count += 1;
    }
    return count;
  }
}

const CACHE_SCHEMA = 'review-verdict-cache@1';
const CACHE_FILE = 'verdict-cache.jsonl';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Infrastructure adapter remembering PASS verdicts by (index tree, diff hash).
 * Only PASS is reusable: a BLOCK is always re-reviewed. A hit is honored only
 * when the referenced report still exists inside the repository and states the
 * same diff hash and `result: PASS`, so a stale or tampered index line fails closed
 * into a normal full review.
 */
export class FileSystemVerdictCacheAdapter extends VerdictCachePort {
  #relativeDir;
  #ttlMs;
  #clock;

  constructor({ relativeDir = path.join('audit-reports', 'commit-reviews'), ttlMs = DEFAULT_TTL_MS, clock = () => new Date() } = {}) {
    super();
    this.#relativeDir = relativeDir;
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string }} key
   * @returns {Promise<{ reportPath: string, at: string } | null>}
   */
  async lookup({ repoRoot, treeSha, diffHash }) {
    if (!OBJECT_ID.test(String(treeSha)) || !/^[0-9a-f]{64}$/.test(String(diffHash))) return null;
    let text;
    try {
      text = await readFile(path.join(repoRoot, this.#relativeDir, CACHE_FILE), 'utf8');
    } catch {
      return null;
    }
    const now = this.#clock().getTime();
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (entry?.schema !== CACHE_SCHEMA || entry.verdict !== 'PASS') continue;
      if (entry.treeSha !== treeSha || entry.diffHash !== diffHash) continue;
      const age = now - Date.parse(entry.at);
      if (!Number.isFinite(age) || age < 0 || age > this.#ttlMs) continue;
      const reportPath = path.resolve(repoRoot, String(entry.reportPath ?? ''));
      const relative = path.relative(repoRoot, reportPath);
      if (!entry.reportPath || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      let report;
      try {
        report = await readFile(reportPath, 'utf8');
      } catch {
        continue;
      }
      if (report.split(/\r?\n/).includes(`- staged diff hash: ${diffHash}`)
        && report.split(/\r?\n/).includes('- result: PASS')) {
        return { reportPath, at: entry.at };
      }
    }
    return null;
  }

  /**
   * @param {{ repoRoot: string, treeSha: string, diffHash: string, reportPath: string }} entry
   * @returns {Promise<void>}
   */
  async record({ repoRoot, treeSha, diffHash, reportPath }) {
    if (!OBJECT_ID.test(String(treeSha))) return;
    const dir = path.join(repoRoot, this.#relativeDir);
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      schema: CACHE_SCHEMA,
      treeSha,
      diffHash,
      verdict: 'PASS',
      reportPath: path.relative(repoRoot, reportPath).split(path.sep).join('/'),
      at: this.#clock().toISOString(),
    });
    await appendFile(path.join(dir, CACHE_FILE), `${line}\n`, 'utf8');
  }
}

const MAX_COVERAGE_ENTRIES = 60;
const MAX_NON_COVERABLE_ENTRIES = 20;
const MAX_TEXT_CHARS = 200;
const MAX_REPORT_CHARS = 2_000_000;

const clipText = (value, limit = MAX_TEXT_CHARS) => String(value ?? '').slice(0, limit);
const positiveLine = (value) => (Number.isInteger(value) && value > 0 ? value : null);

function decodeScoutReport(text) {
  const raw = String(text ?? '').slice(0, MAX_REPORT_CHARS).trim();
  const attempts = [raw];
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) attempts.push(raw.slice(open, close + 1));
  for (const candidate of attempts) {
    try {
      let value = JSON.parse(candidate);
      if (typeof value === 'string') value = JSON.parse(value);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // a prefix-trimmed attempt may still parse
    }
  }
  return null;
}

/**
 * Extracts the stable part of a scout report (the `coverage_map`, the waived
 * `non_coverable_items`, and the harness verdict) so the next review round can
 * reuse it instead of rebuilding a different map from scratch.
 *
 * @param {string} text - the scout's result artifact
 * @returns {{ coverageMap: object[], nonCoverable: object[], testHarness: string }|null}
 */
export function parseScoutBaseline(text) {
  const report = decodeScoutReport(text);
  if (!report || !Array.isArray(report.coverage_map)) return null;
  const coverageMap = report.coverage_map
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.file_path === 'string' && typeof entry.behavior === 'string')
    .slice(0, MAX_COVERAGE_ENTRIES)
    .map((entry) => ({
      behavior: clipText(entry.behavior),
      file_path: clipText(entry.file_path, 400),
      line_start: positiveLine(entry.line_start),
      line_end: positiveLine(entry.line_end),
      covering_test: typeof entry.covering_test === 'string' && entry.covering_test.length > 0 ? clipText(entry.covering_test, 400) : null,
    }));
  const nonCoverable = (Array.isArray(report.non_coverable_items) ? report.non_coverable_items : [])
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.file_path === 'string')
    .slice(0, MAX_NON_COVERABLE_ENTRIES)
    .map((entry) => ({
      file_path: clipText(entry.file_path, 400),
      line_start: positiveLine(entry.line_start),
      line_end: positiveLine(entry.line_end),
      reason: clipText(entry.reason),
    }));
  const harness = String(report.test_harness ?? '').toLowerCase();
  return {
    coverageMap,
    nonCoverable,
    testHarness: harness.startsWith('present') ? 'present' : harness.startsWith('absent') ? 'absent' : 'unknown',
  };
}

/**
 * Validates a baseline read back from the round store.
 *
 * @param {unknown} value
 * @returns {{ coverageMap: object[], nonCoverable: object[], testHarness: string }|null}
 */
export function normalizeStoredBaseline(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.coverageMap)) return null;
  const parsed = parseScoutBaseline(JSON.stringify({
    coverage_map: value.coverageMap,
    non_coverable_items: value.nonCoverable,
    test_harness: value.testHarness,
  }));
  return parsed && parsed.coverageMap.length > 0 ? parsed : null;
}

const locationOf = (entry) => `${sanitizePromptToken(entry.file_path)}${entry.line_start ? `:${entry.line_start}${entry.line_end && entry.line_end !== entry.line_start ? `-${entry.line_end}` : ''}` : ''}`;

/**
 * Prompt block handing the previous round's scout baseline to the scout.
 *
 * @param {{ baseline: object, deltaPaths: string[], round: number }} input
 * @returns {string}
 */
export function formatScoutBaseline({ baseline, deltaPaths, round }) {
  const lines = [
    `SCOUT BASELINE (review round ${round}): the previous round's scout map, carried so the coverage_map stays stable between rounds. Test harness then: ${baseline.testHarness}.`,
    'coverage_map entries of the previous round:',
    ...baseline.coverageMap.map((entry) => `- ${locationOf(entry)} | ${sanitizePromptToken(entry.behavior)} | covering_test: ${entry.covering_test ? sanitizePromptToken(entry.covering_test) : 'null'}`),
  ];
  if (baseline.nonCoverable.length > 0) {
    lines.push(
      'non_coverable_items of the previous round:',
      ...baseline.nonCoverable.map((entry) => `- ${locationOf(entry)} | ${sanitizePromptToken(entry.reason)}`),
    );
  }
  lines.push(
    `Files with lines added since then (the round delta): ${deltaPaths.length > 0 ? deltaPaths.map((p) => sanitizePromptToken(p)).join(', ') : 'none'}.`,
    'Scout rules for this baseline: (1) keep an entry exactly as listed (same behavior and covering_test) when its file_path is outside the round delta, its covering_test is not null, and the file named in covering_test is outside the round delta; (2) re-derive every other entry from the staged snapshot, in particular entries with covering_test null and entries whose source or test file is in the delta, and say in `unknowns` when a baseline entry could not be re-verified; (3) add entries only for executable behaviors that are new in the delta, and drop entries whose behavior no longer exists; (4) do not re-scan unchanged files for new behaviors; (5) emit the full merged coverage_map.',
  );
  return lines.join('\n');
}

const ROUND_SCHEMA = 'review-round@1';
const MAX_FINDINGS = 20;
const MAX_DELTA_FILES = 40;

/**
 * Added content lines per file from a unified diff (`+` lines only).
 *
 * @param {string} diffText
 * @returns {Map<string, Set<string>>}
 */
export function addedLinesByFile(diffText) {
  const byFile = new Map();
  let current = null;
  let inHunk = false;
  for (const line of String(diffText ?? '').split(/\r\n|\n/)) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, new Set());
    } else if (current && line.startsWith('+')) {
      byFile.get(current).add(line.slice(1));
    }
  }
  return byFile;
}

/**
 * Files whose added lines differ from the previous round's diff.
 *
 * @param {string} previousDiff
 * @param {string} currentDiff
 * @returns {{ path: string, newLines: number }[]}
 */
export function deltaSincePrevious(previousDiff, currentDiff) {
  const before = addedLinesByFile(previousDiff);
  const after = addedLinesByFile(currentDiff);
  const delta = [];
  for (const [file, lines] of after) {
    const known = before.get(file);
    let newLines = 0;
    for (const line of lines) if (!known || !known.has(line)) newLines += 1;
    if (newLines > 0) delta.push({ path: file, newLines });
  }
  return delta;
}

/**
 * Condenses a BLOCK envelope into the findings carried to the next round.
 *
 * @param {{ kind: string, findings?: object[], coverage_items?: object[] }} envelope
 * @returns {{ id: string, priority: string, file: string, line: number|null, summary: string }[]}
 */
export function roundFindingsFromEnvelope(envelope) {
  const rows = [];
  for (const finding of envelope?.findings ?? []) {
    rows.push({
      id: String(finding.finding_id ?? ''),
      priority: String(finding.priority ?? ''),
      file: String(finding.file_path ?? ''),
      line: Number.isInteger(finding.line_start) ? finding.line_start : null,
      summary: String(finding.counterexample ?? finding.verifier_argument ?? ''),
    });
  }
  for (const item of envelope?.coverage_items ?? []) {
    rows.push({
      id: String(item.coverage_id ?? ''),
      priority: String(item.severity ?? 'P2'),
      file: String(item.file_path ?? ''),
      line: Number.isInteger(item.line_start) ? item.line_start : null,
      summary: `missing coverage: ${String(item.behavior ?? '')}`,
    });
  }
  return rows.slice(0, MAX_FINDINGS);
}

/**
 * Number of confirmed findings and coverage items in a BLOCK envelope, before
 * the round chain caps the carried list.
 *
 * @param {{ findings?: object[], coverage_items?: object[] }} envelope
 * @returns {number}
 */
export function roundFindingsTotal(envelope) {
  return (envelope?.findings?.length ?? 0) + (envelope?.coverage_items?.length ?? 0);
}

/**
 * Value object describing the previous BLOCKed round for the same repository.
 */
export class ReviewRound {
  static SCHEMA = ROUND_SCHEMA;

  #number;
  #previousHash;
  #previousAt;
  #findings;
  #omitted;
  #delta;
  #scoutBaseline;

  constructor({ number, previousHash, previousAt, findings, omitted = 0, delta, scoutBaseline = null }) {
    this.#number = number;
    this.#previousHash = previousHash;
    this.#previousAt = previousAt;
    this.#findings = findings;
    this.#omitted = omitted;
    this.#delta = delta;
    this.#scoutBaseline = scoutBaseline;
  }

  /**
   * @param {{ record: object, currentDiffText: string, currentHash: string, now: Date, maxAgeMs: number }} params
   * @returns {ReviewRound|null}
   */
  static fromRecord({ record, currentDiffText, currentHash, now, maxAgeMs }) {
    if (!record || record.schema !== ROUND_SCHEMA) return null;
    if (!/^[0-9a-f]{64}$/.test(String(record.diffHash)) || record.diffHash === currentHash) return null;
    const age = now.getTime() - Date.parse(record.at);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    if (!Array.isArray(record.findings) || record.findings.length === 0) return null;
    return new ReviewRound({
      number: (Number.isInteger(record.round) ? record.round : 1) + 1,
      previousHash: record.diffHash,
      previousAt: record.at,
      findings: record.findings.slice(0, MAX_FINDINGS),
      omitted: Math.max(
        0,
        (Number.isInteger(record.findingsTotal) ? record.findingsTotal : record.findings.length)
          - Math.min(record.findings.length, MAX_FINDINGS),
      ),
      delta: typeof record.diffText === 'string' ? deltaSincePrevious(record.diffText, currentDiffText) : null,
      scoutBaseline: normalizeStoredBaseline(record.scout),
    });
  }

  get number() {
    return this.#number;
  }

  get previousHash() {
    return this.#previousHash;
  }

  get findings() {
    return this.#findings;
  }

  /** @returns {number} confirmed findings of the previous round that the capped list does not carry */
  get omitted() {
    return this.#omitted;
  }

  /** @returns {{ path: string, newLines: number }[]|null} null when the previous diff was not retained */
  get delta() {
    return this.#delta;
  }

  /** @returns {object|null} the previous round's scout map, when one was stored */
  get scoutBaseline() {
    return this.#scoutBaseline;
  }

  /**
   * Prompt block for the scout only. Empty when no baseline was stored or the
   * previous diff was not retained (the delta, and so what to keep, is unknown).
   *
   * @returns {string}
   */
  toScoutBaselineText() {
    if (!this.#scoutBaseline || this.#delta === null) return '';
    return formatScoutBaseline({
      baseline: this.#scoutBaseline,
      deltaPaths: this.#delta.map((d) => d.path),
      round: this.#number,
    });
  }

  toPromptText() {
    const lines = [
      `PREVIOUS ROUND (this is review round ${this.#number}): the previous review of this repository BLOCKed a different staged diff (${this.#previousHash}) at ${sanitizePromptToken(this.#previousAt)}. Findings confirmed in that round:`,
      ...this.#findings.map((f) => `- ${sanitizePromptToken(f.id)} (${sanitizePromptToken(f.priority)}) ${sanitizePromptToken(f.file)}${f.line ? `:${f.line}` : ''} — ${sanitizePromptToken(f.summary).slice(0, 240)}`),
    ];
    if (this.#omitted > 0) {
      lines.push(`The list above is capped: ${this.#omitted} more confirmed finding(s) of that round are not listed and stay binding; the verifier must re-derive them from the staged snapshot and the previous report.`);
    }
    if (this.#delta === null) {
      lines.push('The previous diff was not retained, so the lines changed since that round cannot be computed: treat the whole diff as changed.');
    } else if (this.#delta.length === 0) {
      lines.push('No added lines differ from the previous round (only removals or identical additions).');
    } else {
      lines.push(
        'Files with lines added since the previous round (the round delta):',
        ...this.#delta.slice(0, MAX_DELTA_FILES).map((d) => `- ${sanitizePromptToken(d.path)}: ${d.newLines} new line(s)`),
      );
    }
    lines.push(
      'Round rules: (1) The verifier must first decide for EVERY previous finding whether the current diff fixes it (fixed / still present), with evidence from the staged snapshot; a finding that is still present stays confirmed and blocks. (2) A new P2 finding is admissible only if it is rooted in the round delta or in a direct interaction with it; pre-existing lines unchanged since the previous round that were not flagged then must not become new P2 findings. New P1 findings (security, data loss, crash on the main path) are admissible anywhere in the diff. (3) Embed this PREVIOUS ROUND block verbatim in the task text of every hunter and the verifier.',
    );
    return lines.join('\n');
  }
}

const ROUND_FILE = 'last-block.json';

/**
 * Infrastructure adapter keeping the single most recent BLOCKed round
 * (findings plus the diff text) so the next review of the same repository can
 * verify those findings and restrict new P2 candidates to the round delta.
 */
export class FileSystemRoundStoreAdapter extends RoundStorePort {
  #relativeDir;

  constructor({ relativeDir = path.join('audit-reports', 'commit-reviews') } = {}) {
    super();
    this.#relativeDir = relativeDir;
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<object|null>}
   */
  async load(repoRoot) {
    try {
      return JSON.parse(await readFile(path.join(repoRoot, this.#relativeDir, ROUND_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * @param {string} repoRoot
   * @param {object} record
   * @returns {Promise<void>}
   */
  async save(repoRoot, record) {
    const dir = path.join(repoRoot, this.#relativeDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ROUND_FILE), `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * @param {string} repoRoot
   * @returns {Promise<void>}
   */
  async clear(repoRoot) {
    await rm(path.join(repoRoot, this.#relativeDir, ROUND_FILE), { force: true });
  }
}

/**
 * ============================================================================
 * Public Facade / Composition Root
 * ============================================================================
 */

export function createReviewWorkflowService({ git, vendoredFiles, omp, ompOptions, clock, logger, progress, telemetry, assertPatterns, testPathPatterns, testDeclarationPatterns, executionPort, execution } = {}) {
  const gitPort = new SubprocessGitAdapter(git, { vendoredFiles });
  const reviewerPort = new OmpCliReviewerAdapter({ runner: omp, progress, ...ompOptions });
  const reportStorePort = new FileSystemReportStoreAdapter();
  const snapshotStorePort = new FileSystemSnapshotAdapter();
  const telemetryPort = telemetry ?? new FileSystemTelemetryAdapter();
  const verdictCachePort = new FileSystemVerdictCacheAdapter({ clock });
  const roundStorePort = new FileSystemRoundStoreAdapter();

  return new ReviewWorkflowService({
    gitPort,
    reviewerPort,
    reportStorePort,
    snapshotStorePort,
    telemetryPort,
    verdictCachePort,
    roundStorePort,
    clock,
    logger,
    assertPatterns,
    testPathPatterns,
    testDeclarationPatterns,
    executionPort,
    execution,
  });
}

/**
 * Public facade maintaining backward compatibility with existing Git pre-commit hooks and tests.
 *
 * @param {{
 *   cwd?: string,
 *   git?: (args: string[], cwd: string) => Buffer,
 *   omp?: (prompt: string, cwd: string, timeoutMs?: number) => { status: number, stdout?: string, stderr?: string },
 *   now?: Date,
 * }} [options]
 * @returns {Promise<{ exitCode: number, skipped: boolean, verdict?: 'PASS'|'BLOCK', reportPath?: string }>}
 */
export async function runReview({
  cwd = process.cwd(),
  git,
  vendoredFiles,
  omp,
  ompOptions,
  now = new Date(),
  logger,
  progress,
  telemetry,
  assertPatterns,
  testPathPatterns,
  testDeclarationPatterns,
  executionPort,
  execution,
} = {}) {
  const service = createReviewWorkflowService({
    git,
    vendoredFiles,
    omp,
    ompOptions,
    clock: () => now,
    logger,
    progress,
    telemetry,
    assertPatterns,
    testPathPatterns,
    testDeclarationPatterns,
    executionPort,
    execution,
  });

  const result = await service.execute({ cwd });
  return result.toJSON();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stderr.write(formatReviewProgress({
      state: 'started',
      message: 'commit hook started; collecting staged change',
      elapsedMs: 0,
    }) + '\n');
    const result = await runReview({ progress: writeReviewProgress, vendoredFiles: loadCanonicalVendoredFiles });
    if (result.skipped) process.stderr.write('reviewer-kit SKIPPED: no reviewable staged changes\n');
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`reviewer-kit INFRA_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
