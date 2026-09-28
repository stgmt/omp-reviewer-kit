# slop-v2 — dev-pomogator test-review machinery port

## Что это

Порт тестово-ревьюной машинерии dev-pomogator в omp-reviewer-kit. Добавляет:
- **test-slop lens**: детекторы слабых тестов (9 антипаттернов, скоринг, self-eval)
- **slop-test-hunter**: агент для поиска дефектов качества тестов в review
- **test-author**: контракт честного авторинга (drift→author→run→green→flip)
- **verify-kill**: детерминистический kill-proof для тестов
- **compliance-gate**: блок записи тестов с антипаттернами
- **anti-loop + escape-audit**: обязательные инварианты для всех гейтов
- **stumble-report**: единая панель обходов и ошибок

## Источник

`E:/repos/dev-pomogator` — полная карта в `RESEARCH.md` (65KB).

## Статус

DRAFT — ожидает решения по DESIGN.md вариантам.
