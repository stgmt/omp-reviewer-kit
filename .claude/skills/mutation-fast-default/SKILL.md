---
name: mutation-fast-default
description: Mutation gate omp-reviewer-kit (scripts/run-mutation-tests.mjs, scripts/mutation-runner.mjs, scripts/mutation-selectors.json). Читать до запуска, изменения или планирования гейта, калибровки (--calibrate, --calibrate-stale), каталога селекторов, якорей мутантов и cleanup временных деревьев (EBUSY/EPERM на Windows).
---

# Mutation gate omp-reviewer-kit: стандарт

Читать до любого запуска, изменения или планирования гейта. Общий стандарт (глобальный skill `mutation-fast-default`) действует здесь целиком; ниже — что он значит для этого репозитория и какие ошибки уже стоили часов.

## Жёсткие правила (нарушение = гейт не принимается)

1. **Удаление временного дерева только с ретраями.** Раннер удаляет через `removeTree`, то есть `rm(target, REMOVE_OPTIONS)` с `recursive`, `force`, `maxRetries: 20`, `retryDelay: 250`. Голый `rm`/`rmSync` с `recursive` на дереве запрещён.
2. **Каждое доказательство пишется сразу.** `onProven` дописывает каталог `mutation-selectors.json` после каждого убитого мутанта (`writeCatalog`), записи выстроены в очередь, потому что параллельные воркеры не должны писать файл одновременно. Упавший прогон не теряет уже доказанного.
3. **Cleanup-фейл — инфраструктура, не вердикт.** Дерево, которое не удалилось после ретраев, даёт `infrastructure_error`. Его нельзя считать `killed`, и это не должно молча ронять зелёный гейт.
4. **Killed — только доказанный `ERR_ASSERTION` ожидаемого теста.** Timeout, signal, `status: null`, ошибка импорта или spawn, ноль выбранных тестов, падение без assertion — не kill.
5. **Селектор привязан к байтам.** `mutantHash` — sha256 от `[id, file, testFile, original, replacement]`. `testHash` — sha256 решающего тест-файла с нормализованным CRLF. Изменили мутанта или тест — селектор stale, его нужно заново доказать.

## Устройство в этом репозитории

- Каталог: `MUTANTS` в `scripts/run-mutation-tests.mjs`, 286 записей `{id, file, testFile, original, replacement, description}`. Запись — однострочный JS-объект, поэтому якоря надо менять аккуратно.
- Селекторы: `scripts/mutation-selectors.json`, schema `mutation-selectors@1`, `mappings[id] = {testFile, tests, ancestors, mutantHash, testHash}`.
- Раннер: `scripts/mutation-runner.mjs`. Ключевое: `runCli`, `runMutationGate`, `runTest`, `classifyTestRun`, `captureTree`/`restoreTree`, `removeTree`, `mergeCalibration`, `testFileHash`, `mutantIdentity`.
- Шов для тестов: `runMutationGate(..., { runTestImpl })` подменяет реальный прогон. Сценарии калибровки в `tests/mutation-runner-cleanup.test.mjs` проверяют ветки без реальной сюиты.
- Тесты раннера: `tests/mutation-runner.test.mjs`, `tests/mutation-runner-cleanup.test.mjs`, `tests/run-mutation-tests-cli.test.mjs`.
- Таймауты: focused-прогон 120 с; полный файл (baseline и reference) — `FULL_SUITE_TIMEOUT_MS` = 30 мин.
- Воркеры: `OMP_MUTATION_WORKERS` (1–16, по умолчанию 4; на этой машине 8). Результат пишется в `OMP_MUTATION_RESULT`, по умолчанию `audit-reports/mutation-result.json` (этот путь не коммитить).
- Node 22+ нужен для точного выбора вложенных `describe`. Plugin runtime остаётся на Node 18+.

Команды:

```bash
node scripts/run-mutation-tests.mjs                     # проверка сохранённых селекторов, полный каталог
node scripts/run-mutation-tests.mjs --calibrate         # калибровка с нуля
node scripts/run-mutation-tests.mjs --calibrate-stale   # перепроверка устаревших, затем полный гейт
```

Код выхода `--calibrate-stale` — вердикт всего каталога, а не только устаревших мутантов.

## Калибровка

- **С нуля.** Baseline полного файла должен быть зелёным. Reference полного файла с мутантом даёт решающий `ERR_ASSERTION`. Фокусный прогон по этим именам должен убить мутанта. Иначе `selector_invalid` или `infrastructure_error`.
- **`--calibrate-stale`.** Recorded selector передаётся как hint. Сначала фокусный прогон по старым именам: baseline PASS и мутант убит. Полный reference нужен только тогда, когда старые имена больше не решают.
- **Вложенные `describe`.** Селектор хранит `ancestors`, фокусный прогон идёт по полному пути. Ветка «верхнеуровневый прогон проходит, scoped-прогон падает»: при hint откат к reference, без hint — `selector_invalid`. Селектор без доказательства не выдаётся в обоих случаях.
- **Красная сюита на чистом дереве.** Все мутанты файла дают `infrastructure_error`, никто не убит. Сначала починить тест.

## Перед долгим прогоном

- Каталог не пуст. После правки решающего теста ожидать `selector_invalid` с «Deciding test changed»: тогда сначала `--calibrate-stale`.
- **Якоря.** `original` каждого мутанта встречается в цели ровно один раз. После правки целевого файла проверить это до длинного прогона. Иначе падение «Mutation target must match exactly once» всплывёт только в середине гейта.
- **Экспорт — из индекса, не из рабочего дерева.** `git checkout-index` берёт содержимое индекса. Если тесты или каталог изменены и не проиндексированы, экспорт проверит старую версию. Сначала `git add` нужных путей.
- Экспорт: `git -c core.autocrlf=false checkout-index -a --prefix=<пустой-каталог>/`, затем `git -C <каталог> init`. `node_modules` подключать junction'ом, не копировать (OMP-библиотека около 800 МБ): `cmd //c "mklink /J <экспорт>\node_modules <репо>\node_modules"`.
- Замеры (этот репозиторий, 286 мутантов): полный гейт 8 воркеров в тишине — около 313 с; до правок раннера (без 30-минутного лимита для полного файла и без ретраев удаления) — 619–661 с. Цифру заранее не обещать: засекать по логу.

## Windows: EBUSY/EPERM при cleanup

Порядок действий:

1. Убедиться, что удаление дерева идёт через `removeTree` с ретраями. Это чинит причину в коде.
2. Найти держателя handle: процесс с CWD внутри удаляемого каталога, недобитый потомок (`taskkill /PID <pid> /T /F`), антивирус или индексатор. Антивирус и индексатор отключать только после п.1 и с разрешения пользователя.
3. Не называть EBUSY флейком и не перезапускать гейт вслепую.

Проверено: тест на удержанный каталог (только win32) проходит. Точный бюджет ретраев не измерен: путь исчерпания требует каталог, занятый около минуты.

## Чего не делать

- `git commit --no-verify` и любой обход review-хука без явного разрешения.
- Правки `~/.omp/agent/config.yml` ради гейта.
- Повторный полный прогон «на удачу». Сначала найти причину падения, затем прогон.
- Молча менять `MUTANTS` или решающие тесты: каждое изменение — отдельная запись в коммите и `--calibrate-stale`.
- Коммитить `audit-reports/mutation-result*` и прочие артефакты прогона.
