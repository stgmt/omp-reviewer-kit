# RESEARCH — slop-v2: тестово-ревьюная машинерия dev-pomogator

> Статус: исследование завершено 2026-09-19. Каждое утверждение привязано к файлу-источнику
> в `E:/repos/dev-pomogator` (далее — `$DP`). Непроверенное помечено `[UNVERIFIED]`.
> Цель документа: полная карта того, что портировать в `slop` v2 (omp-reviewer-kit),
> как это работает у источника, что выдаёт, что требует, когда триггерит.

## 0. Источники

| Источник | Что дал |
|---|---|
| Пользовательский запрос | Скоуп: «написание тестов, ревью тестов, проверка на говно, мутации, эджи, философия» |
| `$DP/.claude/skills/` (60 dirs) | Доктрина: strong-tests (64.8KB), tests-create-update, run-tests, stryker-mutation, dedup-tests, suite-failure-triage, real-fixtures, bdd-migrator, observability-review, verify-generic-scope-fix, answer-simple, deep-insights, spec-review, spec-reality-check, corpus-health, requirements-chk-matrix, variant-matrix-build, spec-generator-dev/orchestrator |
| `$DP/.claude/agents/` + `.codex/agents/` | test-author, bdd-migrator, spec-phase-{discovery,requirements,audit,finalization} |
| `$DP/.claude/rules/` + `.carl/rules/` | 63 файла правил (18 категорий) (stubs → canonical bodies) |
| `$DP/.claude-plugin/hooks.json` + `tools/hook-service/registry.json` | 57 маршрутов хуков через HTTP-демон |
| `$DP/tools/` (69 dirs) | Движки: test-quality, tui-test-runner, steps-validator, stryker-mutation, spec-graph, spec-mcp-server, claim-evidence-gate, hook-service |
| `$DP/tests/` + корневые конфиги | Собственный стенд: cucumber.json, vitest/stryker конфиги, Docker |
| `$DP/.specs/` (84 spec dirs) | Живая спек-система, в которую встроены тесты |

## 1. Архитектура в одном абзаце

dev-pomogator — это Claude Code / Codex плагин, где качество тестов обеспечивается **четырьмя слоями**, а не одним инструментом:

1. **Доктрина (skills)** — инструкции, которые модель читает по триггеру: как писать сильные тесты, как читать mutation-отчёт, как делать фикстуры.
2. **Принуждение (hooks)** — детерминистические гейты на событиях `PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`/`UserPromptSubmit`, разведённые через единый HTTP-демон `hook-service` (127.0.0.1:42619). Блок = exit 2 → `permissionDecision:'deny'` (PreToolUse) или `{decision:'block'}` (Stop).
3. **Граф спек (spec-graph + spec MCP door)** — `.specs/<slug>/` документы парсятся в граф FR→AC→@featureN→Scenario→TASK; результаты cucumber-прогонов (NDJSON) ингестятся в граф; вердикты покрытия (`UNCOVERED_FR`, `TASK_UNTESTED`, `TASK_NO_OWN_SCENARIO`, `TASK_TEST_QUALITY`) вычисляются детерминистически и **блокируют** честное закрытие задач.
4. **Агенты** — специализированные сабагенты (`test-author`, `bdd-migrator`, `spec-phase-*`), спавнящиеся на конкретные gap-вердикты графа.

Ключевая идея: **«done» — это вычисляемое состояние, а не заявление агента.** Задача DONE только если все привязанные сценарии PASSED в каноническом прогоне И качество теста не WEAK/FAKE-POSITIVE-RISK. Любой обход логируется в escape-hatch JSONL и виден в observability-отчёте.

## 2. Сквозной пайплайн (как работает end-to-end)

```
агент пишет продакшн-код (Write|Edit *.ts/*.py/*.cs/*.go)
  └─ PostToolUse → test-quality/posttool-jit.ts            [emit-only]
       ast-grep детект: collection-returning / N×M loop / composition chain
       → additionalContext: «напиши invariant-тесты» (никогда не блокирует)
       → suppression `// strong-tests:skip <reason≥8>` → .claude/logs/strong-tests-skips.jsonl

агент пишет тест
  ├─ PreToolUse Write|Edit → bdd-only-test-guard           [BLOCK exit 2]
  │    DENY: новый *.test.ts/*.spec/test_*.py/*Tests.cs (BDD-only политика)
  │    DENY: Edit, увеличивающий число test-cases в существующем non-BDD файле
  │    ALLOW: .feature, tests/step_definitions/, tests/hooks/, fixtures
  │    escape: BDD_ONLY_SKIP=1 → .claude/logs/bdd-only-escapes.jsonl
  ├─ PostToolUse Write|Edit → test-quality/compliance_check [BLOCK]
  │    9 антипаттернов в тест-файле (source-scan, existence-only, weak-assertion,
  │    response-ok-only, response-status-only, silent-skip, silent-catch,
  │    trivial-input, unsafe-json; единый набор для TS+C#)
  │    → block «Run /tests-create-update»; маркер .compliance-marker.json (cooldown 30m, retries 1)
  └─ PostToolUse Write|Edit → bdd-quality-judge            [advisory]
       .feature/step_def → LLM-судья (DeepSeek, 6s) по рубрике strong-tests §6.5
       → additionalContext «слаб — <reason>»; никогда не блокирует

агент запускает тесты (Bash)
  ├─ PreToolUse Bash → tui-test-runner/test_guard          [BLOCK exit 2]
  │    DENY: npm test|npx vitest|npx jest|pytest|dotnet test|cargo test|go test
  │    DENY: host cucumber/run-bdd.mjs в любой форме ([test-guard:host-bdd])
  │    → deny-message содержит готовую команду-обёртку test_runner_wrapper.ts
  ├─ PreToolUse Bash → tui-test-runner/build_guard         [BLOCK exit 2]
  │    DENY: stale build (src/ новее dist/, SKIP_BUILD=1, dotnet --no-build)
  └─ PostToolUse Bash → bash-post-test/ingest              [emit-only]
       после test:bdd/cucumber: режет канонический .last-test-run.ndjson
       на per-spec шарды .specs/<slug>/.test-results.ndjson

агент пытается остановиться (Stop)
  ├─ Stop → plan-pomogator/test-spec-gate                  [BLOCK]
  │    tests/ изменены без .specs/.feature → «обнови спеки»
  ├─ Stop → test-quality/dedup_stop                        [BLOCK]
  │    tests/ в diff → «Run /dedup-tests» (jscpd дедупликация)
  ├─ Stop → claim-evidence-gate                            [BLOCK]
  │    классификатор claims: works-done / analysis-verdict / not-found / verified-marker
  │    → требует tool-evidence в окне тёрна; LLM-судья (Meridian/DeepSeek) на серых зонах
  │    → anti-loop: hash+cooldown+maxRetries+noProgressStreak+awaitingAsync
  ├─ Stop → spec-graph/test_quality_gate_stop              [BLOCK]
  │    tracked-modified .specs/<slug> → conformance findings:
  │    DONE-задача без STRONG теста (TASK_TEST_QUALITY/TASK_UNTESTED/UNVERIFIED_COMPLETION)
  │    → block; escape [skip-test-quality: ≥8] → test-quality-escapes.jsonl
  └─ Stop → answer-simple/answer_simple_stop               [BLOCK]
       жаргон/внутренние коды в финальном сообщении → требует plain-language rewrite

спек-конвейер (отдельная ось)
  ├─ PreToolUse Write|Edit .specs/** → specs-validator/phase-gate   [BLOCK]
  │    файл фазы N нельзя писать, пока ConfirmStop фазы N-1 не подтверждён
  ├─ PreToolUse Write|Edit .specs/** → spec-conformance-guard       [BLOCK]
  │    MALFORMED_FRONTMATTER/GHERKIN, DUPLICATE_DEFINITION, INVALID_ANCHOR
  ├─ PreToolUse Read|Grep|Glob|Edit|Write|Bash → spec-access-guard  [BLOCK]
  │    любой доступ к .specs/ вне MCP-двери → deny (MCP-rails enforcement)
  ├─ PreToolUse ExitPlanMode → plan-pomogator/plan-gate             [BLOCK]
  │    10-секционный формат плана, requirements extraction, prompt relevance
  └─ UserPromptSubmit → specs-validator/validate-specs              [advisory]
       @featureN coverage MD↔.feature, per-spec validation-report.md
```

## 3. Слой 1 — доктрина (skills)

### 3.1 strong-tests — ядро философии (64.8KB, 1033 строки)

`$DP/.claude/skills/strong-tests/SKILL.md`. Триггер (дословно): «тесты слабые / fake-positive / проходят но баги пропускают / coverage высокий но mutation score низкий», «напиши крепкие тесты», «mutation testing», «шаг UndefinedStep / не найден но метод есть». `allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Skill`.

**Доктрина:**
- §2 Pre-write checklist — 4 скана ДО первого ассерта: (1) ≥5 инвариантов на функцию (roundtrip, idempotence, commutativity, monotonicity, cardinality, bounds); (2) ≥3 категории входа (happy/null/empty/very-large/unicode/negative/boundary/wrong-type; PBT при ≥4); (3) ручной mutation gutcheck по строкам («flip `>`→`>=` — поймает ли ассерт?»); (4) выбор фреймворка.
- §3 Матрица стеков: TS vitest+fast-check+Stryker (порог 70%), Python pytest+Hypothesis+mutmut, Java JUnit5+jqwik+PIT, C# xUnit+FsCheck+Stryker.NET, Go+gopter+go-mutesting, Rust+proptest+cargo-mutants. Выбор через AskUserQuestion (нет авто-детекту для полиглота).
- §4 Таблица 8 антипаттернов с весами: PERMISSIVE_MATCHING(10), ASSERTION_ROULETTE(10), MAGIC_NUMBER(5), HAPPY_PATH_ONLY(20), TAUTOLOGICAL(20), TRIVIAL_INPUT(30), SILENT_SKIP(20), MISSING_AWAIT(30). Score = 100 − Σ(weight×count); ≥85 GOOD, 60–84 FAIR, <60 WEAK. Маппинг в канонический вердикт: GOOD→STRONG, FAIR/WEAK→WEAK, любой fake-positive smell→FAKE-POSITIVE-RISK.
- §5 12-Point Self-Eval — обязательный финальный артефакт каждого режима: mutation gutcheck, специфичность ассертов, negative:positive ≥1:2, error-path coverage, ≥5 инвариантов, границы входов, failure messages, отсутствие parallel-impl, отсутствие импорта продакшн-хелперов для expected, отсутствие тавтологии, отсутствие тривиальных входов, self-challenge-фраза на каждый ассерт. Kill-rate-readiness: HIGH = ≥10 PASS + 0 FAIL на #1/#5/#12.
- §6 Пять режимов: 6.1 Greenfield, 6.2 Audit, 6.3 Mutation-feedback loop (≤5 итераций до порога; Import Guard pattern для vitest; LLM survivor analysis: run-mutation --analyze-survivors → survivors-batch-prompt → Agent() per batch → merge-survivor-verdicts), 6.4 JiT auto-trigger (PostToolUse hook, emit-only), 6.5 BDD scenario authoring (= контракт test-author).
- §8 Anti-халява invariants (hard-NOs): нет тестов без 12-point self-eval; coverage % никогда не доказательство силы (только kill rate / PBT 1000-run); эквивалентные мутанты не удалять молча (`[EQUIVALENT_SUSPECT]`); не блокировать сессию >2мин; нет «работает» без проверки в реальной среде; не слепое доверие LLM-вердиктам об эквивалентности.

**Скрипты** (`scripts/`): `detect-invariant-candidates.ts` (ast-grep детектор JiT: collection-returning/nxm-overlap/composition-chain; стеки ts/py/cs/go), `run-mutation.ts` (диспетчер stryker/mutmut/pit/stryker-net/cargo-mutants/go-mutesting; exit 0/1/2/3), `classify-tests.ts` (Unit/Integration/E2E классификатор + `--apply` инжекция маркеров), `survivors-batch-prompt.ts` (батчи LLM-промптов с бюджетом USD), `merge-survivor-verdicts.ts` (слияние вердиктов в отчёт), `autopilot-mutation.ts` (v0.6.0 bookkeeping-цикл).

**Evals** (`evals/`): `evals.json` — кейсы `{good, broken, candidates[]}`; рубрика: STRONG iff PASS на good AND FAIL на broken; PASS на обоих = FAKE-POSITIVE-RISK. `run-evals.ts` прогоняет кандидатов против обеих реализаций. Это и есть «проверка тестов на говно» в чистом виде — тест обязан уметь падать.

### 3.2 tests-create-update — write-time профилактика (15.9KB)

Триггер: «create/write/update/add test», «создай/напиши тест», «регрессионный тест» + auto-trigger PostToolUse-хуком `compliance_check` при правках тест-файлов. Доктрина: Step 0 — Explore-агент извлекает observable behavior; Step 1 — таблица BAD→GOOD ассертов с частотами из аудита 258+ issues (pathExists-only 33x, toBeDefined 28x, res.ok без body 11x, source-scan toContain 35x…); Step 2 — аудит shared helpers (import, не дублировать); Step 3 — 21 NEVER-правил (нет if/else вокруг ассертов, нет forEach-ассертов без length-guard, нет missing await, нет try/catch-логирования, нет zero-expect it(), нет тавтологий, нет setTimeout-ожиданий, нет мутации tracked-файлов без capture/restore, нет `.length===N` на динамических реестрах, нет side-channel-only coverage); Step 4 — 16-строчный compliance report PASS/FAIL.

### 3.3 run-tests — централизованный раннер (17.6KB)

Триггер: любой `npm test`/`pytest`/`dotnet test`/`cargo test`/`go test` + non-test long bg через `--framework generic`. Обёртка `test_runner_wrapper.ts --framework <f> -- <cmd>`: пишет YAML-статус в `.dev-pomogator/.test-status/status.<session>.yaml` (heartbeat 2s) + persistent log `test.<session>.log` + bg-маркер `.bg-task-active` (читают bg-task-guard и claim-evidence-gate). Docker-путь: `scripts/docker-test.sh` / `docker-bdd.sh` — единственный санкционированный путь для BDD. Step 5b: сбор `{testId: verdict}` → `test-quality-producer.ts` → `.dev-pomogator/.test-quality.json` (task-keyed, worst-wins).

### 3.4 stryker-mutation — мутации как продукт (7.6KB)

Триггер: «mutation testing», чтение mutation-отчёта, решение «survivor = слабый тест vs эквивалент vs coverage gap». Конфиги: `stryker.real.config.mjs` (vitest perTest, реальные модули, Docker), `stryker.specgen.config.mjs` (42 файла specgen, ignoreStatic), `stryker.bdd.config.mjs` (официальный `@stryker-mutator/cucumber-runner`, HOST, профиль `stryker-bdd` — никогда не default, чтобы не клобберить канонический ndjson). Score = (killed+timeout)/(killed+timeout+survived+noCoverage). **Верифицированный дефект**: агрегат cucumber-runner НЕдетерминирован (4 одинаковых прогона → 32/40/67/70 survivors; причина — переиспользование `supportCodeLibrary` + singleton formatter → cross-mutant state bleed). Детерминистическая альтернатива: `tools/stryker-mutation/verify-kill.ts` — inject→FAIL→restore→re-run; exit 0 iff KILLED. Состояние: `.dev-pomogator/.mutation-state.json`.

### 3.5 dedup-tests (2.6KB)

Триггер: блок `dedup_stop` или ручной вызов. jscpd-скан `tests/` (min-tokens 30, min-lines 3) → классификация Exact/Near/Structural/Coincidental → экстракция в `tests/e2e/helpers.ts` с подтверждением пользователя.

### 3.6 suite-failure-triage (7.0KB)

Триггер: «разбери падения», «это мой регресс или нет», «флейк или баг». Одно правило: **никогда не доверять dirty-tree падению** (docker `COPY . .` тащит некоммиченные файлы). Процедура: полный список FAIL из `.docker-status/test-run-*.log` → clean `git worktree` от HEAD + полный прогон → второй прогон на детерминизм → атрибуция `git log origin/main..HEAD` → вердикты mine/pre-existing-main/dirty-tree-artifact/isolation-bug/genuine-flake.

### 3.7 real-fixtures (6.8KB)

Триггер: «сделай нормальную фикстуру», «захвати реальный вывод». Универсальный 6-шаговый рецепт: назвать producer + capture-команду → захватить ОДИН реальный сэмпл → покрыть result-space (pass/fail/skip/undefined, 2xx/4xx/5xx, empty/single/many, unicode) → обрезать до валидного минимума (сохраняя dependency chain + schema records) → provenance README + ground-truth → интеграционный тест с reconcile к сводке продюсера. Скрипт `extract-ndjson-subset.ts` — триммер Cucumber Messages NDJSON.

### 3.8 observability-review (3.8KB)

Триггер: «где споткнулся», «посмотри логи», аудит обходов гейтов. Одна команда `tools/observability/observe.ts [--json]` → 4 панели: escape-hatch логи (`*-escapes.jsonl`), последний BDD-прогон (failed/undefined/ambiguous), SELF_IMPROVE pending, ошибки логов → 🟢/🟡. Файлы-only, dep-safe.

### 3.9 verify-generic-scope-fix (5.6KB, `disable-model-invocation: true`)

Триггер: pre-commit при добавлении 2+ элементов в enum/switch/array, гейтящий shared codepath (`*Service|*Validator|*Gate|*Guard|*Policy|*Filter.ts`, функции `is*|should*|can*|has*|must*|check*|validate*|verify*|allow*|permit*`). 5 шагов: dedicated-flow grep → dataflow trace → value reachability → классификация traced/unreachable/conditional → маркер `.claude/.scope-verified/<session>-<sha>.json`. Unreachable → `should_ship:false` → `scope-gate-guard` deny. `[VERIFIED DORMANT: scope-gate-guard.ts существует в tools/scope-gate/ но не зарегистрирован ни в hooks.json, ни в hooks.legacy.json, ни в settings.json; нет вызывающих]`

### 3.10 answer-simple (20.7KB)

Триггер: «проверь черновик», «ревью ответа». Аудит черновика: BYTE-FAITHFUL (запрет дофантазии), микроистория (5 якорных точек), внутренние коды (FR-N/AC-N/@featureN/PLUGIN-N — флаг; общий инженерный словарь — нет), multi-select >2 опций. Enforcement — Stop-хук `answer_simple_stop.ts`.

### 3.11 deep-insights (5.4KB)

Агрегация `~/.claude/usage-data/facets/*.json` → friction trends, satisfaction, tool errors → quantitative evidence для `/suggest-rules`. Скрипт `aggregate-facets.sh` (bash+jq).

### 3.12 session-pilot (TUI dashboard + Pilot API)

Worktree dashboard plugin для Claude Code (10+ ворктри). Триггеры: «открой dashboard», «покажи мои ворктри», «launch claude в worktree X», «resume claude в worktree Y», «создай worktree для Z». Инструменты: `tools/session-pilot/` — `autostart_hook.ts` (SessionStart), `frontend.py`, `handlers.py`, `indexer.py`, `process_scanner.py`, `diagnose.py`, `claude_paths.py`, `create-launcher.{ps1,sh}`, `install.{ps1,sh}`. Тесты: `tests/tui/` pytest-сьют (7 файлов) + `.github/workflows/session-pilot.yml` (Python 3.12, backend + delivery-path guards + cold-start). Правило `tui-pilot-tests` требует TUI тесты только через Pilot API (запрет file-inspection).

### 3.13 Dogfood-скиллы (runtime verification)

- `runtime-dogfood` — «find dead/broken/silently-empty entrypoints in ANY tool surface by DRIVING each one against REAL data and recording what it actually returns — not grep, not a green suite». Универсальный runtime-верификатор.
- `spec-mcp-dogfood` — «drive EVERY tool's real handler against the REAL spec graph and record what each actually returns, so you find live/dead/buggy tools by RUNTIME evidence». Специализированный dogfood для spec-MCP двери.
- `spec-mcp-usability-dogfood` — «harvest REAL usability friction with the spec-graph MCP door out of Claude Code SESSION TRANSCRIPTS, so the painful spots surface as DATA (errors, retries, door-bypass)». Анализ транскриптов для UX-фрикции.


## 4. Слой 2 — принуждение (hooks + tools)

### 4.1 Транспорт: hook-service

`.claude-plugin/hooks.json` биндит КАЖДЫЙ хук на `client.mjs "<Event>/<group>/<hook>"` → POST `http://127.0.0.1:42619/v1/dispatch/<route>` (bearer token из `%LOCALAPPDATA%/dev-pomogator/hook-service/`). `server.mjs` — единый демон: loopback-only, timing-safe token, `GET /health`, spawn `.ts` через `tools/_shared/bootstrap.cjs` (tsx), timeout per route, ошибки → `failures.jsonl` (ротация 1MB, секреты редактятся). `ensure-up.mjs` — lease-lock + kill только owned-демона (identity = version+rootFingerprint+digests). `registry.json` генерируется из `.claude-plugin/hooks.legacy.json` (539 строк, 57 команд — прямые sh-команды до сервиса) через `registry.mjs::buildRegistry` → `generate-registry.mjs`. **Семантика блока**: exit 2 → structured deny; exit ≠0 non-2 → 503 → клиент fail-open (пустой stdout — хук видит отсутствие deny и пропускает). Все managed-хуки fail-open по транспорту.

### 4.2 Тестовые гейты (проверено по исходникам)

| Хук | Событие/матчер | Что делает | Блок? | Состояние |
|---|---|---|---|---|
| `test-quality/compliance_check.ts` | PostToolUse Write\|Edit | 9 антипаттернов в тест-файлах (единый набор TS+C#) | block → «Run /tests-create-update» | `.compliance-marker.json`, cooldown 30m, retries 1 |
| `test-quality/dedup_stop.ts` | Stop | tests/ в `git diff --numstat` | block → «Run /dedup-tests» | `.dedup-marker.json`, cooldown 10m |
| `test-quality/posttool-jit.ts` | PostToolUse Write\|Edit (prod code) | ast-grep детект инвариант-кандидатов | emit-only additionalContext | `strong-tests-skips.jsonl` — **DORMANT: не зарегистрирован ни в одном манифесте** |
| `bdd-quality-judge/` | PostToolUse Write\|Edit (.feature/step_def) | LLM-судья DeepSeek по рубрике §6.5 | advisory only | — |
| `bdd-only-test-guard/guard.ts` | PreToolUse Write\|Edit | DENY новых non-BDD тестов + shrink-only для существующих | deny exit 2 | `bdd-only-escapes.jsonl` |
| `tui-test-runner/test_guard.ts` | PreToolUse Bash | DENY прямых test-команд + host-BDD | deny exit 2 + paste-ready wrapper | — |
| `tui-test-runner/build_guard.ts` | PreToolUse Bash | DENY stale build перед тестами | deny exit 2 | `SKIP_BUILD_CHECK=1` |
| `bash-post-test/ingest.ts` | PostToolUse Bash | шарды ndjson по спекам | emit-only | `.specs/<slug>/.test-results.ndjson` |
| `plan-pomogator/test-spec-gate.ts` | Stop | tests/ без .specs/.feature | block | `.test-spec-marker.json`, baseline per session |
| `spec-graph/test_quality_gate_stop.ts` | Stop | DONE без STRONG теста | block | `.test-quality.json` verdicts + escapes log |
| `claim-evidence-gate/` | Stop | claims→evidence + LLM-судья + anti-loop | block | `.claim-evidence-gate-marker.json`, fires log |
| `answer-simple/answer_simple_stop.ts` | Stop | жаргон в финальном сообщении | block | `.answer-simple-marker.json` |
| `anchor-integrity/anchor_gate_stop.ts` | Stop + SessionStart | битые link-anchors в .specs | block | escapes log |
| `spec-conformance-guard/` | PreToolUse Write\|Edit .specs | malformed frontmatter/gherkin, dup anchors | deny exit 2 | spec-check-log |
| `spec-access-guard.ts` | PreToolUse Read\|Grep\|Glob\|Edit\|Write\|Bash | .specs только через MCP-дверь | deny exit 2 | `spec-access-escapes.jsonl` |
| `specs-validator/extension-json-meta-guard.ts` | PreToolUse Write\|Edit | защита манифестов (.claude-plugin/hooks.json, plugin.json, .mcp.json, settings.json) от удаления регистраций | deny exit 2 | — |
| `spec-conformance-push/spec-conformance-push.ts` | PostToolUse Write\|Edit | агрегированные conformance findings → `<system-reminder>` (throttle 3s, FR-28) | emit-only | throttle journal |
| `anchor-integrity/anchor_check_post.ts` | PostToolUse Write\|Edit | битые link-anchors в .specs → `<system-reminder>` + fix-команда | emit-only (SOFT) | — |
| `research-workflow-marker-guard/` | PostToolUse Skill | маркеры [VERIFIED]/[UNVERIFIED]/etc в research-workflow выводе | emit-only | — |
| `spec-backlog/auto-ingest-hook.ts` | Stop | auto-ingest cross-spec-reconcile findings → backlog (1/сессия) | emit-only | touch-file marker |
| `spec-backlog/session-summary-hook.ts` | SessionStart | one-screen summary открытых backlog-записей | emit-only | — |
| `session-pilot/autostart_hook.ts` | SessionStart | автозапуск session-pilot dashboard | emit-only | — |
| `specs-validator/phase-gate.ts` | PreToolUse Write\|Edit .specs | фазовая изоляция (ConfirmStop) | deny exit 2 | `.progress.json` |
| `specs-validator/form-guards-dispatch.ts` | PreToolUse Write\|Edit .specs | 5 форм-гардов (user-story/task/design/chk/risk) | deny exit 2 | `form-guards.log` |
| `spec-authoring-steer/steer.ts` | PreToolUse apply_spec_change\|Write | steer к automator sub-skills | SHADOW default / deny при enforce | — |
| `reqnroll-ce-guard/ce_slash_guard.ts` | PreToolUse Write\|Edit .cs | Reqnroll step-атрибут с `/` без regex-якорей | deny exit 2 | — |
| `out-session-advisor/git-guard.ts` | PreToolUse Bash | `git add -A/.` + cross-session staged conflicts | warn/block exit 2 | `git-guard-escapes.jsonl` |
| `bg-task-guard/` | Stop + PostToolUse Bash | активный bg-task >180s → block | block | `.bg-task-active*` markers |
| `test-statusline/statusline_session_start.ts` | SessionStart | session.env + stale cleanup | — | `.test-status/` |
| `hook-review/check.{ts,mjs}` | CLI/prepush | аудит самих hook-манифестов | exit 1 | — |

### 4.3 Движки (tools/)

- **`tui-test-runner/`** — dispatch (vitest/jest/pytest/dotnet/rust/go/generic), `test_runner_wrapper.ts` (YAML status + log + bg-marker + process-tree kill + self-timeout 30min), `test-monitor.sh`, `launcher.ts` (Python TUI), `adapters/` (per-framework парсеры stdout → TestEvent).
- **`steps-validator/`** — детектор «плохих шагов»: empty body, pending, Then без ассерта, TODO/FIXME; парсеры TS/Python/C#; `.steps-validator.yaml` (`on_bad_steps: warn|error|ignore`, strictness per step-type). **UndefinedStep-детекции здесь НЕТ** — она живёт в `domain-authoring.ts` (`missing_steps` refusal) и в доках strong-tests.
- **`stryker-mutation/`** — `state.ts` (tally + `.mutation-state.json`), `verify-kill.ts` (детерминистический kill-proof).
- **`dead-integration-guard/check.ts`** — «installed ≠ integrated»: consumer claim (file+tokens) + verification spawn → ALLOW/DENY exit 2.
- **`observability/observe.ts`** — 4-панельный stumble-отчёт, dep-safe.
- **`claim-evidence-gate/`** — claim_classifier (4 класса claims), turn-window анализ транскрипта, open-work tally (spec census + agent commitments), слои детекции (firstUnsupported → spec-false-close → no-next-section → unproven-blocker → stop-feedback-unaddressed → Meridian judge), anti-loop маркер, plan_commitment_ledger.
- **`spec-llm-judge/`** — семантический FR↔scenario drift через spawn `claude -p`; deny-list секретов (8 паттернов) перед спавном; sha256-кэш; opt-in в `conformance_check(semantic:true)`.
- **`live-evidence/validator.mjs`** — AJV-валидация live-evidence манифестов: realpath containment, git_sha == HEAD, workspace_digest, per-record binding.
- **`sandbox-test-runner/`** — Windows Sandbox `.wsb` для install/uninstall тестов.
- **`hook-service/`** — демон + клиент + ensure-up + session-bootstrap + registry-builder.

## 5. Слой 3 — спек-система (spec-graph + MCP door)

### 5.1 Модель

`.specs/<slug>/` = набор документов (README, USER_STORIES, USE_CASES, RESEARCH, REQUIREMENTS, FR, NFR, ACCEPTANCE_CRITERIA, DESIGN, TASKS, FILE_CHANGES, CHANGELOG, FIXTURES, `<slug>.feature`, `<slug>_SCHEMA.md`, `.progress.json`). `tools/spec-graph/` (46 модулей) парсит всё в единый composite-keyed граф: FR → AC (`covers`) → `@featureN` tag → Scenario → TASK (`tested-by`). Парсеры: `parsers/md.ts`, `parsers/gherkin.ts`, `parsers/ndjson.ts`.

### 5.2 Привязка тестов: @featureN

- `@featureN` — **реальная Gherkin tag-строка** над Scenario в `.specs/<slug>/<slug>.feature`. `# @featureN` — комментарий, граф его НЕ видит (частый дефект: «graph-invisible tags»).
- Тег обязан маппиться на FR, чей SUBJECT — тестируемое поведение (не «групповой» номер файла). Мис-мап = forged tested-by edge.
- Scenario id = `DOMAIN_CODE_NN` (напр. `SPECGEN004_NN`); в графе id spec-qualified — коллизий между спеками нет.
- Step-defs: `tests/step_definitions/feature<N>_<desc>.ts` или `feature_<slug>.ts` — ОДИН глобальный namespace (`tests/step_definitions/**/*.ts`); regex-паттерны (не Cucumber Expressions — `/`, `{}`, `()` спецсимволы); коллизии ловит `--dry-run` по ВСЕМУ wired-набору.
- `cucumber.json`: `default.paths` = 36 `.specs/<slug>/<slug>.feature` + 9 `tests/features/plugins/*`; `default.tags` = `not @wip and not @manual and not @windows-only and not @e2e and not @historical and not @live-evidence`; `default.format` = `message:.dev-pomogator/.last-test-run.ndjson` — **канонический лог, который читают граф, вердикт и гейты**.

### 5.3 Вердикты покрытия (coverage.ts, conformance.ts)

- `.last-test-run.ndjson` → `ScenarioNode.lastResult` → бакеты: passed/stale/pending/undefined/ambiguous/failed/skipped/not_run (`not_run` ≠ `undefined` — частичный прогон не «спека развалилась»).
- Task → scenario map: own Done-When scenario ids, fallback `@featureN`+FR refs.
- `verified_status`: **DONE iff EVERY mapped scenario PASSED** (honesty gate); worst-of для IN_PROGRESS.
- `TestQualityVerdict`: `STRONG | WEAK | FAKE-POSITIVE-RISK` из `.dev-pomogator/.test-quality.json` — единый side-channel для Stop-gate, `get_coverage` MCP и `spec-verdict` (FR-35a).
- Conformance finding codes: `UNCOVERED_FR`, `TASK_UNTESTED`, `UNTAGGED_SCENARIO`, `TASK_NO_OWN_SCENARIO`, `TASK_TEST_QUALITY`, `UNVERIFIED_COMPLETION`, stale FILE_CHANGES paths, dangling edges, bare-id collisions (raw pre-map dump — map dedup молча дропает last-writer losers).

### 5.4 «Дверь» (spec MCP server)

`tools/spec-mcp-server/` — единственный санкционированный канал записи в `.specs/` (46 инструментов): reads (`list_specs`, `list_spec_docs`, `read_spec_doc`, `get_node`, `get_trace`, `get_scenario_trace`, `get_spec_status`, `get_test_result`, `search`, `find_by_tags`, `find_orphans`, `find_refs`, `list_tasks`, `list_phase_tasks`, `policy_query_requirements`, `mcp_preflight`, `read_attachment`, `get_archival_proof`), writes (`apply_spec_change`, `apply_spec_transaction`, `propose_spec_change`, `propose_patch`, `apply_proposed_patch`, `propose_spec_repairs`, `apply_spec_repairs`, `propose_requirement_contract`, `create_spec`, `archive_spec`, `delete_spec_doc`, `rename_spec_doc`, `insert_at_eof`, `insert_after_heading`, `replace_in_section`, `append_to_section`, `amend_requirement`, `add_acceptance_criterion`, `add_phase`, `add_backlog_task`, `register_incident_backlog`, `set_entity_status`, `set_spec_status`, `set_requirement_metadata`), checks (`conformance_check`, `validate_spec`, `validate_anchor`, `validate_requirement_metadata`).

**Серверная честность (проверено в bundle):** `apply_spec_change` валидирует before/after truth-графы с каноническим `.last-test-run.ndjson`: DONE-задача с не-зелёными сценариями → conformance finding + suggestion `make_green_or_downgrade`; `TASK_NO_OWN_SCENARIO` warning; `missing_steps` refusal («Refusing to plant an executable scenario whose steps have no real step-definition»). Т.е. «дверь отказывает pre-green flip» — это серверная валидация, не промпт.

Двойной enforcement `.specs/`: (1) `spec-access-guard` hook deny на raw file tools; (2) `allowed-tools` у spec-phase агентов = только MCP (второй слой, Claude-only — в Codex TOML его нет).

### 5.5 Пер-spec вердикт и corpus-health

- `tools/specs-generator/spec-verdict.ts -Path .specs/<slug>` — АВТОРИТАТИВНЫЙ вердикт: structural pre-filter + audit-spec (hard gate) + traceability FR-37b + conformance + coverage-rollup FR-32 + FR-8 semantic. Правило `no-structural-valid.md`: запрещено «valid/clean/done» по одному `validate-spec: 0 errors`.
- `tools/spec-graph/corpus-health.ts` — whole-corpus отчёт 🟢/🔴: (1) bare-id collisions (raw pre-map), (2) dangling edges, (3) untraced atoms (UNCOVERED_FR/TASK_UNTESTED/UNTAGGED_SCENARIO), (4) stale FILE_CHANGES, (5) orphan project tests (vitest `it()` без сценария — reverse hole), (6) FRs без RESEARCH.md-ссылки, (7) upstream unlinked. `--strict` → exit 1 на любом долге.

### 5.6 spec-review — 17 категорий семантического ревью

`spec-review` skill: pre-stop ревью перед каждым `ConfirmStop` и post-impl. Категории: 1 External-API claim verify (P0, WebFetch), 2 Existing-asset duplicate (P0), 3 Antipattern guardrails (P1), 4 Assumption-vs-Requirement (P1), 5 Open Questions stale (P1), 6 @featureN cross-file consistency (P0), 7 Tooling mismatch (P1), 8 Plan-gate template compliance (P1), 9 BDD Test Infrastructure → Phase 0 (P0), 10 Hallucination/fluff smell (P2), 11 Spec↔code drift (P1, post-impl), 12 Cross-namespace name collision (P0), 13 JWT claim/config key consistency (P2), 14 Memory-constraint compliance (P0/P1, dynamic из `~/.claude/projects/*/memory/feedback_*.md`), 15 Reality drift (P0/P1/P2 → spec-reality-check), 16 Acceptance-to-delivery coverage (P0), 17 Product surface/UX journey (P0/P1). Output: `REVIEW_NOTES.md` + structured envelope `spec-review-findings@1` (repairClass: PROPOSAL_ONLY|DECISION_REQUIRED|NONE — семантический ревьюер НЕ применяет патчи).

### 5.7 spec-reality-check

6 классов drift spec↔repo через `scripts/verify.ts`: FILE_CHANGES path actuality, narrative path refs, code-drift via git pickaxe, TASKS↔FILE_CHANGES consistency. Триггер: create/modify/supplement/implement spec + PreToolUse ExitPlanMode hook. Output: AuditFinding[] (ERROR/WARNING/INFO), форматы human/json/markdown.

## 6. Слой 4 — агенты

| Агент | Спавн | Инструменты | Контракт |
|---|---|---|---|
| `test-author` | spec-generator-v4 Phase 3 на `TASK_NO_OWN_SCENARIO`, или вручную; inputs: `slug`, `task_id` | Read/Grep/Glob/Write/Edit/Bash + MCP (get_trace, get_node, read_spec_doc, list_spec_docs, search, get_spec_status, conformance_check, apply_spec_change) | 7 шагов «author→run→green→flip, NEVER flip first»: get_trace → drift-check (уже покрыто → cite, STOP) → scenario `SPECGEN004_<next>` в `.specs/<slug>/<slug>.feature` через дверь → step-def с REAL engine (no mock) → FULL cucumber run → mutation gutcheck (break→RED→restore) → flip Done-When. Never: fabricate для unbuilt, tests/features/, flip pre-green, copy prod logic, raw tools на .specs |
| `bdd-migrator` | fresh per `slug` (anti-context-decay) | те же + Write/Edit/Bash | 8-шаговый конвейер: migrate.ts work-list (runtime/artifact/manual) → classify → step-defs (regex, spec-scoped) → throwaway-config validation (`"default":{}` profile!) → collision --dry-run по всему wired-набору → wire-feature.mjs (O_EXCL lock, tag promotion) → mutation gutcheck → delete vitest twin. NO-REFUSAL: цель zero *.test.ts |
| `spec-phase-discovery` | orchestrator, `slug` | MCP-only (+create_spec) | Phase 1: USER_STORIES/USE_CASES/RESEARCH |
| `spec-phase-requirements` | orchestrator, `slug` | MCP-only (+conformance_check, get_spec_status) | Phase 2: FR/NFR/AC/DESIGN/REQUIREMENTS/FILE_CHANGES + .feature |
| `spec-phase-audit` | orchestrator, `slug` | MCP-only | Phase 3+: AUDIT_REPORT + close findings |
| `spec-phase-finalization` | orchestrator, `slug` | MCP-only | TASKS/README/CHANGELOG |
| `plugin-dev/{agent-creator,plugin-validator,skill-reviewer}` | manual | Write/Read; Read/Grep/Glob/Bash; Read/Grep/Glob | генерация агентов; валидация плагина; ревью SKILL.md |

MCP-only у spec-phase — второй enforcement-слой (FR-39): нет Read/Grep/Edit над `.specs/` вообще.

## 7. Правила (.claude/rules → .carl/rules)

Stubs ~400B (`managed-stub v1`) лениво подгружают канонические тела из `.carl/rules/`. Ключевые (дословно сжато):

- `testing/cucumber-expression-parens` — литеральные `(){}`/`/` в step-тексте → RegExp step-def; подтверждение только реальным Docker BDD прогоном по slug-id.
- `testing/verify-against-real-artifact` — фикстура из реального инструмента или точный envelope; ни одного поля, которого producer не эмитит; сверка с независимым ground-truth.
- `testing/dead-integration-guard` — runtime-потребитель существует + e2e против реального артефакта; deps-absent проверка (спрятать node_modules и запустить); fixes: bundle / lazy-import+fail-open / node-builtins-only.
- `testing/output-invariants-first` — ≥2 output-инварианта на collection-функцию; N×M loops: пересечение входов + формула cardinality; mutation testing — полировка, не поиск class-bugs; прогон со сломанным кодом обязателен.
- `test-quality/no-test-helper-duplication` — перед определением helper'а проверить `tests/e2e/helpers.ts` и соседние файлы.
- `bdd-only/bdd-only-tests` — DENY новых non-BDD тестов; ALLOW Edit существующих (shrink-only); escape `BDD_ONLY_SKIP=1`.
- `tui-test-runner/centralized-test-runner` — тесты только через `/run-tests`; прямые команды блокируются.
- `spec-verdict/no-structural-valid` — запрет «valid/clean/done» по `validate-spec: 0 errors`; только spec-verdict + gap list.
- `spec-reality-check/maintain-evals-on-edit` — при изменении скилла обязателен прогон всех evals + bulk-run + bench.
- `scope-gate/when-to-verify` + `escape-hatch-audit` — когда verify обязателен; escape-логи и red flags (reason <8 chars, 5+ повторов).
- `plan-pomogator/*` — 10-секционный формат плана, spec-test-sync (tests→.specs обязательны; bugfix→.feature), proactive-investigation (исследовать без спроса), plan-freshness (каждый план с нуля), cross-scope-coverage (scope×variant matrix), claims-need-evidence (`[src:]`/`[ref:]`/`[cmd:]` маркеры).
- `integration-tests-first` — тесты обязаны быть интеграционными (real end-to-end через production код); unit — дополнение, не замена.
- `extension-test-quality` — naming `DOMAIN_CODE: desc` / `CODE_NN`; 1:1 it()↔Scenario; Feature First; real-code invocation.
- `tui-pilot-tests` — TUI тесты только через Pilot API; запрет file-inspection тестов.
- `no-unverified-blocker` — «заблокировано» требует улики в том же сообщении; непроверенный блокер = отмазка.
- `verify-status-against-code-before-acting` — статус из дока верифицировать против кода (`ls`+`grep`+запуск).

## 8. Собственный стенд (tests/ + конфиги + Docker + CI)

### 8.1 Дерево tests/

- `tests/features/` — 46 .feature (core/ 10 unwired, plugins/ 29 в 16 dirs, root 6, onboard-repo/ 1); **исполняемый корпус — `⟨S⟩/<slug>/<slug>.feature` (40 wired)**; `tests/features/` — legacy-дерево, авторинг там запрещён (fake-green coverage).
- `tests/step_definitions/` — 186 файлов: `feature<N>_<desc>.ts` (98), `feature_<slug>.ts` (70), `phase<N>-*.ts` (13), `common.ts` (V4World shared steps), `support/hook-dispatcher.ts`, `orphan_policy.ts`, `out-session-advisor.ts`.
- `tests/hooks/before-after.ts` — V4World per-scenario tempDir (`os.tmpdir()/v4-test-<uuid>`); `ensure-docker-bdd.ts` — третий enforcement-слой (throw без `DEV_POMOGATOR_TEST_IN_DOCKER=1`, без bypass).
- `tests/setup/ensure-docker.ts` — vitest setupFiles guard (инцидент 2026-05-22: host-прогон уничтожил реальные `⟨S⟩/`).
- `tests/e2e/` — vitest Docker-only: `helpers.ts` 62.3KB (dedup target), `hook.ts`, `worktree-helpers.ts`, `strong-tests-jit.cases.json`, `spec-generator-v3.test.ts`; `e2e/onboard-repo/` — 13 `.test.ts` (phase0, archetype-detection, baseline-tests, cache-invalidation, coexistence, finalize, ignore-and-redaction, ingestion, parallel-recon, schema-validation, scratch-findings, text-gate) + `helpers.ts` + `step-definitions.ts` + `hooks/` (before-each, after-each, mock-subagent); `e2e/helpers/tui-v2-cleanup.ts`.
- `tests/tui/` — pytest-сьют для TUI: `conftest.py` (headless TestRunnerApp + temp status files), `helpers.py`, `test_compact_bar.py`, `test_help.py`, `test_resize.py`, `test_stop.py`, `test_toggle.py`, `test_yaml_polling.py`.
- `tests/hook-service.test.mjs` — тест самого hook-service демона.
- `tests/fixtures/` — 45 dirs: specgen-фикстуры, language samples (reqnroll/jvm/behave/pytest-bdd/dotnet-stryker), plugin domains, runner/TUI, fake-repos для onboard.

### 8.2 Встроенные юнит-тесты tools/ (`__tests__/`)

15 директорий tools имеют собственные тесты (не в tests/): `spec-graph` (19 файлов), `spec-mcp-server` (12), `anchor-integrity` (6), `marksman-installer` (4), `bdd-migrator` (2), `migrate-v3-to-v4` (2), `spec-check-log` (2), `bash-post-test` (1), `plan-pomogator` (1), `spec-conformance-guard` (1), `spec-conformance-push` (1), `spec-llm-judge` (1), `specs-generator` (1), `specs-validator` (1), `subagent-watchdog` (1).

### 8.3 Конфиги и скрипты

- Конфиги: `cucumber.json` (canonical host), `cucumber.docker.json` (in-container → `.docker-status/`), `vitest.config.ts` (fileParallelism:false, ensure-docker setup), `vitest.mutation.config.ts` (5 pure suites), `vitest.specgen.config.ts`, `stryker.{real,specgen,bdd}.config.mjs`.
- npm-скрипты: `test` → `docker-test.sh`, `test:bdd`/`test:bdd:docker` → `docker-bdd.sh`, `test:all` → `docker-test.sh`, `test:e2e:docker` → `vitest run --reporter=verbose`, `test:tui` → `docker-test.sh --tui`, `mutation` → `docker-mutation.sh stryker.real.config.mjs`, `mutation:skill`/`mutation:bdd` → `npx stryker run stryker.bdd.config.mjs`, `mutation:specgen` → `docker-mutation.sh stryker.specgen.config.mjs`, `mutation:verify` → `tsx tools/stryker-mutation/verify-kill.ts`.
- Скрипты: `docker-bdd.sh` (canonical BDD runner, WSL re-exec, per-run ndjson → canonical copy, `.test-history/` архив), `docker-mutation.sh`, `docker-test.sh`, `run-bdd.mjs` (clobber-safe: filtered → throwaway ndjson; host → exit 1), `bdd-overlay.mjs` (per-scenario overlay → `.scenario-results.ndjson`), `wire-feature.mjs` (O_EXCL lock + tag promotion + atomic cucumber.json), `add-task-ids.ts`, `migration-phase-gate.ts`, `check-status-drift.mts`.
- Docker: `Dockerfile.test.base` (node:20-slim + .NET 8 + dotnet-stryker + bun + Claude CLI), `Dockerfile.test` (app layer, ENTRYPOINT test_runner_wrapper), `docker-compose.test.yml` (маунты `.docker-status/`, `reports/`, `.stryker-tmp/`), `tools/docker-compose.win-test.yml` (dockurr/windows Win11 VM).

### 8.4 CI (GitHub Actions)

- `.github/workflows/test.yml` — lint → `hook-review/check.mjs` (ревизия managed hook registrations) → `check:skill-health` → `npm test` (docker-test.sh). Ubuntu, Node 20.
- `.github/workflows/session-pilot.yml` — отдельный workflow для session-pilot: Python 3.12, backend + delivery-path guards + cold-start тесты.
- `.github/workflows/release.yml` — release pipeline.

### 8.5 Evals-харнесс (сквозной паттерн)

8 скиллов имеют `evals/` директории с `evals.json` + `run-evals.ts` + `iterations/`: `strong-tests` (evals.json + run-evals.ts), `answer-simple` (evals.json), `architecture-decision-builder` (evals.json + rubric.json + artifact-bench + iterations), `discovery-forms` (evals.json + run-evals.ts + iterations), `requirements-chk-matrix` (evals.json + run-evals.ts + iterations), `spec-reality-check` (evals.json + run-evals.ts + bench-synthetic.ts + bulk-run.ts + iterations + README), `task-board-forms` (evals.json + run-evals.ts + iterations), `variant-matrix-build` (evals.json + iterations). Паттерн: `{good, broken, candidates[]}` → STRONG iff PASS на good AND FAIL на broken.

### 8.6 Тестовые workspace-директории

- `run-tests-workspace/` — evals для run-tests скилла: `evals/evals.json` (skill_name: run-tests, assertions: uses-wrapper, docker-explicit-flag, explicit-framework, filter-by-name, pasted-text-sanitization) + `iteration-1/` + `iteration-2/` (benchmark.json, review.html).
- `test-no-update-project/` — `.cursor/commands/suggest-rules.md` (фикстура для suggest-rules evals).
- `test-update-project/` — `.cursor/commands/{suggest-rules,reflect}.md` + `.cursor/rules/pomogator/self-improving.mdc` (фикстура для update evals).

## 9. Состояние и логи (что куда пишется)

| Файл | Писатель | Читатели |
|---|---|---|
| `.dev-pomogator/.last-test-run.ndjson` | cucumber message formatter (только full run) | spec-graph coverage, spec-verdict, claim-evidence-gate, observability |
| `.dev-pomogator/.test-quality.json` | test-quality-producer.ts (из `.test-grades.json`) | test_quality_gate_stop, get_coverage MCP, spec-verdict |
| `.dev-pomogator/.scenario-results.ndjson` | bdd-overlay.mjs | per-scenario overlay |
| `.specs/<slug>/.test-results.ndjson` | bash-post-test/ingest.ts | per-spec шарды |
| `.dev-pomogator/.test-status/status.<s>.yaml` + `test.<s>.log` | test_runner_wrapper | statusline, TUI, Monitor |
| `.dev-pomogator/.docker-status/` | docker-*.sh | логи прогонов, triage |
| `.dev-pomogator/.test-history/` | docker-bdd.sh | архив прогонов |
| `.dev-pomogator/.mutation-state.json` | stryker-mutation/state.ts | stryker-mutation skill |
| `.dev-pomogator/.bg-task-active*` | test_runner_wrapper | bg-task-guard, claim-evidence-gate |
| `.dev-pomogator/.{compliance,dedup,simplify,answer-simple,claim-evidence-gate,test-spec}-marker.json` | соотв. хуки | anti-loop (hash+cooldown+retries) |
| `.claude/logs/*-escapes.jsonl` | escape-хэтчи всех гейтов | observability-review |
| `.dev-pomogator/.claim-evidence-gate-fires.jsonl` | claim-gate | аудит срабатываний |
| `.dev-pomogator/claim-evidence-plan-ledger/` | plan_commitment_ledger | approved-plan commitments |
| `%LOCALAPPDATA%/dev-pomogator/hook-service/` | server.mjs | service.json, token, failures.jsonl |

## 10. Зеркала

- `.agents/skills` ↔ `.claude/skills` — PARTIAL mirror: strong-tests байт-идентичен кроме credits-строки; `research-workflow` = legacy (независимые адаптации); `meridian-model-call` = adapted (path-substitution); 4 `source-command-*` скилла без Claude-аналога. Контракт: `tools/skill-health/mirror-contract.json`.
- `.codex/agents/*.toml` ↔ `.claude/agents/*.md` — контент-зеркало: `developer_instructions` = тело .md verbatim (CRLF), НО `allowed-tools` и `model` дропаются → MCP-only enforcement spec-phase агентов существует только на Claude-стороне. Генератор TOML не найден `[UNVERIFIED]`.
- `.codex-plugin/skills/context-menu` — НЕ зеркало (Codex-only вариант).

## 11. Что портировать в slop v2 (omp-reviewer-kit)

Целевая сторона уже имеет: 4-стейдж review (scout→risk-hunters→verifier→synthesis), `slop` оркестратор + `slop-scout` + `slop-verifier` агенты, `skills/slop` доктрину, fail-closed `REVIEW_RESULT=PASS` контракт, telemetry (runs.jsonl/last-run.json), extension.mjs со slash-командами и tool_call-хуками.

### 11.1 Портировать как доктрину (skill-текст, без кода)

| Источник | Что взять | Куда |
|---|---|---|
| strong-tests §2,§4,§5,§8 | pre-write checklist (≥5 инвариантов, ≥3 категории, gutcheck), 8 антипаттернов с весами, 12-point self-eval, anti-халява invariants | `skills/slop` новая часть «test-slop lens» или отдельный skill |
| strong-tests §6.5 + test-author | рецепт «author→run→green→flip», drift-check first, mutation gutcheck, «Never»-лист | slop-scout/verifier промпты для test-фокуса |
| tests-create-update | 21 NEVER-правил + BAD→GOOD таблица ассертов | детекторные правила risk-hunter (test lane) |
| suite-failure-triage | «never trust dirty-tree failure», clean-worktree протокол, вердикты mine/pre-existing/flake | процедура в skill |
| real-fixtures | 6-шаговый рецепт + validation gate | правило для fixture-находок |
| spec-review 17 категорий | категории 1,2,4,6,10,11,15,16 (переносимые без spec-MCP) | расширение spec-slop линзы |
| observability-review | идея единого stumble-отчёта по escape-логам | `/reviewer-kit:status` расширение |
| verify-generic-scope-fix | 5-шаговая reachability-проверка enum/switch вариантов | risk-hunter correctness lane |
| rules: output-invariants-first, verify-against-real-artifact, dead-integration-guard, no-unverified-blocker, integration-tests-first, extension-test-quality | verbatim-правила как детекторные критерии | reality-first-review / slop skill |

### 11.2 Портировать как механику (код/гейты)

| Механика | OMP-эквивалент | Примечание |
|---|---|---|
| compliance_check (8 антипаттернов, regex) | tool_call hook на write/edit тест-файлов в extension.mjs | чистые regex, zero-dep — прямой порт |
| bdd-only-test-guard (deny новых non-BDD + shrink-only) | tool_call hook | политика опциональна (project profile) |
| test_guard (deny прямых test-команд → wrapper) | tool_call hook на bash | в OMP нет test_runner_wrapper — либо портировать wrapper, либо deny→подсказка |
| test-spec-gate (tests/ без .specs/.feature) | Stop-эквивалент или pre-commit stage | у reviewer-kit уже есть pre-commit runner — естественный дом |
| test_quality_gate (DONE без STRONG) | verdict-логика в review synthesis | требует spec-граф — только если портировать и его |
| verify-kill.ts (inject→FAIL→restore) | standalone script `scripts/verify-kill.mjs` | детерминистический mutation gutcheck, zero-dep — высокая ценность, прямой порт |
| marker-utils anti-loop (hash+cooldown+maxRetries) | переиспользовать в любом новом гейте | обязательный паттерн для любых блокирующих хуков |
| escape-hatch аудит (`[skip-X: reason≥8]` → JSONL) | единый escape-лог в audit-reports/ | уже частично есть в telemetry |
| claim-evidence-gate (claims→evidence) | НЕ портируется напрямую — OMP session_stop не pre-display gate; идею claims→evidence перенести в review-стадию | транспорт несовместим |
| steps-validator (bad-step детектор) | опционально: regex-проверки в compliance-гейт | Then-без-ассерта — дешёвый сигнал |
| spec-access-guard / phase-gate / form-guards | НЕ портируется — это защита их spec-MCP; в omp-reviewer-kit spec-системы нет | out of scope |
| hook-service HTTP-демон | НЕ портируется — OMP extension API нативно даёт tool_call hooks | транспорт Claude-специфичен |
| tui-test-runner + statusline + TUI | НЕ портируется — Claude-специфичный UX; в OMP есть hub processes | транспорт |
| Docker-стенд | НЕ портируется — инфра dev-pomogator | окружение |

### 11.3 Ключевые инварианты для порта (неснижаемые)

1. **Вердикт вычисляется, не заявляется** — любой «done»/«clean» только от детерминистической проверки; fail-closed при неработающей проверке.
2. **Тест обязан уметь падать** — mutation gutcheck (break→RED→restore) как единственное доказательство силы; coverage % не доказательство.
3. **Канонический лог прогона один** — filtered/partial run никогда не пишет в канонический файл (clobber-protection).
4. **Anti-loop на каждом блокирующем гейте** — hash+cooldown+maxRetries+escape-hatch с аудит-логом; иначе гейт становится оружием против пользователя.
5. **Escape всегда audited, never silent** — `[skip-X: reason≥8]` → JSONL; reason <8 chars → warning.
6. **Drift-check перед авторингом** — не писать дубликат того, что уже покрыто; cite > author.
7. **Emit-only vs block** — advisory-сигналы (JIT, LLM-judge) никогда не блокируют; блок только детерминистические проверки.
8. **Real code, no mocks** — step-def/тест вызывает реальный модуль; parallel-impl и tautology = дефект.

### 11.4 Предлагаемая компоновка slop-v2

```
skills/slop/                      + «test-slop lens»: 8 антипаттернов, 12-point self-eval,
                                   NEVER-правила, fixture-gate, dirty-tree правило
agents/slop-test-hunter.md        новый специалист: test-quality candidates
                                   (weak assertion, fake-green, missing edge-case,
                                   untested branch, fixture-fake) — модель @slow
agents/test-author.md             порт контракта (без spec-MCP: drift-check → author →
                                   run → mutation gutcheck → report; flip — через git)
scripts/verify-kill.mjs           прямой порт verify-kill.ts (inject→FAIL→restore)
src/infra/test-compliance.mjs     порт compliance_check regex-набора (TS+C#)
extension: tool_call hook         write/edit тест-файлов → test-compliance (block→skill hint)
                                   bash прямой test-runner → deny + wrapper hint (опц.)
```

### 11.5 Открытые вопросы / риски порта

- `posttool-jit.ts` и `scope-gate-guard.ts` отсутствуют в текущем registry.json источника — их live-регистрация `[UNVERIFIED]` (вероятно per-install). Портировать как опциональные.
- LLM-судьи (bdd-quality-judge, meridian-judge, spec-llm-judge) требуют ключей/эндпоинтов (aipomogator/OpenRouter/CLAUDE_BIN) — в OMP-цели это model roles; переносить через `agent()`/`completion()`, не через внешние API.
- spec-граф — самая большая подсистема (46 модулей + MCP-сервер). Полный порт = отдельная фича; для slop-v2 достаточно «verdict computed not claimed» + coverage-вердикты как концепция.
- Codex-зеркала теряют `allowed-tools` — в OMP agent frontmatter `tools:`/`spawns:` даёт эквивалент нативно.
- Windows: jscpd `/tmp` пути, `npx tsx` spawn-ловушки, CRLF в .feature — учесть при порте скриптов.

## 12. Gaps/Unknowns (честный список)

### 12.1 Не верифицировано

- Генератор `.codex/agents/*.toml` не найден — spec называет их «generated», механизм не верифицирован.
- `spec-conformance-push` bundle: пишет ли он `.test-quality.json` — inferred, не verified.
- `hooks.legacy.json` хвост (84–539) не полностью diff'нут против registry.
- `subagent-watchdog`, `learnings-capture`, `prompt-suggest`, `auto_commit_stop`, `advisor_stop`, `carl/runner`, `plan-pomogator/{prompt-capture,validate-plan,prompt-store}` — перечислены, не прочитаны вглубь.
- `tests/features/core/*` и 5 root .feature — unwired; намеренно dormant или забыты — недокументировано.
- `.agents/skills` mirror: byte-diff только strong-tests; остальные 59 не сверены.
- `Monitor` tool (Claude Code) — в OMP нет прямого аналога; ближайшее — hub processes/`wait`.
- `16-строчный compliance report` — упомянут в tests-create-update, точный формат не верифицирован.
- `5 форм-гардов` — dispatch файл существует, точный счётчик не верифицирован.
- `10-секционный формат плана` — упомянут в plan-gate, точный список секций не верифицирован.

### 12.2 Dormant code (не зарегистрировано)

- `tools/test-quality/posttool-jit.ts` — ast-grep детектор инвариант-кандидатов; написан, но не зарегистрирован ни в hooks.json, ни в hooks.legacy.json, ни в settings.json. Нет вызывающих.
- `tools/scope-gate/scope-gate-guard.ts` — PreToolUse hook для git commit/push; написан, но не зарегистрирован. Нет вызывающих.
- `tools/specs-validator/extension-json-meta-guard.ts` — зарегистрирован в hooks.legacy.json (PreToolUse/2/1), но НЕ в hooks.json — возможно dormant в live-манифесте.

### 12.3 Проверено, вне скоупа

- `forbid-root-artifacts`, `bun-oom-guard`, `claude-mem-*`, `mcp-setup`, `marksman-installer`, `native-statusline`, `context-mode-setup`, `skill-listing-budget` — инфраструктурные хуки, не тестовая машинерия.
- `auto-commit`, `auto-simplify`, `advisor`, `carl/runner`, `prompt-suggest`, `learnings-capture`, `subagent-watchdog` — перечислены в gaps, не тестовая машинерия.
- `plugin-deps-guard`, `referent-grounding-guard`, `worktree-setup`, `skill-health` — утилиты, не тестовая машинерия.
- `spec-check-log` — CLI для чтения conformance-лога, не тестовая машинерия.
- `migrate-v1-to-v4`, `migrate-v3-to-v4` — миграционные скрипты, не тестовая машинерия.
- `devcontainer`, `edge-debug-port`, `proxy-up`, `report-issue`, `pomogator-doctor`, `install-diagnostics`, `debug-screenshot`, `context-menu`, `markdown-lsp`, `meridian-model-call`, `out-session-advisor` (кроме verify_claims), `research-workflow`, `architecture-research-workflow`, `architecture-decision-builder`, `discovery-forms`, `task-board-forms`, `variant-matrix-build`, `requirements-chk-matrix`, `cross-spec-reconcile`, `cross-spec-resolve`, `create-spec`, `spec-archive`, `spec-backlog` (кроме hooks), `spec-status`, `spec-graph-query`, `spec-generator-orchestrator`, `spec-mcp-dogfood`, `spec-mcp-usability-dogfood`, `runtime-dogfood`, `verify-plugin-install`, `docker-optimize`, `answer-simple-workspace`, `arch-review-loop`, `skills-rules-optimizer`, `onboard-repo`, `dev-pomogator-uninstall`, `configure-mcp`, `dynamic-workflow-engineering`, `anchor-fix`, `suggest-rules`, `auto-capture`, `checklists`, `gotchas`, `pomogator`, `session-pilot` (кроме autostart_hook), `specs-workflow`, `testing` (кроме перечисленных), `tui-test-runner` (кроме перечисленных), `bdd-only`, `reqnroll-ce-guard`, `scope-gate`, `plan-pomogator` (кроме перечисленных), `test-quality` (кроме перечисленных), `answer-simple` (кроме перечисленных), `spec-reality-check` (кроме перечисленных), `spec-verdict`, `specs-validator` (кроме перечисленных), `tui-pilot-tests` — перечислены в gaps или вне скоупа тестовой машинерии.
