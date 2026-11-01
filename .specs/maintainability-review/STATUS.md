# Maintainability review — состояние проверки

Запись о том, что проверено исполнением, а что остаётся непроверенным. Она дополняет матрицу [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md): пункт считается пройденным только там, где назван реальный прогон.

## Что реализовано

- `src/native/maintainability/extract.mjs`: адаптер JS/TS (`@babel/parser`) и адаптер Python (stdlib `ast` в одном дочернем интерпретаторе). Различает объявление, пересылку и место вызова; параметры-деструктуризация и `*args`/rest не выдумываются.
- `src/native/maintainability/group.mjs`: максимальные группы, порог поддержки, исключения `test-class`, `generated`, `oversized-signature`; поддержка считается по всему снимку.
- `src/native/maintainability/analyze.mjs`: статусы `analyzed`/`no-candidates`/`unsupported`/`failed`, охват `coverage`, `scan`, `unparsedFiles`, `failures`, файл `.review/maintainability.json` (`maintainability@1`) внутри staged-снимка.
- `agents/review-maintainability.md`: `model: "@task"`, только чтение, схема ответа с `priority` и `stated_cost`; имя внесено в `spawns` оркестратора, стадия 2b в его промпте, раздел `### Maintainability` в отчёте.
- `src/native/verdict.mjs`: `MAINTAINABILITY_AGENT`, `maintainabilityBlocks` (четыре поля), новые входы `planned` и `maintainability`; пункты сопровождения не попадают в `confirmed_findings`.
- `scripts/measure-maintainability.mjs` воспроизводит таблицу замеров; `@babel/parser` объявлен прямой зависимостью, `bun.lock` обновлён без новых пакетов.

## Прогоны (2026-11-01)

| Что | Команда | Результат |
|---|---|---|
| Полный набор | `node scripts/run-tests.mjs` | 582 теста: 572 pass, 0 fail, 10 skipped (живые модельные кейсы) |
| Раскладка | `node scripts/check-layout.mjs` | `layout ok: 77 files verified` |
| Мутационный гейт | `node scripts/run-mutation-tests.mjs --calibrate-stale` | 309/309 убито, «Mutation gate PASSED» |
| Замер | `node scripts/measure-maintainability.mjs` | 98 файлов по индексу, 296 сигнатур, повторные прогоны 160–353 мс |

## Что остаётся непроверенным

- Живой прогон с моделью не запускался: он тратит деньги и включается только переменной `OMP_REVIEW_KIT_LIVE_E2E=1`. Поведение подагента на настоящих кандидатах не наблюдалось.
- Ложные срабатывания на чужих репозиториях не измерялись: числа получены на этом репозитории и на дереве `tests` `presentation-reels`.
- Python-адаптер проверен при установленном интерпретаторе; отсутствие интерпретатора проверено на подставном имени команды, а не на машине без Python.
