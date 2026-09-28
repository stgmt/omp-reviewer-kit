# USE_CASES — slop-v2

## UC-1: Compliance-гейт на коммите (D1c)

1. Разработчик пишет `tests/foo.test.mjs` и делает `git add` + `git commit`
2. Pre-commit hook вызывает `scripts/test-compliance.mjs` до `run-review.mjs`
3. Гейт сканирует staged тест-файлы: `scanAntiPatterns(content)` → `[{rule: 'weak-assertion', line: 5}]`
4. `checkMarker('test-compliance', hash)` → not blocked
5. Exit 1 с причиной `weak-assertion: toBeDefined-only at tests/foo.test.mjs:5` → коммит отклонён, ревью не запускалось
6. Разработчик исправляет, повторяет commit → gate pass → ревью запускается

## UC-2: slop-test-hunter в review pipeline

1. `git commit` → pre-commit hook → `run-review.mjs`
2. Stage 2: orchestrator спавнит `slop-test-hunter` (lane: test-quality)
3. Hunter читает `.review/diff.patch` → находит `expect(res.ok).toBe(true)`
4. Кандидат: `{rule: 'response-ok-only', file: 'tests/api.test.mjs', line: 12, severity: 'P2'}`
5. Verifier проверяет: есть ли downstream body-check? → CONFIRMED
6. Verdict: BLOCK с finding

## UC-3: verify-kill на новом детекторе

1. Разработчик написал детектор `unsafe-json`
2. `verify-kill.mjs --file tests/detectors.test.mjs --mutation "s/JSON.parse/JSON.stringify/"`
3. Inject → run → expect FAIL → restore → re-run → PASS → exit 0
4. Детектор доказан: ловит баг

## UC-4: Escape-hatch

1. Агент пишет `// test-compliance:skip generated file, no manual tests needed` и коммитит
2. Pre-commit gate видит suppression → `logEscape('test-compliance', 'generated file...', context)`
3. `escapes.jsonl` += `{gate, reason, timestamp, file, hash}`
4. `/reviewer-kit:status` → «1 escape in 24h»

## UC-5: test-author полный цикл

1. Задача: «написать тест для parseConfig()»
2. Drift-check: `grep parseConfig tests/` → `tests/config.test.mjs` уже покрывает
3. Cite + STOP — не создаёт дубликат
4. Если не покрыто: author → `node --test` → green → flip done
