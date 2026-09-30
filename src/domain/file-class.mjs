/**
 * File class taxonomy used to route review depth per staged file.
 *
 * Classes (checked in priority order):
 * - `executable`  — code, shell scripts, CI workflows, git hooks, and build
 *   files the repository or CI can execute. Executable class always wins over
 *   directory prefixes so commit-time code never downgrades the review profile.
 * - `test`        — test files themselves (matched by suspicion-map test patterns).
 * - `prompt`      — agent/skill contract files (agents/*.md, skills/SKILL.md and
 *   their skill docs).
 * - `spec`        — specification corpus (.specs/, *.feature, *_schema.md).
 * - `docs`        — prose/documentation (markdown, text, rst).
 * - `config`      — data/config/manifests (json/yaml/toml/xml/ini/env/lock,
 *   package manifests).
 * - `data`        — everything else (audit reports, fixtures, binaries, unknowns).
 *
 * The classifier is deterministic and path-only — it never inspects file content.
 */

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
  // Jenkins shared libraries and Windows Python launchers execute.
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
  'taskfile', 'sconstruct', 'sconscript', 'meson.build', 'buck', 'workspace',
  // Bazel canonical BUILD (basename 'build') and Ant build.xml execute at
  // build time — '.xml' alone would classify Ant as config.
  'build', 'build.xml',
  '.travis.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml',
  '.drone.yml', 'appveyor.yml', 'cloudbuild.yaml',
  // Task/build engines that embed command runners.
  'taskfile', 'sconstruct', 'sconscript', 'meson.build', 'buck', 'workspace',
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

/**
 * @param {string} filePath repository-relative staged path
 * @returns {'executable'|'test'|'prompt'|'spec'|'docs'|'config'|'data'}
 */
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
  if (lower === '.cargo/config.toml' || lower === '.cargo/config') return 'executable';
  if (lower.startsWith('.github/workflows/') || lower.includes('/.github/workflows/')) return 'executable';
  if (lower.startsWith('.github/actions/') || lower.includes('/.github/actions/')) return 'executable';
  if (lower.startsWith('.circleci/') || lower.includes('/.circleci/')) return 'executable';
  if (lower.startsWith('.buildkite/') || lower.includes('/.buildkite/')) return 'executable';
  if (lower.startsWith('.husky/') || lower.includes('/.husky/')) return 'executable';
  if (lower.startsWith('.githooks/') || lower.includes('/.githooks/')) return 'executable';
  if (lower.startsWith('ci/')) return 'executable';
  if (lower.startsWith('.vscode/') || lower.includes('/.vscode/')) return 'executable';
  if (lower === '.cargo/config.toml') return 'executable';
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
    'codeowners2', 'dockerignore', 'gitkeep', 'keep',
  ]);
  if (!basename.includes('.') && !DOTLESS_DOCS.has(basename)) return 'executable';
  if (basename.endsWith('.dockerfile')) return 'executable';
  // Maven extension/config dir runs args and injected jars at build time.
  if (lower.startsWith('.mvn/') || lower.includes('/.mvn/')) return 'executable';
  // IntelliJ run configurations execute commands in-repo.
  if (lower.startsWith('.idea/runconfigurations/') || lower.includes('/.idea/runconfigurations/')) return 'executable';
  if (basename === '.gitmodules') return 'executable';
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

/**
 * Classify every changed path, applying the repository's test-path patterns so
 * executable-looking test files are marked `test`, not `executable`.
 *
 * `classifyFilePath` itself stays path-only by contract; the git mode signal
 * arrives separately: a path the index declares executable (mode 100755)
 * upgrades to `executable` BEFORE the test re-tag, so an extensionless
 * script keeps the full profile while a +x test file stays `test`.
 *
 * @param {string[]} paths
 * @param {(p: string) => boolean} isTest
 * @param {Map<string,string>} [modeByPath] staged git mode per path ('100755', ...)
 * @returns {{ path: string, fileClass: string }[]}
 */
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

/**
 * Decide which review profile the orchestrator should run for this diff.
 * `full` — at least one `executable` or `test` file changed (runtime code or test logic moved).
 * `spec-docs` — no executable/test changes; prompt/spec/docs/config/data only.
 *
 * @param {{ path: string, fileClass: string }[]} entries
 * @returns {'full'|'spec-docs'}
 */
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
