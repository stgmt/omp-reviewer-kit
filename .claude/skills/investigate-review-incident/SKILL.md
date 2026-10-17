---
name: investigate-review-incident
description: Use when a consumer repository's agent or the user reports a problem with the omp-reviewer-kit pre-commit review (hang, 403/429, fallback not switching, `--no-verify` used, wrong model, BLOCK without a reason) or asks why the review behaved a certain way. Defines the mandatory investigation protocol and evidence map so the first answer is already complete.
---

# Расследование инцидента ревью (dogfood)

Первый ответ должен быть полным. Пользователь не должен «пинать» ради второго прохода. Не отвечать, пока не выполнены шаги 1–4.

## 0. Жёсткие правила

- Сначала доказательства, потом механизм, потом причина, потом варианты. Каждое утверждение — с путём и строкой/полем. Непроверенное помечать «не проверено».
- Не предлагать защиту, которая может оборвать здоровую сессию: фиксированный wall-clock cap, `OMP_REVIEW_KIT_MAX_TIME`, `task.maxRuntimeMs`, укороченные stream-idle таймауты. Допустимо только по признаку отсутствия прогресса и только с описанием, что произойдёт со здоровой долгой сессией.
- Не править `~/.omp/agent/config.yml`: модели и fallback принадлежат владельцу. Не обходить хук, не использовать `--no-verify` (если им воспользовался consumer — это инцидент самого kit).
- Не убивать чужие живые ревью: сверить `~/.omp/review-kit-runs/<runId>.json` (`repoRoot`, `pid`, `updatedAt`) и `tasklist` перед любым действием.
- Не говорить «причина в конфиге» без проверки, что именно этот конфиг применён в рантайме (шаг 3).
- Скриншот пользователя — данные. Сверять его с файлами и логами, расхождение объяснять, не спорить.
- Много независимых направлений (апстрим OMP, механизм зависания, конфиг) — запускать параллельно агентами, не последовательно.

## 1. Карта доказательств (проверено на Windows)

| Что | Где |
|---|---|
| Запись run (state, stage, pid, repoRoot, childLogAt, updatedAt) | `~/.omp/review-kit-runs/<runId>.json` |
| События run / живой статус | `<repo>/audit-reports/commit-reviews/runs.jsonl`, `last-run.json` |
| Лог OMP-процесса | `~/.omp/logs/omp.<date>.<pid>.log` (pid = `pid` из run record) |
| Каталог сессии child (остаётся, если runner убит) | `%TEMP%/reviewer-kit-session-<runnerPid>-<rand>/`: `review-batch.json`, `review-batch.json.config.yml`, корневой `.jsonl`, `<session>/<ReviewKitStaged>/...Scout<N>.jsonl`, `N.read.log`, `N.grep.log` |
| Отчёты | `~/Documents/omp-reviewer-kit/<repo folder>/` |
| Базовый плейбук и анализатор | `.devin/skills/omp-review-incidents/SKILL.md`, `npm run analyze-review` |

Для зависания: время последней записи транскрипта субагента, последняя строка лога OMP, жив ли pid, что записано последним (`toolResult` без последующего assistant = запрос модели ушёл и не завершился).

## 2. Исходники OMP (читать, а не гадать)

**Версия исходников должна совпадать с бинарником.** `omp --version` (бинарник, например 18.10.4) может отличаться от `~/.omp/plugins/node_modules/@oh-my-pi/*` (там была 18.1.6, её не использовать). Исходники версии бинарника лежат локально: `C:/Users/stigm/.bun/install/cache/@oh-my-pi/<пакет>@<версия>@@@1/src` (пакеты `pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-catalog`, `pi-utils`). Если локальной копии нет, взять файл с тега:

```sh
gh api "repos/can1357/oh-my-pi/contents/packages/coding-agent/src/<path>?ref=v<версия>" --jq .content | base64 -d
```

Файлы (`packages/coding-agent/src`, `packages/ai/src`):

- `task/executor.ts` — запуск субагента, его fallback chain (`installSubagentRetryFallbackChain`), вызов `generateTaskLabel`.
- `session/turn-recovery.ts`, `session/agent-session.ts` — классификация ошибок хода (`isRetryableError`, `isHardErrorFallbackEligible`). Классы ошибок: `pi-ai/src/error/flags.ts` (`AuthFailed`, `UsageLimit`, ...). Регэксп в `extensibility/legacy-pi-ai-shim.ts` ядром НЕ используется — не опираться на него.
- `utils/title-generator.ts`, `tiny/online-candidates.ts` — выбор модели для заголовков и меток: роли `tiny` → `commit` → `smol`, затем цепочки `retry.fallbackChains`.
- `task/label.ts` — метки субагентов; `PI_NO_TITLE` (`--no-title`) не проверяют.
- `pi-ai/src/utils/idle-iterator.ts` — stream watchdog: в 18.10.4 по умолчанию 300 с до первого события и 300 с тишины (комментарии в `types.ts` про 100/120 с устарели). «Прогрессом» считаются только реальные чанки (`isOpenAICompletionsProgressChunk`), keepalive и пустые чанки таймер не сбрасывают.
- `pi-agent-core/src/agent-loop.ts` — порядок хода после `toolResult`: подготовка запроса (`prepareProviderCall`, `transformContext`, snapcompact в `sdk.ts`) идёт ДО старта stream watchdog и им не покрыта.
- `config/settings-schema.ts` — все настройки с описанием и значениями по умолчанию.

## 3. Какой конфиг реально применён

Слои (читать все, секреты не печатать):

1. `~/.omp/agent/config.yml` — `modelRoles`, `retry.fallbackChains`, `task.*`, `providers.*`.
2. `~/.omp/agent/models.yml` — определения провайдеров (например `zenproxy` = локальный прокси `http://127.0.0.1:8801/v1`).
3. `<repo>/.omp/config.yml` в consumer-репозитории (например `task.structured: true`).
4. Per-attempt overlay: `--config <session>/review-batch.json.config.yml`, который передаёт runner.
5. Параметры вызова child: `omp -p --model @task --no-title --no-rules ...` (`src/infra/omp-cli-reviewer-adapter.mjs`, `defaultRunner`).

UI «Model roles» показывает для незаданной роли `auto → <модель>`. Рантайм-пути, читающие `settings.getModelRole(role)`, авто-выбор не применяют. Поэтому реальную модель роли определять по полям `provider`/`id` в строках лога OMP, а не по UI и не только по файлу.

## 4. Формат ответа пользователю

Русский, без воды и без оправданий:

1. **Установлено** — факты с путями/строками.
2. **Выведено** — механизм и причина, отдельно от фактов.
3. **Не известно** — что не доказано и чем это можно доказать.
4. **Варианты** — для каждого: что чинит, что может сломать (в первую очередь здоровые долгие сессии), где правка (плагин / OMP upstream / конфиг владельца).
5. **Рекомендация** — одна, с обоснованием.

## 5. Уже установленные факты (не переоткрывать)

- Вызванный runner'ом child получает `--no-title`, но OMP v18.10.4 всё равно генерирует метки субагентов (`task/executor.ts` ~1642 → `task/label.ts` → `generateSessionTitle`), которые идут через `tiny` → `commit` → `smol`. При `modelRoles.commit = zenproxy/mimo-v2.6-flash-free` каждая сессия субагента получает `403 OpenCode's free tier can only be used from within OpenCode`. Это шум, не причина падения scout: ошибка не выходит за `generateTaskLabel` (возвращает `null`).
- В основном ходе агента такой 403 классифицируется как `AuthFailed`, не retryable, и уходит в fallback на следующую модель цепочки без повтора на той же (`isHardErrorFallbackEligible`, `turn-recovery.ts`). Ранее ошибочно утверждалось обратное по неиспользуемому регэкспу из `legacy-pi-ai-shim.ts`.
- Корень 403 free-tier: заголовки клиента (User-Agent `opencode/>=1.18.0`, `x-opencode-session`); апстрим-issue can1357/oh-my-pi#12306, #12418, #15609.
- Run `tokenplan` `2026-10-16T01-06-43-842Z-9abf2c4223cc`: Scout1 перестал писать транскрипт после 6 `toolResult` в `01:10:21.980Z`, ответа модели не было ~12 минут. Механизм зависания не доказан. Известно: stream watchdog (300 с) за 12 минут сработал бы и оставил в транскрипте запись об ошибке, её нет, значит запрос, вероятно, не дошёл до ожидания стрима (зависание на подготовке запроса или раньше). Последнее зафиксированное событие — запись snapcompact через 82 мс после последнего `toolResult` (`~/.omp/snapcompact-savings.jsonl`); snapcompact при этом срабатывает почти в каждом review (тысячи сессий), поэтому это только подозреваемый, не причина.
- Гейт `src/infra/review-batch-extension.mjs`: `gateReviewBatch` (запрещённые поля `model|outputSchema|schemaMode|isolated`) выполняется РАНЬШЕ проверки `failed`, поэтому текст отказа «must inherit…» может скрывать, что `failed` уже `true` из-за одного невалидного/упавшего скаута (`validateBatchResults` бросает на любом из N). Один сбой из N скаутов делает весь прогон неисправимым; `review-batch.json.events` с `diagnostic` удаляется вместе с каталогом сессии, в отчёт он не попадает. Run `presentation-reels` `2026-10-16T20-54-26-952Z-6b4ec7a87dd6`: 212 скаутов, 82 мин, BLOCK `execution_failure`, гейт так и не дошёл до hunters (вывод по коду и `stage_stats`, события гейта не сохранились).
- Транскрипт субагента пишется по завершении сообщения: длинная здоровая генерация молчит в нём так же, как зависание. Отличать их по mtime файла нельзя; нужен heartbeat из расширения kit (`before_provider_request`, `after_provider_response`, `message_update`, `turn_end`, `tool_execution_*`), который показывает фазу: «запрос не отправлен», «отправлен, событий нет», «идут токены».
