# Native task review — обязательные требования

Дата: 2026-10-19. Источник: прямое требование владельца — использовать нативный `task` OMP и уже настроенную роль `task`, не строить собственную модельную маршрутизацию.

**Требование утверждено владельцем. 2026-10-19 владелец разрешил реализацию рекомендованного варианта 2 из PLAN сообщением «делай».** Работа ведётся локально: native OMP direct-task entrypoint в отдельной upstream-копии и тонкий kit transport. Это не разрешает установку/патч глобального OMP, изменение owner config, внешнюю публикацию, live расходы, коммит или релиз.

## NR-01. Единственная точка модельного запуска

Для непустого staged diff kit программно передаёт задание `agent: reviewer-kit` **настоящему native TaskTool OMP**. Объект задания содержит поддерживаемые нативным контрактом assignment-поля, но не `model`, provider, thinking/effort override или собственную fallback-chain.

Первый review-инференс относится к этому native task. До него нет модельного CLI-диспетчера, no-tools health prompt, title/label запроса, созданного kit, либо другой модели, которая должна сначала согласиться вызвать TaskTool. Внутренние auxiliary-запросы самого OMP могут иметь собственную политику: они учитываются отдельно, не выдаются за reviewer и не используются kit как предварительный health gate. Это не разрешение добавлять новые вспомогательные модельные запросы.

Техническая обёртка допустима только как детерминированный transport/adapter: вызвать native task, передать staged inputs, прочитать native события/артефакт, вернуть результат. Она не является агентом и не делает inference сама.

## NR-02. Владение моделями — у OMP и владельца

- `reviewer-kit`, scout, hunters и verifier объявляют `model: "@task"`.
- OMP сам разрешает роль, пользовательские agent overrides, credentials, effort, provider eligibility, cooldown и fallback.
- Kit не копирует `modelRoles.task`/`retry.fallbackChains.task` в `default`, не собирает YAML/JSON с модельной политикой, не сортирует/нормализует/dedupe-ит selector-ы ради выбора модели.
- Kit не задаёт конкретную Luna/Haiku/longcat ни аргументом запуска, ни env, ни в API-вызове задания.
- `~/.omp/agent/config.yml`, models/auth stores и настройки проекта не меняются. Выбор task-agent владельцем остаётся нативным; если owner override меняет effective model policy, provenance показывает это, а не скрывает.
- Чтение native diagnostics допустимо, но они не превращаются во вторичный reader/planner/registry маршрутизации kit.

## NR-03. Сквозная native task identity

Недостаточно найти строку `@task` в command line. В базовом тестовом профиле без agent overrides native task result/trace должны подтверждать `modelRole: task` либо однозначную нативную subagent-роль с provenance наследования `task`. Один reviewer root task и все specialist tasks идут по одному native механизму, а не по отдельным preflight/dispatcher/re-emit моделям.

Пользовательские overrides применяет сам OMP; kit не подменяет ими роль и не мешает им. Исходная роль и фактическая модель фиксируются отдельно.

## NR-04. Полнота configured fallback при отказе primary

При неизменённом профиле `task primary = longcat:auto`, fallback `[Luna:xhigh, router/free, Luna:medium, longcat, Haiku:medium, cat-jam]` ошибка начальной primary не должна ошибочно означать, что Luna и router уже пройдены.

- В контролируемом fixture Luna доступна, авторизована, не в cooldown; primary отвечает ошибкой. **Первый допустимый fallback-запрос — Luna:xhigh.**
- Когда доступный кандидат отвечает, native перебор завершается; не требуется делать запрос ко всем моделям после успеха.
- Если кандидаты не отвечают, native OMP рассматривает оставшиеся в заданном порядке. Пропуски допустимы только по доказанной native причине (unknown model, отсутствующие credentials, cooldown/disabled/context/effort eligibility), не из-за ошибочной позиции `:auto`/bare primary.
- Разные настроенные `Luna:xhigh`/`Luna:medium` не схлопываются kit. Сохраняется нативная политика retry/cooldown и ограничения на повтор уже пройденных кандидатов.
- Реальный fallback с поздней позиции не возвращает обход к началу. Нужна identity позиции primary/текущего fallback, а не безусловный `baseIndex`-first.

Ошибка нативного resolver исправляется в OMP; её запрещено компенсировать собственным loop kit. Известное воспроизведение: [native-task-role-repro](../../audit-reports/native-task-role-repro-2026-10-18.mjs). Оно фиксирует старое неправильное поведение, не служит acceptance-тестом исправления.

## NR-05. Никаких модельных preflight/repair/retry-обёрток

- Удалить blocking provider health call перед native task. Локальная проверка наличия Git/Node/OMP и native API capability допускается без модельного запроса.
- Kit не обходит provider chain и не перезапускает весь review ради переключения модели. Provider error, synthetic unexecuted tool call и provider retry обрабатываются native OMP.
- Удалить отдельную no-tools модель для verbatim re-emit. Native completed task artifact читается детерминированно; отсутствие/невалидность окончательного результата блокирует коммит с точной причиной.
- Native `task` для фаз review и проверка полноты batch остаются. Предметный retry задания по нарушению review-контракта не является provider fallback; существующая такая политика не расширяется этим рефакторингом и должна быть явно сохранена либо отдельно согласованно изменена. Она тоже использует native task, без модели/chain overrides.

## NR-06. Review-инварианты сохраняются

Staged snapshot isolation; native orchestrator → scout → hunters → verifier → synthesis; native concurrency и schemas; запрет mutation tools; обязательное completion evidence; один точный PASS; подтверждённые findings/coverage gaps и любой неопределённый/неполный результат — BLOCK. Recovery артефакта не может превратить substantive BLOCK/nonzero/незавершённый task в PASS.

Не отключать Git hook, не применять `--no-verify`, не разрешать коммит при неподдерживаемом native entrypoint. При отсутствии capability сообщать конкретно, что не поддерживается, без запуска старого пути через `default`.

## NR-07. Наблюдаемость без собственного routing

Выводить native task ID, исходную роль, фактическую модель, фазу и причину native перехода/отказа; читать события OMP, а не выводить chain selection из скопированного конфига. Секреты и provider response bodies в отчёт не попадают. Несовпадение запрошенной роли/entrypoint — отдельная диагностика, а не общий совет обновить ключ.

Ни fixed wall-clock cap, ни остановка quiet review не добавляются. Никакого скрытого fallback на старую архитектуру.

## NR-08. Проверка и приёмка

1. Сначала regression-тест, который воспроизводит старый дефект и отвергает его; затем исправление выбранного варианта.
2. Проверка реального native TaskTool и trace, а не fake OMP, отвечающего READY/PASS на любой CLI-вызов.
3. Полный test/contract/mutation gate и smoke через настоящий Git hook. Отдельно указывать, какие проверки offline, какие с mock transport, какие live.
4. Нельзя заявлять готовность по тексту YAML, наличию `--model @task`, одному Haiku recovery или числу зелёных тестов без NR-01–NR-05.
5. Не писать 'исправлено в версии X', пока точная версия/commit не подтверждена тестом нужного поведения.

## Не входит в разрешение этим планом

Изменение пользовательского model config; обновление/патч установленного OMP; публикация issue/PR в upstream; provider probes с реальной стоимостью; коммит/релиз/переустановка/registry heal. Для реализации и внешних действий требуется отдельное решение владельца.
