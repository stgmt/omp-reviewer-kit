# FR — slop-v2: функциональные требования (дистиллят RESEARCH.md)

> Каждое требование имеет вердикт: **TAKE** (берём в v2), **REJECT** (не берём, с причиной),
> **DEFER** (не в v2, но зафиксировано для следующих итераций).
> Источник — RESEARCH.md §N и файл в dev-pomogator. Статусы: PROPOSED — ожидает решения пользователя.

## A. Детекторы качества тестов (test-slop lens)

| ID | Требование | Вердикт | Обоснование | Источник |
|----|-----------|---------|-------------|----------|
| FR-A1 | Детектор 9 антипаттернов в тест-файлах: source-scan, existence-only, weak-assertion, response-ok-only, response-status-only, silent-skip, silent-catch, trivial-input, unsafe-json. Regex-based, zero-dep | **TAKE** | Прямой порт `compliance_check.ts`; чистые regex, node builtins; даёт детерминистический сигнал «тест — говно» | RESEARCH §4.2; `tools/test-quality/compliance_check.ts` |
| FR-A2 | Скоринг силы теста: 8 антипаттернов с весами (PERMISSIVE_MATCHING 10, ASSERTION_ROULETTE 10, MAGIC_NUMBER 5, HAPPY_PATH_ONLY 20, TAUTOLOGICAL 20, TRIVIAL_INPUT 30, SILENT_SKIP 20, MISSING_AWAIT 30); score = 100 − Σ(weight×count); ≥85 GOOD, 60–84 FAIR, <60 WEAK; fake-positive smell → FAKE-POSITIVE-RISK | **TAKE** | Доктрина в skill-текст; вердикт STRONG/WEAK/FAKE-POSITIVE-RISK — единый словарь для review | RESEARCH §3.1; `strong-tests/SKILL.md` §4 |
| FR-A3 | 12-Point Self-Eval — обязательный чеклист после написания теста (mutation gutcheck, специфичность ассертов, negative:positive ≥1:2, error-path, ≥5 инвариантов, границы, failure messages, no parallel-impl, no prod-helper import, no tautology, no trivial input, self-challenge) | **TAKE** | Доктрина; даёт агенту проверяемый артефакт вместо «я написал хороший тест» | RESEARCH §3.1; `strong-tests/SKILL.md` §5 |
| FR-A4 | 21 NEVER-правило + BAD→GOOD таблица ассертов (pathExists-only, toBeDefined, res.ok без body, source-scan toContain и т.д.) | **TAKE** | Доктрина; готовые детекторные правила для risk-hunter test-lane | RESEARCH §3.2; `tests-create-update/SKILL.md` |
| FR-A5 | Pre-write checklist: ≥5 инвариантов на функцию, ≥3 категории входа, ручной mutation gutcheck по строкам | **TAKE** | Доктрина; pre-write фаза test-author | RESEARCH §3.1; `strong-tests/SKILL.md` §2 |
| FR-A6 | Evals-паттерн `{good, broken, candidates[]}`: тест STRONG iff PASS на good AND FAIL на broken; PASS на обоих = FAKE-POSITIVE-RISK | **TAKE** | Это и есть «проверка тестов на говно» в чистом виде — тест обязан уметь падать; реализуется через verify-kill (FR-B1) | RESEARCH §3.1 evals, §8.5 |

## B. Мутации и kill-proof

| ID | Требование | Вердикт | Обоснование | Источник |
|----|-----------|---------|-------------|----------|
| FR-B1 | `verify-kill.mjs` — детерминистический kill-proof: inject mutation → run test → expect FAIL → restore → re-run → expect PASS. Exit 0 iff KILLED | **TAKE** | Прямой порт `verify-kill.ts`; zero-dep; единственное доказательство что тест ловит баг (stryker-агрегат недетерминирован: 32/40/67/70 на 4 прогонах) | RESEARCH §3.4; `tools/stryker-mutation/verify-kill.ts` |
| FR-B2 | Mutation gutcheck как обязательный шаг: break→RED→restore→GREEN для каждого нового детектора/теста | **TAKE** | Доктрина; без этого детектор сам может быть fake-positive | RESEARCH §3.1 §6.3, §8 |
| FR-B3 | Полный mutation-конвейер (stryker/mutmut/pit/stryker-net/cargo-mutants/go-mutating + конфиги + Docker) | **REJECT** | Инфраструктура dev-pomogator; в omp-reviewer-kit нет mutation-раннеров; перенос = отдельная фича | RESEARCH §3.4, §8.3 |
| FR-B4 | LLM survivor analysis (batch-prompt → Agent() → merge-verdicts) | **DEFER** | Требует модельной интеграции; в OMP есть `agent()`/`completion()` — реализуемо, но не в v2 | RESEARCH §3.1 §6.3 |

## C. Агенты

| ID | Требование | Вердикт | Обоснование | Источник |
|----|-----------|---------|-------------|----------|
| FR-C1 | `slop-test-hunter` — новый специалист: кандидаты дефектов качества тестов (weak assertion, fake-green, missing edge-case, untested branch, fixture-fake). Модель @slow, read-only | **TAKE** | Заполняет test-lane в 4-стейдж протоколе; сейчас risk-hunter не смотрит на силу тестов | RESEARCH §11.4 |
| FR-C2 | `test-author` контракт: drift-check → author → run → green → flip. NEVER: fabricate для unbuilt, flip pre-green, copy prod logic, тавтологии | **TAKE** | Адаптация без spec-MCP: drift-check через grep/read, flip через git; контракт «author→run→green→flip, NEVER flip first» — ядро честности | RESEARCH §6; `.claude/agents/test-author.md` |
| FR-C3 | `bdd-migrator` конвейер (migrate→classify→step-defs→collision dry-run→wire→gutcheck→delete twin) | **REJECT** | В omp-reviewer-kit нет BDD-корпуса и .feature файлов; нечего мигрировать | RESEARCH §6 |
| FR-C4 | `spec-phase-*` агенты (discovery/requirements/audit/finalization, MCP-only) | **REJECT** | Нет spec-системы в целевом репо; агенты бессмысленны без spec-графа | RESEARCH §6 |

## D. Гейты и хуки

| ID | Требование | Вердикт | Обоснование | Источник |
|----|-----------|---------|-------------|----------|
| FR-D1 | Compliance-гейт: tool_call hook на write/edit тест-файлов → 9 антипаттернов (FR-A1) → block с подсказкой «прочитай test-slop lens» | **TAKE** | OMP extension API даёт tool_call hooks нативно; fail-closed на детерминистической проверке | RESEARCH §4.2, §11.2 |
| FR-D2 | BDD-only-guard: deny новых non-BDD тестов + shrink-only для существующих | **REJECT** | В omp-reviewer-kit нет BDD-политики; тесты — `node:test` `.test.mjs`; guard запрещал бы то, что там канон | RESEARCH §4.2 |
| FR-D3 | Test-guard: deny прямых test-команд (`npm test`, `node --test`) → подсказка обёртки | **DEFER** | Нужен аналог test_runner_wrapper (YAML status + log + bg-marker); в OMP есть hub processes — можно строить на них, но не в v2 | RESEARCH §4.2 |
| FR-D4 | Test-spec-gate: tests/ изменены без spec/.feature → block | **REJECT** | Нет spec-системы; в reviewer-kit тесты живут в `tests/` без spec-привязки | RESEARCH §4.2 |
| FR-D5 | Test-quality-gate: DONE-задача без STRONG теста → block | **DEFER** | Зависит от spec-графа (FR-F4); концепция «verdict computed not claimed» переносится в review synthesis | RESEARCH §4.2, §5.3 |
| FR-D6 | Claim-evidence-gate: claims→evidence классификатор + LLM-судья + anti-loop | **REJECT (частично TAKE)** | Транспорт несовместим: OMP session_stop — не pre-display gate. Идею «claims→evidence» перенести в review-стадию verifier'а (детектор «заявил без улики») | RESEARCH §4.2, §11.2 |
| FR-D7 | Anti-loop маркеры на каждом блокирующем гейте: hash+cooldown+maxRetries+noProgressStreak | **TAKE** | Обязательный паттерн; без него гейт — оружие против пользователя | RESEARCH §4.2, §11.3 |
| FR-D8 | Escape-hatch аудит: `[skip-X: reason≥8]` → JSONL; reason <8 chars → warning; логи читаются stumble-отчётом | **TAKE** | Единый escape-лог в audit-reports/; уже частично есть в telemetry | RESEARCH §4.2, §9, §11.3 |

## E. Правила и процедуры (детекторные критерии)

| ID | Требование | Вердикт | Обоснование | Источник |
|----|-----------|---------|-------------|----------|
| FR-E1 | Dirty-tree правило: никогда не доверять падению в dirty tree; clean worktree от HEAD + полный прогон + второй прогон на детерминизм → вердикты mine/pre-existing/dirty-artifact/isolation-bug/flake | **TAKE** | Процедура в skill; у reviewer-kit уже есть baseline-diff-verification — дополнить | RESEARCH §3.6 |
| FR-E2 | Fixture-gate: фикстура из реального producer или точный envelope; ни одного поля, которого producer не эмитит; provenance README + ground-truth сверка | **TAKE** | Детектор «фикстура — фантазия» в test-lane | RESEARCH §3.7, §7 |
| FR-E3 | Generic-scope verify: при добавлении 2+ элементов в enum/switch/array, гейтящий shared codepath → reachability-проверка каждого варианта (traced/unreachable/conditional) | **TAKE** | Детектор в risk-hunter correctness lane; 5-шаговая процедура | RESEARCH §3.9 |
| FR-E4 | Spec-review переносимые категории: external-API claim verify, existing-asset duplicate, assumption-vs-requirement, @featureN consistency, hallucination/fluff smell, spec↔code drift, acceptance-to-delivery coverage | **TAKE** | Расширение slop линз; категории 1,2,4,6,10,11,15,16 переносимы без spec-MCP | RESEARCH §5.6 |
| FR-E5 | Stumble-отчёт: единая панель по escape-логам + последний прогон + pending + ошибки → 🟢/🟡 | **TAKE** | Расширение `/reviewer-kit:status`; observability-review — 1 команда, dep-safe | RESEARCH §3.8 |
| FR-E6 | Dogfood-паттерн: drive каждый tool/hook против реальных данных и записывать что реально возвращает — не grep, не green suite | **TAKE** | Процедура верификации для самого slop-v2; runtime evidence вместо «код выглядит правильно» | RESEARCH §3.13 |
| FR-E7 | Детекторные критерии из rules: output-invariants-first (≥2 output-инварианта на collection-функцию, N×M loops), verify-against-real-artifact, dead-integration-guard (installed≠integrated), no-unverified-blocker, integration-tests-first, extension-test-quality (1:1 it()↔Scenario) | **TAKE** | Verbatim-правила как критерии reality-first-review | RESEARCH §7 |

## F. Инфраструктура (не переносится)

| ID | Требование | Вердикт | Обоснование | Источник |
|----|-----------|---------|-------------|----------|
| FR-F1 | hook-service HTTP-демон (127.0.0.1:42619, bearer, registry, ensure-up) | **REJECT** | OMP extension API даёт tool_call hooks нативно; демон — Claude-специфичный транспорт | RESEARCH §4.1 |
| FR-F2 | tui-test-runner + statusline + TUI (Textual) | **REJECT** | Claude-специфичный UX; в OMP — hub processes | RESEARCH §4.3 |
| FR-F3 | Docker-стенд (Dockerfile.test.base, compose, WSL re-exec) | **REJECT** | Инфраструктура dev-pomogator; reviewer-kit тесты — `node --test` локально | RESEARCH §8.3 |
| FR-F4 | Spec-граф + MCP-дверь (46 модулей, 46 инструментов, coverage-вердикты, conformance) | **REJECT** | Отдельная фича; для slop-v2 достаточно концепции «verdict computed not claimed» | RESEARCH §5 |
| FR-F5 | spec-access-guard / phase-gate / form-guards / extension-json-meta-guard | **REJECT** | Защита их spec-MCP; в reviewer-kit spec-системы нет | RESEARCH §4.2 |
| FR-F6 | Cucumber/BDD-корпус (40 wired .feature, 186 step-defs, cucumber.json) | **REJECT** | Нет BDD в целевом репо | RESEARCH §8.1 |
| FR-F7 | CI workflows (test.yml, session-pilot.yml, release.yml) | **REJECT** | У reviewer-kit свой CI (ci.yml, Node 18/20/22, Ubuntu+Windows) | RESEARCH §8.4 |
| FR-F8 | Evals-инфраструктура (iterations/, bench, bulk-run) | **DEFER** | Паттерн {good,broken} берём (FR-A6); инфраструктуру итераций — нет | RESEARCH §8.5 |
| FR-F9 | session-pilot (dashboard, autostart, Pilot API) | **REJECT** | Worktree dashboard — не тестовая машинерия | RESEARCH §3.12 |
| FR-F10 | LLM-судьи (bdd-quality-judge, meridian-judge, spec-llm-judge) | **DEFER** | Требуют ключей/эндпоинтов; в OMP — через `agent()`/`completion()`, не внешние API | RESEARCH §4.2, §11.5 |
| FR-F11 | spec-backlog (auto-ingest, session-summary) | **REJECT** | Spec-backlog — часть spec-системы | RESEARCH §4.2 |
| FR-F12 | research-workflow-marker-guard | **REJECT** | Маркеры research-workflow — их скилл, не наш | RESEARCH §4.2 |
| FR-F13 | anchor-integrity (anchor_gate_stop, anchor_check_post) | **REJECT** | Link-anchors в spec-документах — их spec-система | RESEARCH §4.2 |
| FR-F14 | out-session-advisor/verify_claims | **DEFER** | Детерминистический claim→fact verifier; идея полезна для verifier'а, но реализация — отдельная работа | RESEARCH §4.2 |

## Сводка

| Вердикт | Кол-во | ID |
|---------|--------|-----|
| TAKE | 20 | FR-A1..A6, FR-B1, FR-B2, FR-C1, FR-C2, FR-D1, FR-D7, FR-D8, FR-E1..E7 |
| REJECT | 17 | FR-B3, FR-C3, FR-C4, FR-D2, FR-D4, FR-D6, FR-F1..F7, FR-F9, FR-F11..F13 |
| DEFER | 6 | FR-B4, FR-D3, FR-D5, FR-F8, FR-F10, FR-F14 |
