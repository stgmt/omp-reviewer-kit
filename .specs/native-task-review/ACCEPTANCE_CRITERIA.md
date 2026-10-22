# Native task review — приёмка и план тестов

Статус: **матрица приёмки; частичная реализация и проверки перечислены в [STATUS.md](STATUS.md), полная приёмка не завершена**. Требования — [REQUIREMENTS.md](REQUIREMENTS.md). Не добавлять `test.skip`/`todo` как замену проверки. Integration suite, требующая явно указанной локальной upstream runtime, может не запускаться в обычной Node-only среде, но такой skip не доказывает acceptance: отдельно нужен её фактический запуск с 0 skip.

## Матрица требований

| ID | Проверка | Где планируется | Вид доказательства |
|---|---|---|---|
| AT-01 | Native task без внешнего model dispatcher/preflight | `tests/native-task-entrypoint.test.mjs` | Контракт adapter + native tool integration |
| AT-02 | Нет kit model policy/default overlay | тот же + `tests/native-task-policy.test.mjs` | Захват API inputs/CLI process calls/fs writes/settings changes |
| AT-03 | Наследование role/owner overrides | `tests/native-task-integration.test.mjs` | Реальные native results и provider transport trace |
| AT-04 | Primary:auto → bare primary → первая Luna | upstream OMP regression + native integration kit | Настоящий resolver + native provider call trace |
| AT-05 | Дальнейшее продвижение/effort/cooldown | upstream OMP tests + native integration | Native stateful turn recovery, не скопированный kit loop |
| AT-06 | Полный report без model re-emit | `tests/native-task-artifact.test.mjs` | Native artifact identity + observable verdict |
| AT-07 | Полнота фаз и fail-closed | existing gate suites + новые integration cases | Настоящие task result shapes |
| AT-08 | Нет capability → явный BLOCK | `tests/native-task-entrypoint.test.mjs` | Exit/diagnostic, ноль model calls |
| AT-09 | Неизменность пользовательского состояния | policy/integration suites | До/после hashes/settings/env diff |
| AT-10 | Настоящий Git hook | `tests/e2e-native-task-hook.test.mjs` | Реальный Git + native engine + controlled transport |
| AT-11 | Приёмка с рабочими провайдерами | opt-in live suite | Live trace, отдельно согласованные расходы |

Названия файлов в исходной матрице — предложения плана; фактические пути и отдельные результаты kit/native engine записываются в STATUS.md. Не создавать пустые тесты для зелёного количества.

## AT-01. Нет оплачиваемого gate перед native task

**Given** непустой staged diff и поддерживаемый native entrypoint.
**When** запускается hook.
**Then** transport вызывает native TaskTool с `agent: reviewer-kit` напрямую; root reviewer — ровно одно задание; kit не отправляет `READY`, не создаёт assistant-модель для вызова `task`, не запускает отдельный `omp -p --model @task` dispatcher и не выполняет model re-emit.

Проверить не только конечный PASS, но порядок native task_created/provider_request. Provider requests принадлежат reviewer/specialists; auxiliary-запросы самого OMP размечены отдельно и не считаются preflight.

## AT-02. Role marker — не строка в argv

**Given** `default` и `task` настроены на разные deterministic test providers.
**When** root reviewer и каждый тип специалиста делают запросы.
**Then** native provenance указывает `task`; default-provider не получает review-запросов. Task assignment не содержит `model`/provider/effort; temporary files не содержат kit-generated `modelRoles.default`/`retry.fallbackChains.default`; нет вызовов kit reader/planner для маршрутизации.

Старое поведение, которое тест обязан поймать: `--model @task` + copied YAML → PASS от fake CLI. Нельзя использовать fake, который игнорирует фактически выбранную роль.

## AT-03. Настройки принадлежат владельцу

**Given** native `task.agentModelOverrides` меняет один конкретный specialist.
**When** выполняется native stage.
**Then** effective override применяет OMP, trace различает requested role/agent override/resolved model; kit не копирует и не отменяет его. Отдельно проверить отсутствие override: все четыре agent definitions с `@task`.

Сравнить до/после config/auth/model stores и проектные настройки; никаких user/global writes. Контракт не требует читать секреты в тестовый отчёт.

## AT-04. Ошибка primary не пропускает Luna

**Given** native profile:

- `task primary = longcat:auto`;
- `task chain = [Luna:xhigh, router/free, Luna:medium, longcat, Haiku:medium, cat-jam]`;
- runtime primary имеет bare selector;
- longcat отвечает 401;
- Luna доступна/авторизована/не в cooldown, её controlled transport отвечает валидным native assistant/tool ответом.

**When** native OMP восстанавливает запрос.
**Then** первый eligible fallback provider request — **Luna:xhigh**; origin role остаётся task; порядок не реализован китом. После валидного ответа нет лишних запросов к остальному хвосту.

Воспроизвести для root reviewer, scout, hunter и verifier, а не только no-tools probe. Baseline на старом OMP должен падать на assertion о кандидате/trace, не на import/spawn error.

## AT-05. Не поломать native walk исправлением primary identity

Параметризованные native tests:

1. Primary `:auto` разрешается в bare, `off`, `medium`, `high` — позиция primary не принимается за поздний одноимённый fallback.
2. `Luna:xhigh` и `Luna:medium` — различные настроенные selectors; исправление не схлопывает их. Запрос ко второму зависит от native cooldown/eligibility, но не от kit dedupe.
3. Реальный выбор позднего fallback, его последующая ошибка — продолжение после фактической текущей позиции, без возврата к началу/primary.
4. Независимые повторы одного base model с разными effort и routing selectors не создают бесконечный цикл.
5. Unknown model/no credentials/disabled/cooldown — нативный осмысленный пропуск; следующий eligible кандидат рассматривается. Пропуск фиксируется без секретов.
6. `retry.modelFallback=false`/ограниченный `fallbackOn` — kit не включает fallback заново.
7. Все eligible кандидаты отказали — BLOCK с реальной причиной, не PASS и не kit rerun.
8. Незавершённый synthetic tool call — native recovery, без повторения уже выполненного side effect; kit не создаёт дополнительный model-driven dispatcher.

## AT-06. Артефакт вместо дополнительной модели

**Given** native task завершил все review stages и сохранил полный отчёт текущего invocation, transport stdout усечён.
**When** kit получает task result.
**Then** детерминированно читает принадлежащий invocation native artifact и сохраняет полный отчёт; дополнительных provider requests нет.

Missing/неверный invocation/duplicate artifact/nonzero/aborted/conflicting verdict — BLOCK. Substantive BLOCK не превращается в PASS. Никакого no-tools verbatim re-emit.

## AT-07. Сохранение review-протокола

Выполнить существующие stage-completeness/ownership/coverage/verifier/candidate disposition/flat-batch/structured schema fixtures на новом entrypoint. Отсутствующий stage, неверный task ID, schema-invalid specialist, confirmed finding и confirmed coverage gap не допускают PASS.

Structured-output настройки, нужные native протоколу, не удалять вместе с model overlay механически. Они остаются отдельным немодельным контрактом либо заменяются проверенным native schema API.

## AT-08. Capability вместо тихого отката

**Given** OMP не предоставляет согласованный native direct-task entrypoint.
**When** hook проверяет локальную capability без inference.
**Then** BLOCK с `native task entrypoint unsupported` и обнаруженной версией/capability; ни одного provider request; нет fallback на старый CLI dispatcher и нет совета 'поменяйте ваш конфиг'.

## AT-09. Неизменяемость и стоимость

Проверить config stores, staged tree, unstaged files, global role/default-chain и hooksPath; изменяются только разрешённые native run/session artifacts и audit output. Отдельно считать provider requests до root task и после completed artifact: model gate/re-emit отсутствуют. Не объявлять суммарную стоимость нулевой — само ревью оплачивается.

## AT-10. Offline E2E через Git

Реальные Git repo/index/hook, настоящий native TaskTool и настоящая installed/approved test OMP runtime; provider transport управляемый. Чистый staged diff → полный 4-stage protocol и solitary PASS; planted defect → verifier-confirmed BLOCK; provider outage → infrastructure BLOCK. Unstaged изменение не влияет на snapshot/verdict. Конфиг владельца не нужен: изолированный test profile.

## AT-11. Live-проверка отдельно

После согласования реализации и бюджета: реальный `task` с первичной недоступной моделью и настроенной рабочей Luna. Зафиксировать native role, request order, фактический fallback, завершение review. Не подменять live-доказательство mock trace и не провоцировать ошибки на чужих аккаунтах. Не менять пользовательский config ради демонстрации; изолированная fixture либо явно согласованный сценарий.

## Мутации и критерий принятия

Мутанты kit: вернуть preflight; вернуть model dispatcher; добавить per-call model; скопировать default chain; удалить native task invocation; включить старый путь при unsupported capability; запустить model re-emit; принять чужой artifact/partial stage/ambiguous PASS.

Мутанты OMP: потерять role при старте; принять поздний bare-дубликат за primary; схлопнуть effort variants; вернуть начало после позднего fallback; бесконечно повторять один кандидат; игнорировать disabled fallback/eligibility.

Каждый мутант требует green baseline, реально выполненный deciding test и assertion failure. Missing selectors/skip/timeout/import error не засчитываются. Сначала целевые RED→GREEN, затем стандартные `npm test`, `npm run test:mutation`, `npm run check` на чистом согласованном дереве. Upstream/native tests и локальные kit tests учитываются отдельно.
