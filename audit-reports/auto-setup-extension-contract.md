# Auto-Setup Extension Contract Verification & Architecture Record

## Executive Summary

This architecture record documents the runtime contract grounding for automatic Git pre-commit hook configuration in `omp-reviewer-kit`. When users install the plugin (`omp plugin install github:stgmt/omp-reviewer-kit`), they should not be required to remember or manually run `/reviewer-kit:setup`. Instead, when OMP initializes in a Git repository, the extension automatically inspects the environment and installs or updates the pre-commit hook safely.

If existing hooks or custom hook directories conflict, the extension strictly leaves the repository untouched and surfaces a conflict status.

---

## 1. Pinned Source Contracts vs. Live Runtime

- **Pinned Development Contract**: `@oh-my-pi/pi-coding-agent` v17.3.7 located at `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/`.
- **Live Runtime Environment**: `omp --version` currently reports `omp/18.1.6` on Windows x64.
- **Compatibility Invariant**: The extensibility contracts documented below are identical between 17.3.7 and 18.1.6. The 17.3.7 source provides exact TypeScript typings and execution flow, while live tests verify runtime behavior on 18.1.6.

---

## 2. Grounded Contract Evidence Table

| Claim / Subsystem | Source Path & Line Anchor | Observed Contract & Semantics |
| :--- | :--- | :--- |
| **Extension Handler Type** | `src/extensibility/extensions/types.ts:1159` | `export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R \| void> \| R \| void;`<br/>Handlers may be synchronous or return a Promise (async). |
| **`session_start` Lifecycle Event** | `src/extensibility/extensions/types.ts:1196` | `on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;`<br/>Registered on `ExtensionAPI` (`pi.on("session_start", ...)`). |
| **Working Directory in Context** | `src/extensibility/extensions/types.ts:457, 666, 837, 852` | `ExtensionContext.cwd: string;`<br/>Provides the absolute path to the active project working directory. |
| **Awaited Lifecycle Execution (CLI)** | `src/modes/runtime-init.ts:147` | `await runner.emit({ type: "session_start" });`<br/>OMP waits for `session_start` handlers to finish before interactive turn or task loop begins. |
| **Awaited Lifecycle Execution (Tasks)** | `src/task/executor.ts:3287` | `await awaitAbortable(extensionRunner.emit({ type: "session_start" }));`<br/>Task and subagent executors await `session_start`. |
| **Handler Timeout & Failure** | `src/extensibility/extensions/runner.ts:85, 102, 1285-1306` | `export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;`<br/>Generic handlers have a 30s budget. Failures/timeouts are trapped and routed to extension error listeners / logging, not crashing the host process. |
| **Skill Discovery Sources** | `src/discovery/builtin.ts:283-334` | Discovers skills across three hierarchical locations:<br/>1. Project-level: `<repo>/.omp/skills/`<br/>2. User-level: `~/.omp/agent/skills/`<br/>3. Managed (auto-learn): `~/.omp/agent/managed-skills/` |
| **Fresh Session Skill Loading** | `src/sdk.ts:772-780, 1322-1328` | On session instantiation, `discoverSkills(cwd, agentDir, ...)` resolves active skills dynamically from disk without caching stale lists across CLI process boundaries. |
| **Review Execution Isolation** | `src/infra/omp-cli-reviewer-adapter.mjs:38-39` | `spawn('omp', ['-p', '--model', '@slow', '--no-session'], { cwd })`<br/>Each commit triggers a fresh, headless, out-of-process OMP review that re-evaluates all skills and files at commit time. |

---

## 3. Architecture & Design Decisions

### Decision 1: Awaited `session_start` vs. Detached Background Task

- **Decision**: Auto-setup runs directly inside the awaited `session_start` hook handler, bounded by local Git and filesystem checks (~5-20ms).
- **Rationale**:
  - A detached background task (`setTimeout` or floating promise) creates a race condition: a user opening OMP and immediately committing via terminal before the hook runs would bypass the review.
  - A fast CLI invocation (`omp -p ...`) could exit before a floating task finishes, resulting in half-written runner files.
  - The local checks (`git rev-parse`, `git config`, reading `<repo>/.githooks/pre-commit`) are purely synchronous/local I/O and easily complete well within a fraction of a second, orders of magnitude below the 30s `EXTENSION_HANDLER_TIMEOUT_MS`.

### Decision 2: Single Source of Truth for Pre-Commit Hook

- **Problem**: `PRE_COMMIT_HOOK_TEMPLATE` was previously duplicated as a hardcoded JS template string in `src/application/installer-service.mjs` and as a file in `templates/githooks/pre-commit`.
- **Decision**: Remove the string constant from `installer-service.mjs`. Read `templates/githooks/pre-commit` from `#pluginRoot` (resolved via `import.meta.url`).
- **Safety**: Normalizing line endings (`\r\n` vs `\n`) ensures cross-platform consistency on Windows and POSIX.

### Decision 3: Fail-Closed Non-Destructive Conflict Handling

- **Principles**:
  1. If `core.hooksPath` is configured and points anywhere other than `.githooks` (e.g. `.husky`, `.hooks`, custom tool), return `state: "conflict"`. Never overwrite or hijack existing hook configurations.
  2. If `core.hooksPath` is unset, inspect the native Git hook directory (`git rev-parse --git-path hooks`). If any active hooks exist (excluding sample files `*.sample`), return `state: "conflict"`. Setting `core.hooksPath=.githooks` would disable those existing hooks.
  3. If `.githooks/pre-commit` exists and its content differs from the plugin's canonical template, return `state: "conflict"`. Do not attempt to append or chain scripts, as arbitrary hooks may `exec` or `exit`.
  4. Only when no conflict exists: create directories, install the hook and runner, set file permissions (`0755` on non-Windows), and configure `core.hooksPath=.githooks`.

### Decision 4: Write-Only-On-Change & Atomic Write

- **Decision**: Compare target file bytes with desired content before writing. If identical, perform zero writes. When writing is necessary, write to a sibling temporary file and atomically rename (`rename` / `replace`).
- **Rationale**:
  - Avoids mutating file modification timestamps (`mtime`) on every OMP launch.
  - Prevents race conditions and partial file reads if multiple OMP sessions start concurrently in the same workspace.

---

## 4. Failure Modes & Mitigations

| Failure Mode | Detection | Mitigation |
| :--- | :--- | :--- |
| Non-Git directory | `git rev-parse --is-inside-work-tree` fails | `session_start` checks `status().state === "not-git"` and silently returns without error or status item. |
| Existing Husky hook | `core.hooksPath` resolves to `.husky` | Returns `state: "conflict"`, logs warning, sets status bar `reviewer-kit: conflict`. Repository files unchanged. |
| Custom `.githooks/pre-commit` | File exists with unexpected SHA / bytes | Returns `state: "conflict"`, leaves file untouched. |
| Git CLI missing | `git` command not found in PATH | Trapped in `status()`, returns `state: "inactive"`, error surfaced through `doctor()`. |
| Read-only filesystem / permission error | Filesystem write throws `EACCES`/`EPERM` | Trapped in `session_start`, logged via `pi.logger.warn`, status bar set to `reviewer-kit: error`. OMP launch continues unimpeded. |

---

## 5. Verification & Rollback Strategy

- **Verification**:
  - Flat Node.js test suites in `tests/extension.test.mjs` verifying all states (`active`, `conflict`, `inactive`, `not-git`, `updated`, `installed`).
  - Git pre-commit E2E in `tests/e2e-git-hook.test.mjs`.
  - Live OMP integration in `tests/live-e2e-omp.test.mjs`.
- **Rollback**:
  - If auto-setup causes unexpected friction, it is completely governed by `src/extension.mjs:session_start`. Disabling the automatic invocation in `src/extension.mjs` reverts hook installation to explicit manual `/reviewer-kit:setup` without modifying domain logic or runner code.
