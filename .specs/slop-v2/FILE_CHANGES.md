# FILE_CHANGES — slop-v2

## Новые файлы

| Файл | Назначение | FR |
|------|-----------|-----|
| `agents/slop-test-hunter.md` | Test-quality specialist agent | FR-C1 |
| `agents/test-author.md` | Test authoring contract agent | FR-C2 |
| `skills/test-slop/SKILL.md` | Test-slop lens: 9 антипаттернов, 12-point self-eval, NEVER-правила, fixture-gate, dirty-tree | FR-A1..A6, FR-E1..E4, FR-E7 |
| `scripts/verify-kill.mjs` | Deterministic kill-proof: inject→FAIL→restore→PASS | FR-B1 |
| `src/infra/test-compliance.mjs` | 9 антипаттернов scanner (regex, zero-dep) | FR-A1, FR-D1 |
| `src/infra/marker-utils.mjs` | Anti-loop markers: hash+cooldown+maxRetries | FR-D7 |
| `src/infra/escape-log.mjs` | Escape-hatch audit: `[skip-X: reason]` → JSONL | FR-D8 |
| `scripts/test-compliance.mjs` | Pre-commit gate runner: сканирует staged тест-файлы, exit 1 на антипаттерне (DEC-1) | FR-D1 |
| `tests/test-compliance.test.mjs` | Tests for scanner + gate | FR-A1, FR-D1 |
| `tests/verify-kill.test.mjs` | Tests for kill-proof | FR-B1 |
| `tests/marker-utils.test.mjs` | Tests for anti-loop | FR-D7 |
| `tests/escape-log.test.mjs` | Tests for escape audit | FR-D8 |

## Изменённые файлы

| Файл | Изменение | FR |
|------|-----------|-----|
| `src/extension.mjs` | Добавить `/reviewer-kit:status` escapes + last-run + pending | FR-E5 |
| `agents/reviewer-kit.md` | Добавить `slop-test-hunter` в spawns allowlist | FR-C1 |
| `skills/reality-first-review/SKILL.md` | Добавить test-slop критерии (fixture-fake, dirty-tree, generic-scope) | FR-E1..E4, FR-E7 |
| `skills/multi-stage-review/SKILL.md` | Добавить test-quality lane в Stage 2 | FR-C1 |
| `templates/githooks/pre-commit` | Вызывать `scripts/test-compliance.mjs` до `run-review.mjs` (fail-fast, DEC-1) | FR-D1 |
| `AGENTS.md` | Документировать новые агенты и скиллы | — |
| `CHANGELOG.md` | Записать изменения | — |
