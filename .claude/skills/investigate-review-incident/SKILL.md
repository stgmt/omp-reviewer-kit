---
name: investigate-review-incident
description: Use when a consumer repository's agent or the user reports a problem with the omp-reviewer-kit pre-commit review (hang or long silence, BLOCK without a clear reason, `review: BLOCK (host error ...)`, no report written, commit stopped by the reviewer-kit guard, unexpected reviewer model or fallback, `--no-verify` used) or asks why the review behaved a certain way. Defines the mandatory investigation protocol and evidence map for the native (Bun) review of 0.22.0 and later, so the first answer is already complete.
---

# Расследование инцидента ревью (dogfood)

Первый ответ должен быть полным. Пользователь не должен «пинать» ради второго прохода. Не отвечать, пока не выполнены разделы 1–4 (карта доказательств, строки хоста, исходники OMP, применённый конфиг).

С 0.22.0 ревью идёт в `src/native/native-host.mjs` под Bun: хост экспортирует staged-снимок, вызывает нативный `TaskTool` OMP с `agent: reviewer-kit`, выносит вердикт в `src/native/verdict.mjs` и пишет отчёт. Старого конвейера в 0.22.0 нет: `review-batch.json`, `runs.jsonl`, `last-run.json`, `~/.omp/review-kit-runs/`, запуск `--model @task`, `OMP_REVIEW_KIT_MODEL` и цепочки моделей кита. Если в описании инцидента встречается что-то из этого списка, прогон был на версии до 0.22.0. Версию проверить по строке 2 `.githooks/pre-commit` (`# omp-reviewer-kit hook v0.22.0`).

Приёмы чтения логов и транскриптов (поля, сообщения, расчёт длительности) — в `.devin/skills/omp-review-incidents/SKILL.md`.

## 0. Жёсткие правила

- Сначала доказательства, потом механизм, потом причина, потом варианты. Каждое утверждение — с путём и строкой или полем. Непроверенное помечать «не проверено».
- Не предлагать защиту, которая может оборвать здоровую сессию: фиксированный wall-clock cap, таймаут на весь ревью или на стадию, укороченные stream-idle таймауты OMP. В `src/native/` таймаутов нет, новых не предлагать. Допустимо только по признаку отсутствия прогресса, с описанием, что произойдёт с долгой здоровой сессией.
- Не править `~/.omp/agent/config.yml` и `~/.omp/agent/models.yml`: модели, роли и fallback принадлежат владельцу и OMP. Кит ничего из этого не выбирает и не пинит: `src/native/task-engine.mjs` накладывает на сессию только `task.structured: true`.
- Не обходить хук и не использовать `--no-verify`. Если им воспользовался consumer, это инцидент, его описать отдельно.
- Не убивать живой ревью, не проверив его (раздел 1, «Живой ли ревью»).
- Не говорить «причина в конфиге» без проверки, что именно этот конфиг применён в этом прогоне (раздел 4).
- Скриншот пользователя — данные. Сверять с отчётом и логами, расхождение объяснять, не спорить.
- Независимые направления (апстрим OMP, механизм зависания, конфиг) — параллельными агентами, не последовательно.

## 1. Карта доказательств

Пути проверены на Windows: `%TEMP%` = `C:\Users\<user>\AppData\Local\Temp`. Имена отчётов и транскриптов — UTC (`Z`), строки лога OMP — локальное время с суффиксом (`+03:00` на этой машине). Не смешивать.

| Что | Где | Что смотреть |
|---|---|---|
| Отчёт прогона | `~/Documents/omp-reviewer-kit/<имя репо>-<hash12 абсолютного пути>/<UTC-время сохранения>-<hash12 диффа>.md`; корень меняет `OMP_REVIEW_KIT_REPORTS_DIR` | Первая строка `# reviewer-kit review: PASS` или `BLOCK`; `Diff SHA-256` (полный хэш); `Reviewer role/model (OMP resolved)`; `Stage evidence`; `Verdict reasons`; текст ревьюера |
| Строки хоста (stderr) | Терминал коммита. Кит их не сохраняет. Попадают ли они в вывод инструмента сессии OMP, если коммит шёл оттуда, не проверено | Раздел 2 |
| Снимок индекса | `%TEMP%/staged-<случайный>/.review/` (`diff.patch`, `changed-files.txt`, `file-classes.json`) | Хост удаляет его в `finally` (`src/native/native-review.mjs`). Снимок, оставшийся после конца прогона, означает, что хост убит сигналом или упал до `finally` |
| Сессия ревьюера | `~/.omp/agent/sessions/<папка по пути репо>/<UTC-время>_<uuid>.jsonl`; в заголовке `session` имя `reviewer-kit native review` | Корень прогона |
| Задача `reviewer-kit` | `…/<UTC-время>_<uuid>/Review.jsonl` | Первое пользовательское сообщение — assignment с `Diff hash (SHA-256 …)`. По этому хэшу связываются отчёт и транскрипт |
| Стадии | `…/<UTC-время>_<uuid>/Review/Review.<Агент>.jsonl`, рядом `.md` и `.json` | `Review.ContextScout`, `Review.CorrectnessHunter` (полоса `correctness`), `Review.FindingVerifier`. Имена хантеров других полос не проверены |
| Лог процесса OMP | `~/.omp/logs/omp.<ГГГГ-ММ-ДД локальный>.<pid>.log` | JSON-строки; `pid` — процесс `bun` хоста. Уровень `debug` пишется по умолчанию, `OMP_LOG_LEVEL` может его срезать |
| Хук и раннер | `.githooks/pre-commit`. В kit: `node scripts/run-review.mjs`. В consumer: `node .omp/review-kit/run-review.mjs` (заглушка) → `scripts/run-review.mjs` установленного плагина → `bun src/native/native-host.mjs <репо>` | Лаунчер проверяет `bun` (`OMP_REVIEW_KIT_BUN`) и библиотеку OMP и пишет `review: BLOCK (...)`, если их нет |
| Guard коммита | `src/extension.mjs`, обработчик `tool_call` → `installer.guardCommit` (`src/application/installer-service.mjs`) | Отказ `reviewer-kit stopped this commit: ...` в выводе инструмента. Ревью не запускалось, отчёта нет |
| Конфиг владельца | `~/.omp/agent/config.yml`, `~/.omp/agent/models.yml` | Только чтение |

### Живой ли ревью

Перед любым действием над процессом:

1. Процесс хоста: `Get-CimInstance Win32_Process -Filter "Name='bun.exe'"`, поле `CommandLine` с `native-host`. Пустой результат — хоста нет.
2. Снимок `%TEMP%\staged-*` с каталогом `.review\` и датой его изменения.
3. Транскрипты задачи и стадий: появились ли записи `message` позже последней записи в файле.

Если хост жив, он в работе: не трогать. Тишина в транскрипте сама по себе не доказывает зависание: в 18.10.4 транскрипт писался по завершении сообщения, для 18.12.5 это не проверено.

### Что не сохраняется (пробелы 0.22.0)

- Строки stderr хоста. Если терминал закрыт, остаются отчёт, транскрипты и лог OMP.
- Телеметрия по прогонам и стадиям. Длительность стадий восстанавливается из транскриптов (первая и последняя `timestamp` в файле стадии) и из строк `subagent launch timing` в логе.
- Строки `Session exit recorded` в проверенных прогонах записаны все разом в конце, поэтому для длительности стадий не годятся.

## 2. Строки хоста (stderr), 0.22.0

Источник: `src/native/native-host.mjs`, `src/native/native-review.mjs`, `src/native/task-engine.mjs`.

- `review: <N> staged path(s), profile <full|spec-docs>, lanes <...>` — начало прогона.
- `review: native task update (<N> result(s), <M> running)` — во время прогона. Одинаковые подряд строки подавляются. Это единственный сигнал живости в терминале.
- `review: reviewer role=<роль> model=<модель>` и `review: stage <агент> role=... model=... exit=... structured=...` — выводятся только после окончания задачи ревьюера.
- `review: PASS` или `review: BLOCK (<причины через "; ">)`, затем `review: report <путь>`.
- `review: SKIPPED (no staged changes)` — exit 0, отчёта нет по замыслу.
- `review: BLOCK (host error: <сообщение>)` — исключение в хосте. Отчёт не записан.
- Лаунчер (`scripts/run-review.mjs`): `review: BLOCK (bun is required ...)`, `review: BLOCK (the OMP library is not installed ...)`, `review: BLOCK (cannot start the native review host: ...)`.
- Если строк `review:` нет вовсе, а выход ненулевой, хост упал или был завершён до вердикта. Лаунчер в этом случае не добавляет своей строки (`child.status ?? 1`).

## 3. Исходники OMP

**Версия исходников должна совпадать с закреплённой.** Kit закрепляет `@oh-my-pi/pi-coding-agent` 18.12.5 (`package.json`, `dependencies`). Исходники лежат в кеше Bun: `C:/Users/<user>/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.12.5@@@1/src`; `pi-utils`, `pi-ai` и `pi-agent-core` той же версии лежат в соседних папках. Если копии нет, взять файл с тега: `gh api "repos/can1357/oh-my-pi/contents/packages/coding-agent/src/<путь>?ref=v18.12.5" --jq .content | base64 -d` (путь и тег не проверены).

Читать, а не гадать. Проверено на 18.12.5:

- `coding-agent/src/task/executor.ts` (~5131) — строка `subagent launch timing`: `id`, `agent`, `queueMs`, `preRunMs`, `resolveMs`, `sessionOpenMs`, `createSessionMs`, `readyMs`, `promptToFirstChatMs`, `setupToFirstChatMs`, `invokeToFirstChatMs`.
- `coding-agent/src/session/agent-session.ts` (~3474) — строка `Session exit recorded`: `sessionId`, `sessionFile`, `reason`, `kind`, `pendingToolCalls`.
- `coding-agent/src/task/structured-subagent.ts`, `leaseArtifacts` — артефакты сессии лежат рядом с её `.jsonl`. Временная папка `%TEMP%/omp-task-*` появляется только без файла сессии. У хоста файл есть (`ensureOnDisk`), поэтому `omp-task-*` в этом пути не возникает.
- `coding-agent/src/session/session-manager.ts` — `create`, `artifactsDirectoryFor`, имя файла `<время с - вместо : и .>_<uuid>.jsonl`. `coding-agent/src/session/session-paths.ts` — `computeDefaultSessionDir`: папка по пути репозитория.
- `pi-utils/src/dirs.ts` — `getAgentDir` (`~/.omp/agent`), `getLogsDir` (`~/.omp/logs`), `getSessionsDir`, `getLogPath`.
- `pi-utils/src/logger.ts` — формат строки (`timestamp`, `level`, `pid`, `message`), `OMP_LOG_LEVEL`.
- `pi-ai/src/types.ts` — `errorMessage` у сообщения; `pi-ai/src/error/finalize.ts` — `stopReason: "aborted" | "error"`.
- `pi-ai/src/providers/devin.ts` — единственный провайдер с отладочной строкой `sending chat request` в 18.12.5. У остальных запросы видны только в транскриптах.
- `coding-agent/src/task/settings.ts` — `agentModelOverrides`. Как именно он накладывается, не проверено.

Код самого кита: `src/native/native-host.mjs`, `native-review.mjs`, `snapshot.mjs`, `assignment.mjs`, `task-engine.mjs`, `verdict.mjs`.

## 4. Какой конфиг реально применён

Слои для ревьюера (читать все, секреты не печатать):

1. `~/.omp/agent/config.yml` — роли моделей, `retry.fallbackChains`, `task.*`, `providers.*`. Ключи сверять с настройками в исходниках OMP, а не по памяти.
2. `~/.omp/agent/models.yml` — определения провайдеров.
3. `<repo>/.omp/config.yml` — проектный конфиг consumer-репозитория. Хост читает настройки с `cwd` = репозиторий (`Settings.init({ cwd })`, `src/native/task-engine.mjs`).
4. Наложение кита: `{ 'task.structured': true }` (`STRUCTURAL_OVERLAY`). Больше кит ничего не задаёт.

Что реально выбрал OMP — из фактов прогона, не из UI и не из файла:

- stderr: `review: reviewer role=... model=...` и `review: stage ...`;
- отчёт: `Reviewer role/model (OMP resolved)` и `Stage evidence`;
- транскрипты: записи `model_change` с полями `model` и `resolvedModelIsFallback` (`true`: модель выбрана маршрутизацией retry fallback, `coding-agent/src/registry/agent-registry.ts`).

Экран «Model roles» не доказательство. Доказательство — поля `model` и `resolvedModelIsFallback` в транскрипте именно этого прогона.

## 5. Формат ответа пользователю

Русский, без воды и без оправданий:

1. **Установлено** — факты с путями, строками или полями.
2. **Выведено** — механизм и причина, отдельно от фактов.
3. **Не известно** — что не доказано и чем это можно доказать.
4. **Варианты** — для каждого: что чинит, что может сломать (в первую очередь здоровые долгие сессии), где правка (плагин / OMP upstream / конфиг владельца).
5. **Рекомендация** — одна, с обоснованием.

## 6. Установленные факты 0.22.0 (не переоткрывать)

Проверено по коду 0.22.0 и по логу и транскриптам прогона `2026-10-22` (UTC в именах файлов, +03:00 в логе):

- **Вердикт** (`src/native/verdict.mjs`, `evaluateReview`). PASS только при одном маркере `REVIEW_RESULT=PASS`, последней непустой строкой текста. Иначе BLOCK с причинами: `reviewer task aborted`, `reviewer task exit N`, `reviewer yield <статус>`, `reviewer yield carries no Markdown report`, `no completed stage evidence for review-context-scout`, `no completed review-risk-hunter task for planned lane(s): ...`, `no completed stage evidence for review-finding-verifier` (только профиль `full`), `verifier confirmed N finding(s) but the reviewer passed`, `reviewer verdict BLOCK`.
- **Засчитанная стадия**: `exitCode === 0`, не `aborted`, `structuredStatus === 'valid'` (`stageCompleted`).
- **Host error**: любое исключение в хосте (снимок, задача, сохранение отчёта) даёт `review: BLOCK (host error: ...)` и отчёта нет (`native-host.mjs`, ветка `catch`).
- **Отчёт** пишется только после вердикта. При `SKIPPED` отчёта нет.
- **Таймаутов** в `src/native/` нет.
- **Телеметрии нет**: кит не пишет `runs.jsonl`, `last-run.json` и `~/.omp/review-kit-runs/`. Статус-строка OMP живёт в памяти (`setReviewStatus`, `src/extension.mjs`). Отсутствие записей не доказывает, что прогона не было. Искать по отчёту, транскриптам и логу.
- **Шум, не причина**: `model discovery failed for provider` (локальные `llama.cpp` и `lm-studio` не запущены), `task: no AsyncJobManager registered; falling back to sync execution`, `title-generator:*`, `MCP tool load failed` (например, `railway`).
- **Прогон 2026-10-22** (отчёт `2026-10-22T07-54-59-704Z-dfe9b214ed56.md`, `BLOCK`): роль `task`, модель `anthropic/claude-haiku-5-5:medium`, все три стадии `exit 0`, `structured valid`, причина одна — `reviewer verdict BLOCK`. Это решение ревьюера, а не сбой: в тексте отчёта верификатор подтвердил два кандидата (P1 и P2) и шесть пробелов покрытия. Пример того, как отличить вердикт от сбоя.
- **Прежние инциденты** разобраны по конвейеру до 0.22.0 (`review-batch.json`, `runs.jsonl`, 403 от `zenproxy`, `--no-title`). Их выводы к 0.22.0 не применяются.
