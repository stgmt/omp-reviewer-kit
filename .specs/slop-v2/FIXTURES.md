# FIXTURES — slop-v2

## Тестовые фикстуры для детекторов

| Фикстура | Назначение | Источник |
|----------|-----------|----------|
| `tests/fixtures/weak-assertion.test.mjs` | Тест с `toBeDefined()`, `res.ok` без body | compliance_check patterns |
| `tests/fixtures/source-scan.test.mjs` | Тест с `toContain('function')` на source | compliance_check patterns |
| `tests/fixtures/silent-skip.test.mjs` | Тест с `try{}catch{}` без assert | compliance_check patterns |
| `tests/fixtures/trivial-input.test.mjs` | Тест с `console.log("OK")` как fixture | compliance_check patterns |
| `tests/fixtures/fake-positive.test.mjs` | Тест который PASS на good AND broken | evals pattern |
| `tests/fixtures/real-fixture.json` | Реальный producer output (cucumber ndjson sample) | real-fixtures recipe |
| `tests/fixtures/dirty-tree-marker.json` | Marker для dirty-tree detection | suite-failure-triage |

## Фикстуры для verify-kill

| Фикстура | Назначение |
|----------|-----------|
| `tests/fixtures/killable.test.mjs` | Тест который FAIL на мутации (KILLED) |
| `tests/fixtures/survivor.test.mjs` | Тест который PASS на мутации (SURVIVED) |
