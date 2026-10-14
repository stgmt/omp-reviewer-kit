# Ускорение mutation gate — анализ и план, 2026-10-13

## Запрос и границы

Владелец запросил сразу три оптимизации: 4 асинхронных workers, одну копию проекта на worker с доказанной очисткой, точные test selectors с доказанным убийством мутантов; также общий скилл, который требует этот подход по умолчанию и спрашивает о переделке несовместимого runner.

Этот документ сохраняет исходный анализ и план до разрешения реализации. После «делай план» реализация и default routing выполнены; текущие проверки и незавершённые условия отражены в `mutation-acceleration-status-2026-10-13.md`. Исторический gate проверял прежний immutable export; его зелёный результат не переносится на новые bytes.

## Подтверждённое

Источник: `scripts/run-mutation-tests.mjs`, существующие owning tests и текущий gate log.

- 562 curated mutants, 49 owning test files.
- Последовательный цикл: полный `copyRepoTree` → одна замена → блокирующий `spawnSync('node', ['--test', mutant.testFile])` → удаление всего дерева.
- Повторы полных suites: review-progress 43, review-run-records 41, report-artifact-recovery 34, claude-bridge 33, review-round 32, context-pack 28.
- Есть реальные дочерние процессы, Git hooks, PowerShell/process-tree проверки и временные файловые системы. Простой параллельный запуск без ресурсной классификации может вернуть timing failures.
- Tests создают файлы и меняют env внутри своих процессов. Runner переопределяет runs/targets/reports, но не предоставляет доказательство полного сброса worker state.
- Сейчас любой nonzero без `ETIMEDOUT` считается KILLED. Это недостаточно: spawn/import/syntax/harness failure не доказывает, что целевой тест обнаружил изменение поведения.
- Точное время copying/testing/cleanup сейчас отдельно не измеряется; обещать 4× или конкретный итоговый срок нельзя.
- Во время анализа background wrapper завершился с `mutation exit=null` после своего часового ограничения; mutation log продолжил обновляться (391 killed, 0 survived на 04:33 UTC). Это не завершённый gate и не доказательство дефекта мутанта: родитель потерял управление дочерней задачей. Новый runner/wrapper обязан согласованно обрабатывать внешний timeout, не оставлять orphan subprocesses и не выдавать частичный набор за PASS. Текущий release остаётся незавершённым.
- Context7 недоступен из-за месячной квоты. API reporters/selectors нужно подтвердить по native Node capability probes и поддерживаемой CI matrix, не по предположению.

## Целевая схема

```text
immutable input + mutant catalog hash
  → baseline and selector calibration
  → pool: 4 async workers, each owns one copied tree
  → pristine-state check + isolated job-state directory
  → guarded mutation + focused test execution
  → classify test evidence
  → stop process tree if needed + restore/check worker
  → exact-once result record
  → full-set gate and timing summary
```

Один мутант активен в одной worker-копии; разные workers никогда не пишут в общее дерево. Все 562 IDs остаются обязательными. Не создавать отдельный сервис, scheduler daemon, registry или зависимости: native Node, существующие ports/helpers и один локальный bounded pool.

## 1. Базовая измеримость и корректный outcome

Ownership: `scripts/run-mutation-tests.mjs`, небольшой импортируемый helper под `scripts/` при необходимости, `tests/mutation-runner.test.mjs`.

- Отделить каталог от исполнительной функции настолько, чтобы тесты могли запускать малый fixture catalog без исполнения всех production mutants.
- Явно хранить id, file, original/replacement, owning test file, доказанный selector, resource class. Проверить unique IDs и ровно одно совпадение mutation anchor.
- Результат: killed / survived / timeout / infrastructure_error / invalid_mutant / selector_invalid. Только killed повышает kill count; остальные состояния блокируют release gate.
- Killed требует baseline PASS, успешно запущенный и завершившийся процесс, непустой набор действительно исполненных выбранных leaf tests и подтверждённое падение согласованного behavior/contract assertion.
- Синтаксическая ошибка mutated module, import failure, crash/signal, reporter error, startup error и незавершённые tests не засчитываются как kill. Если проверяемое поведение само является запуском/импортом, нужен явный contract test с положительным baseline и конкретной assertion, а не падение harness.
- Унаследованный `NODE_TEST_CONTEXT` удалить как в `scripts/run-tests.mjs`; live E2E/SDK opt-ins не должны случайно включаться в safety gate.
- Сохранять compact per-mutant records и итог: exact catalog/input fingerprint, workers, selector mode, counts, elapsed/setup/test/reset timings, max active/exclusive count. Не писать credentials и raw sessions.

Acceptance: тесты краснеют, если timeout/crash/нулевое число выбранных tests/повтор ID/пропуск ID можно выдать за 100%.

## 2. Четыре асинхронных workers

- `spawn(process.execPath, argv)` вместо `spawnSync` внутри рабочего цикла. По умолчанию 4 workers; валидируемый opt-in override для диагностики, без изменения количества mutants.
- Переиспользовать существующий process-tree termination helper; timeout означает незавершённое доказательство, не killed. Дождаться закрытия stdio и завершения дерева до reset/reuse. Непроверенный оставшийся процесс запрещает reuse.
- Начать с консервативной явной resource-class карты: реальные timeout/termination/process-table и timing-sensitive suites — exclusive. Обычные isolated pure/file tests — parallel. Классификация по прочитанному содержимому, не по regex как окончательному доказательству.
- Exclusive job запускается только после drain всех активных jobs; пока он идёт, обычные jobs не стартуют. Один semaphore лишь между тяжёлыми jobs недостаточен: остальные workers тоже создают нагрузку.
- Не использовать `Promise.all` для 562 одновременных subprocesses. Очередь bounded; ошибки учитываются, не теряются при первой rejected promise. Прерывание останавливает только проверенные дочерние процессы этого runner.

Acceptance: детерминированные fixture tests доказывают max active ≤4, реальное перекрытие parallel jobs, exclusive active=1 с пустым parallel lane, обработку spawn errors/timeouts/signals без зависания и точное выполнение всех IDs.

## 3. Одна копия проекта на worker и reset

- Четыре раздельных copied trees из одного immutable input; никакие writable hardlinks с оригиналом или между workers не допускаются. Source worktree/index не мутируются.
- Базовый manifest copied tree включает paths, bytes hashes, modes и symlink targets; tree копируется только при создании/rebuild worker.
- У каждого job отдельный scratch-root: TMPDIR/TEMP/TMP и существующие runs/targets/reports overrides. При необходимости HOME/USERPROFILE изолируются только после проверки fixture compatibility; Git identity/config для fixtures задаются явно. Tests не должны лечить пользовательские repositories или использовать реальные credentials.
- До следующего job восстановить mutated file в `finally`, удалить только созданные этим worker artifacts, восстановить изменённые/удалённые baseline paths и modes. Проверить весь copied-tree manifest, а не только mutation target: тест мог изменить другой файл.
- Следующий job не стартует, пока baseline fingerprint не совпал и дочерние процессы не завершены. Отклонение/cleanup failure делает worker contaminated: изъять, сохранить bounded diagnostic, rebuild из immutable input; результат проблемного job не превращать в green.
- Job scratch удаляется лишь после process-tree completion. Не удалять неизвестные пользовательские temp directories и не обходить symlink наружу.
- Полный повторный hash scan может сам стать дорогим: измерить его отдельно. Не заменять доказательство чистоты эвристическим «обычно tests ничего не меняют».

Acceptance: fixtures создают, меняют, удаляют source/artifact files и modes; следующий mutant видит pristine tree. Ошибка test или timeout также запускают reset. Foreign path/symlink и живая child process не допускают опасный cleanup/reuse.

## 4. Точные selectors для всего каталога

- Добавить к каждому ID literal/escaped test-name pattern либо минимальную группу конкретных contract tests. Поддерживать dynamic labels и nested suite ancestry; regex substring без проверки недопустим.
- Сначала capability probe на используемых Node versions: selector реально запускает ожидаемые leaf tests и native machine-readable evidence показывает pass/fail/skip/cancel. Не угадывать reporter API; engines/CI совместимость не ухудшать молча.
- Baseline выбранных tests должен PASS; selected tests >0, все ожидаемые leaf IDs присутствуют, нет unexpected skips/cancel. Сам suite header не считается исполненным тестом.
- На mutation каждый selector должен получить доказанное assertion failure согласованного теста. Подтвердить это для всех 562 mutants и сопоставить полный-set IDs с reference full-suite run.
- На одном immutable input сравнить focused и full-suite outcomes. Исторический stdout «KILLED» старого runner сам по себе не является assertion provenance.
- Если focused selector не обнаруживает mutant, расширить до реального deciding test/group и повторить локально; не записывать фиктивный kill, не удалять mutant. Если теста нет — добавить реальный regression или явно blocked.
- Вводить default focused mode только после 562/562 selector proofs. Legacy full-suite режим оставить явным диагностическим override; любое использование раскрывается. В будущих проектах отсутствие calibrated selector является вопросом о переделке, а не поводом молча притвориться быстрым gate.
- Baseline/selector proof reuse возможен только при совпадении input/catalog/test bytes, Node/platform, argv/env policy, reporter и runner versions. Хеш file alone недостаточен из-за imports и fixtures. Не строить общий межпроектный cache на первой итерации.

Acceptance: invalid regex, zero selected tests, nested parent skip, случайный отказ другого теста, stale proof и changed fixture обязательно дают blocked, не killed.

## 5. Интеграция всех трёх направлений

- Default `npm run test:mutation`: workers=4 + verified reusable trees + calibrated focused selectors. Никакая часть не остаётся «оптимизацией когда-нибудь потом».
- Focused self-tests → integration fixtures → полный calibrated catalog → reference equivalence → `npm test`, `npm run check`, `npm run test:mutation` на новом exact index export.
- Проверить Windows и Ubuntu на поддерживаемых CI Node 18/20/22. На Windows отдельно exclusive lane и termination; не добиваться зелени снятием timing/side-effect assertions.
- Сравнить serial reference, pool-only и final combined на одинаковом fingerprint. Публиковать измеренные wall-clock/setup/reset/test times, не обещанный speedup. Для дорогого reference использовать один достаточный запуск, не несколько бессмысленных повторов.
- Проверить, что сам runner regression suite способен убить изменения accounting/isolation/scheduling/selectors; включить эти mutants в production catalog. Поэтому final count станет >562, и новое число раскрывается, исходные 562 не теряются.
- Обновить README/AGENTS и release skill: reference/calibration не каждый commit; default быстрый gate должен оставаться полным доказательством. Source changes требуют нового review и release verification, прежний index proof не переносится.

## 6. Общий скилл и default routing — выполняется сейчас

- User skill `~/.claude/skills/mutation-fast-default/SKILL.md`.
- Читаемая project copy: `.claude/skills/mutation-fast-default/SKILL.md` (на данный момент untracked, не входит в текущий release index).
- Короткая global CLAUDE routing rule: перед изменением или запуском mutation gate читать скилл; если runner не соответствует стандарту и переделка ещё не разрешена, спросить о переделке и не начинать молча долгий legacy run.
- Если пользователь уже явно попросил переделку, повторно разрешение не спрашивать. Runtime models, hook, credentials и unrelated repositories не менять.
- При активном чужом/предыдущем gate не останавливать и не смешивать fingerprints. Это предложение новой реализации, а не обещание ускорить уже идущий subprocess.

## Порядок и критерий готовности

1. Skill/default routing и этот план.
2. Accounting + testable runner + machine-readable test evidence.
3. Pool/exclusive lane и reused-tree reset в одном integration package.
4. Полная selector calibration для 562 исходных IDs; добавление regression mutants самого runner.
5. Reference equivalence и benchmark одного exact input.
6. Новый exact-index full verification; затем review/release по отдельной delivery цепочке.

Готово только если: default запускает все обязательные IDs, 4 workers действительно перекрываются, exclusive lane доказан, reuse не переносит state, все selectors доказаны, никаких infrastructure failures среди killed, suite/mutation/layout зелёные, ускорение измерено. Сейчас готов только анализ/план/skill routing; runner implementation и speedup ещё не проверены.
