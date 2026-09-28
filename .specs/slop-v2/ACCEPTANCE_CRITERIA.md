# ACCEPTANCE_CRITERIA — slop-v2

> BDD-сценарии для каждого TAKE-требования. Формат: Given/When/Then.

## AC1: Compliance-гейт блокирует антипаттерн

**Given** staged тест-файл `tests/foo.test.mjs` с `expect(x).toBeDefined()`
**When** разработчик делает commit, pre-commit gate сканирует staged тесты
**Then** exit 1 с причиной `weak-assertion: toBeDefined-only at tests/foo.test.mjs`, коммит отклонён, ревью не запускалось

## AC2: Compliance-гейт пропускает чистый тест

**Given** staged тест-файл с `expect(result).toEqual({id: 1, name: "x"})`
**When** pre-commit gate сканирует staged тесты
**Then** exit 0, коммит идёт дальше в ревью

## AC3: Anti-loop маркер предотвращает бесконечный блок

**Given** compliance-гейт отклонил 3 коммита подряд с одинаковым hash
**When** разработчик делает 4-й commit без изменений
**Then** гейт пропускает с warning «anti-loop: same hash 3x, cooldown active»

## AC4: Escape-hatch логируется

**Given** staged тест с `// test-compliance:skip legitimate reason for skipping`
**When** pre-commit gate сканирует при commit
**Then** escape записан в `audit-reports/escapes.jsonl` с gate, reason, timestamp

## AC5: Escape с коротким reason → warning

**Given** staged тест с `// test-compliance:skip x`
**When** pre-commit gate сканирует при commit
**Then** warning «escape reason too short (<8 chars)» + escape всё равно записан

## AC6: verify-kill доказывает что тест ловит баг

**Given** тест `tests/foo.test.mjs` проходит на good code
**When** `verify-kill.mjs` инжектит мутацию `>` → `>=` в строку 42
**Then** тест FAIL → restore → re-run → PASS → exit 0 (KILLED)

## AC7: verify-kill детектит fake-positive

**Given** тест проходит на good code
**When** `verify-kill.mjs` инжектит мутацию
**Then** тест PASS → exit 1 (SURVIVED — тест не ловит баг)

## AC8: slop-test-hunter находит weak assertion

**Given** staged diff содержит `expect(res.ok).toBe(true)` без проверки body
**When** slop-test-hunter анализирует diff
**Then** кандидат: `weak-assertion: response-ok-only, line N, severity P2`

## AC9: test-author делает drift-check перед авторингом

**Given** сценарий уже покрыт тестом `tests/existing.test.mjs`
**When** test-author получает задачу «написать тест для X»
**Then** cite existing test + STOP, не создаёт дубликат

## AC10: test-author NEVER flip first

**Given** test-author написал тест но не запустил его
**When** он пытается пометить задачу как done
**Then** контракт блокирует: «NEVER flip pre-green — run test first»

## AC11: Stumble-отчёт показывает escape-логи

**Given** 3 escape-записи в `escapes.jsonl` за последние 24h
**When** `/reviewer-kit:status` вызван
**Then** вывод содержит «3 escapes in 24h» + 🟡 если >5

## AC12: Детектор fixture-fake

**Given** фикстура содержит поле `internalState: "debug"` которого producer не эмитит
**When** fixture-gate проверяет фикстуру
**Then** кандидат: `fixture-fake: field 'internalState' not in producer envelope`

## AC13: Dirty-tree правило

**Given** тест падает в dirty worktree
**When** применяется dirty-tree правило
**Then** вердикт: «не доверять — clean worktree от HEAD + полный прогон»

## AC14: Generic-scope verify

**Given** diff добавляет 3 элемента в enum, гейтящий `isAllowed()`
**When** generic-scope verify проверяет reachability
**Then** каждый вариант классифицирован: traced / unreachable / conditional

## AC15: Dogfood-процедура

**Given** новый gate-скрипт написан
**When** применяется dogfood-процедура
**Then** скрипт вызван с реальным входом → результат записан → сравнен с ожиданием
