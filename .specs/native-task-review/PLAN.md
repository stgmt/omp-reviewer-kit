# Native OMP task review — варианты и план рефакторинга

Дата: 2026-10-19; обновлено 2026-10-22. **Владелец разрешил реализацию варианта 2 сообщением «делай» (2026-10-19).** Позже владелец удалил форк OMP и запретил патчи OMP: финальная реализация — kit host поверх закреплённой библиотеки OMP 18.12.5 без изменений OMP (см. [STATUS.md](STATUS.md)). Установка, live расходы, коммит и доставка требуют отдельного разрешения.

## 1. Цель и критерий выбора

Нужный путь:

```text
Git hook
  → Node runner: staged snapshot, deterministic protocol validation, audit
  → native OMP TaskTool: agent reviewer-kit, native role @task
      → native scout task(s)
      → native hunter task(s)
      → native verifier task
      → reviewer synthesis
  → native completed artifact
  → deterministic verdict/report
```

Перед reviewer нет отдельного модельного preflight/dispatcher. После него нет модельного re-emit. Модели/effort/fallback выбирает OMP, не runner.

Обязательные требования [NR-01–NR-08](REQUIREMENTS.md) одинаковы для всех принимаемых вариантов. Тесты [AT-01–AT-11](ACCEPTANCE_CRITERIA.md) проверяют runtime-поведение, не строки argv.

## 2. Две независимые работы

### A. Исправить точку входа kit

Удалить модельный dispatcher/preflight/repair, task→default overlay и свой chain reader/planner. Native root `reviewer-kit` должен запускаться программно, без модели-посредника.

### B. Исправить OMP primary position

Native role inheritance уже есть у существующих специалистов, но OMP 18.10.4/проверенный исходник 18.12.2 содержит отдельную проблему `primary:auto` vs bare-дубликат. Native candidate selection должен помнить, что отказала начальная primary, а не поздний fallback с тем же provider/model.

Просто сделать A недостаточно для Luna. Просто сделать B недостаточно для требования 'никакой другой model gate перед task'. Обе части обязательны, старый overlay не остаётся скрытым fallback.

## 3. Варианты

### Вариант 1. Прямой native TaskTool через официальный API OMP

**Суть:** Node kit остаётся независимым от SDK по runtime dependencies. OMP-side deterministic entry/bridge вызывает тот же настоящий TaskTool, который сейчас вызывается моделью. Native parent/tool context инициализируется, но `prompt()`/provider inference родителя не выполняется. Всё review исполняется reviewer/specialists с `@task`.

**Что уже подтверждено в OMP 18.10.4:** package subpath `@oh-my-pi/pi-coding-agent/task` экспортирует `TaskTool`; `TaskTool.create(session: ToolSession)` и `execute(toolCallId, rawParams, signal?, onUpdate?)` находятся в `src/task/index.ts:849–859`. Сам OMP использует прямой вызов через model-free `ToolSession` в `src/commit/agentic/tools/analyze-file.ts:69–90`; без asyncJobManager работает нативный sync-путь и нативный semaphore, не kit scheduler. Наличие API **не доказывает готовую portable поставку** от Node hook к произвольному installed OMP binary.

**Условия:** использовать этот официальный API с поддерживаемым OMP-owned host. `runSubprocess` тоже экспортируется, но это более низкий executor, минующий TaskTool dispatch policy, поэтому как граница kit не выбирается. Импорты из `.bun/install/cache`, ручное конструирование private executor state, копирование TaskTool и собственный scheduler не принимаются. Требуется проверить native lifecycle, structured schemas, artifacts, task.batch/flat, concurrency и cancellation. Если штатный installed runtime не предоставляет поддерживаемый transport для host — остановиться с результатом capability spike, не подменять его обычным SDK `session.prompt()`.

**Плюсы:** прямой переход на native engine без нового модельного посредника; потенциально меньшая upstream-поверхность.

**Минусы:** SDK/API compatibility и раздельный Node/Bun runtime. Нельзя добавлять OMP/Bun как npm dependency kit или выдавать private SDK path за стабильный API. Сам публичный tool API подтверждён; при отсутствии portable OMP-owned host/transport потребуется поддерживаемый upstream bridge.

### Вариант 2. Прямой task entrypoint в самом OMP, kit — тонкий CLI-клиент

**Суть:** OMP получает немодельную команду/API direct-task execution, которая внутри вызывает существующий native TaskTool. Kit отправляет assignment `agent: reviewer-kit` и staged inputs, получает native result/events/artifact. Это **предлагаемый upstream entrypoint**, не существующая сегодня команда: название и флаги заранее не выдумываются.

**Плюсы:** kit сохраняет Node18+/нулевые зависимости, не импортирует внутренности OMP, lifecycle/discovery/task overrides/fallback/concurrency остаются у OMP. Удаляется вся лишняя верхняя inference-цепочка, нет зависимости от живости default-модели.

**Минусы:** upstream-изменение и поставка проверенной OMP capability; старые OMP должны явно получать unsupported diagnostic. Публикация upstream PR, установка/обновление бинарника и доставка — только отдельно разрешённые действия. Нельзя обещать срок принятия upstream.

**Рекомендация:** вариант 2 как наиболее чистая граница между Node-плагином и native OMP. Если capability spike варианта 1 докажет уже существующий поддерживаемый direct TaskTool API с теми же гарантиями, допустим вариант 1 без нового CLI. Это не разрешение автоматически менять выбранный вариант: результат spike показывается владельцу.

### Не принимаемые способы

| Способ | Почему не выполняет требование |
|---|---|
| SDK `setModel(..., role=task)` + старый model dispatcher | Сохраняет роль, но оставляет лишнюю модель перед native reviewer; отдельный primary-position defect тоже остаётся |
| Оставить `omp -p --model @task`, убрать только preflight | Потеря root role не исправлена; dispatcher остаётся модельным |
| Копировать chain в default / выбирать первую Luna / переставить owner config | Это новая kit routing policy или маскировка native дефекта, а не использование настроенной роли |
| Оборачивать native ошибки своим provider loop/whole-review retry | Дублирование native fallback, лишняя стоимость и риск повторных задач |
| Вызвать internal executor напрямую, скопировать TaskTool или создать свой task scheduler | Привязка к private OMP implementation и повторение проблемы собственной оркестрации |
| Только выполнять review внутри открытой OMP-сессии | Не покрывает обязательный standalone Git hook и commits из Claude/terminal |

## 4. Этапы после выбора варианта

### P0. Зафиксировать границы, сохранить старую работу

- Записать выбранный вариант, exact supported API/OMP commit и изменяемые файлы.
- Сохранить прежние unrelated hook-guard/scout/test изменения; не откатывать чужой worktree и не смешивать их с новым design.
- Текущий staged tree не является новым утверждённым деревом: не менять индекс/не коммитить до отдельного согласованного шага.
- Legacy model-chain implementation больше не объявляется готовой только по старым 1115 зелёным мутантам.

**Выход:** утверждённая архитектурная ветка и test matrix. До этого runtime не меняется.

### P1. Короткий capability spike без live inference

- Доказать, что native TaskTool можно вызвать непосредственно без provider request родителя: minimal isolated fixture с native task-created/result evidence.
- Проверить публичность API и версии. Если текущий OMP не умеет — подготовить локальный upstream design/patch в отдельно разрешённом checkout, не патч installed cache.
- Проверить input required fields (`solutionSpace`, batch/flat), agent/plugin discovery, schemas, native artifacts/session lifecycle.
- Отдельно зафиксировать допустимый transport cancellation/cleanup: не вводить wall-clock kill.

**Выход:** воспроизводимый запуск native root без dispatcher; либо конкретный capability gap и остановка. Не перепрыгивать к workaround.

### P2. RED regression в native OMP

- Воспроизвести `longcat:auto` primary → bare runtime → 401 → ожидаемая первая Luna:xhigh. Старый resolver должен падать deciding assertion.
- Добавить AT-05: effort variants, late actual fallback, cooldown/eligibility, no-fallback setting, no cycles.
- Добавить regression role provenance direct entrypoint → task root/specialists; default имеет другую test policy.

**Выход:** тесты ловят старое неправильное поведение, не просто import errors или mocked PASS.

### P3. Native OMP correction

- Реализовать direct-task entrypoint/API выбранного варианта как вызов того же native TaskTool, без нового scheduler/model inference.
- Исправить primary/active fallback position identity. Не заменять blanket base-first и не dedupe-ить все effort variants по одному имени модели.
- Сохранить native agent overrides, retry settings, provider eligibility, per-turn recovery, task concurrency, result schema и artifact ownership.
- Запустить native offline tests. Не менять owner settings, не устанавливать patched OMP без разрешения.

**Выход:** native RED→GREEN, diff/commit/version provenance. Новый release number не объявляется существующим до публикации.

### P4. Сузить kit до transport adapter

- Новый adapter реализует `ReviewerPort` и лишь вызывает выбранный native entrypoint; обновить composition root и distributable runner в одном изменении.
- `ReviewPrompt` формирует задание reviewer, а не команды другой модели 'вызови task'. Входы staged snapshot, invocation, evidence, scope plan сохраняются.
- Удалить blocking model preflight; заменить только локальной capability проверкой без tokens.
- Удалить task-chain reader/planner/overlay/progress assertion 'applied' и соответствующие model configuration env.
- Удалить model verbatim re-emit: native artifact recovery только детерминированно.
- Удалить kit whole-review retries, которые компенсировали provider/synthetic dispatcher failure. Native provider recovery — OMP. Предметный specialist contract retry остаётся отдельно проверяемой существующей review-политикой, не fallback.
- Прямой `TaskTool.execute` не проходит автоматически через внешний model `tool_call`/`tool_result` pipeline. Root invocation/completion evidence передаётся из авторитетного native task result; specialist gate продолжает загружаться в native reviewer-сессию. Нельзя сфабриковать root complete ради старого счётчика или отключить обязательные stages.
- Model-walk observability передаёт native события; её не удалять только потому, что исчез chain planner.
- Немодельный structured-output контракт отделить от удаляемого model overlay; не ломать schemas.
- Unsupported capability → явный BLOCK без запуска legacy пути.

**Выход:** AT-01–AT-09 GREEN, отсутствует второй routing слой.

### P5. Test/mutant migration без фиктивного успеха

- Старые overlay tests заменить отрицательными policy checks + native integration, а не просто удалить неприятные проверки.
- Старые mutants, относящиеся к реально удалённым функциям, явно перечислить как архитектурно устаревшие; не удалять тихо и не помечать killed. Новый каталог покрывает prohibitions и native adapter.
- Для изменённых тестов перекалибровать selectors стандартным `--calibrate-stale`, затем весь каталог. Каждый пропуск/timeout/error блокирует приёмку.
- Native resolver tests/mutants принадлежат OMP suite, kit tests/mutants — этому репозиторию. Суммы не смешивать.
- `npm test`, `npm run test:mutation`, `npm run check` на чистом export согласованного дерева. Static spec guard предотвращает возврат запрещённых launch-путей, но не заменяет native runtime integration.

**Выход:** exact tested tree/hash, результаты всех suites и оставшиеся unknowns, без переноса старого green.

### P6. E2E и отдельная доставка

- Реальный Git hook с native OMP + controlled provider transport: clean PASS, confirmed defect BLOCK, missing stage/provider exhaustion BLOCK, unstaged isolation.
- Только после согласования live-сценария/стоимости: проверить настоящий task fallback к Luna, сохранить native request order/role и завершённый результат.
- После этого отдельно согласованные commit/push/PR/release/install/heal. Никакого обхода hook или тайного патча global OMP для зелёного коммита.

## 5. Карта файлов

| Область | Планируемое действие |
|---|---|
| `src/infra/omp-cli-reviewer-adapter.mjs` | Заменить model dispatcher/preflight/reemit на direct native transport; сохранить корректные lifecycle/artifact/telemetry обязанности |
| `src/domain/review-chain.mjs`, `src/infra/omp-settings-reader.mjs` | Удалить из review routing, затем удалить неиспользуемые файлы/экспорты/копии |
| `src/domain/review-prompt.mjs` | Reviewer assignment без инструкций внешнему model dispatcher |
| `src/application/ports.mjs` | Убрать/изменить no-tools reemit contract; тип результата native task не обязан притворяться assistant stdout |
| `src/application/review-workflow-service.mjs` | Сохранить staged/verdict invariants, убрать вызов model reemit и assumptions о внешнем dispatcher |
| `src/index.mjs`, `scripts/run-review.mjs` | Composition/new adapter и эквивалентный self-contained distributable; plugin runtime остаётся Node18+ |
| `src/infra/review-batch-extension.mjs`, agent definitions/skills | Сохранить native этапы/допуски, убрать legacy dispatcher references только после тестов |
| Model-walk/dispatch-audit files | Сохранить полезное native evidence; удалить только код, нужный исчезнувшему внешнему model dispatch recovery, с явным обоснованием |
| `tests/review-chain*`, `tests/chain-overlay-failure*`, settings/gap suites | Пересмотреть assertion contracts, не засчитывать YAML roundtrip за runtime behavior |
| Новые native entrypoint/policy/integration/artifact suites | Матрица AT-01–AT-11; имена файлов предложены в acceptance doc |
| `scripts/run-mutation-tests.mjs`, selectors | Явная миграция каталога и полный gate, никаких ручных подмен хешей |
| `AGENTS.md`, `README.md`, `ROADMAP.md`, `CHANGELOG.md`, incident/spec docs | Убрать legacy рекомендации/ложные обещания; requirement и проверенный supported entrypoint видимы будущим сессиям |
| OMP upstream (не используется: финальная реализация не патчит OMP) | Direct task capability, native primary-position regression и tests; exact файлы зависят от выбранного варианта, installed cache не трогать |

## 6. Решения и границы разрешения

2026-10-19 владелец выбрал реализацию рекомендованного варианта 2 сообщением «делай». Локальный форк OMP (`Temp/omp-native-task`, v18.12.2) позже удалён по запросу владельца и не используется; OMP не патчится и не обновляется.

Позже отдельно: внешняя публикация, установка OMP, live расходы, коммит и доставка. Авторизация локальной разработки не равна разрешению править global runtime/owner config.

## 7. Статус этого изменения

Статус 2026-10-22: см. [STATUS.md](STATUS.md). Результаты прежнего дерева с форком OMP (native matrices, 1051/1051 mutation gate) относились к удалённому форку и не переносятся на финальное дерево. Локальная проверка доказывает работу хука и TaskTool в этом репозитории; установка, live Luna и полная приёмка (AT-09 и остальные) не доказаны.
