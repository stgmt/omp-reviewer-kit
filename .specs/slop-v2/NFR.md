# NFR — slop-v2: нефункциональные требования (дистиллят RESEARCH.md)

> Инварианты, которые нельзя снижать при порте. Каждый — с источником и способом проверки.

## NFR1. Вердикт вычисляется, не заявляется

Любой «done»/«clean»/«strong» только от детерминистической проверки. Fail-closed при неработающей проверке: если детектор упал — вердикт BLOCK, не PASS.

- Источник: RESEARCH §1, §5.3, §11.3 (инвариант 1)
- Проверка: убить детектор (невалидный regex, missing file) → вердикт BLOCK, не PASS
- В dev-pomogator: `verified_status` DONE iff EVERY mapped scenario PASSED; `spec-verdict` — единственный авторитетный вердикт, не `validate-spec: 0 errors`

## NFR2. Тест обязан уметь падать

Mutation gutcheck (break→RED→restore→GREEN) — единственное доказательство силы. Coverage % не доказательство. Тест, который PASS на good AND broken — FAKE-POSITIVE-RISK.

- Источник: RESEARCH §3.1 §8, §3.4, §11.3 (инвариант 2)
- Проверка: `verify-kill.mjs` на каждом новом детекторе; evals `{good, broken}` — STRONG iff PASS good AND FAIL broken
- В dev-pomogator: stryker-агрегат недетерминирован (32/40/67/70 на 4 прогонах) → verify-kill — единственный детерминистический kill-proof

## NFR3. Канонический лог прогона один

Filtered/partial run никогда не пишет в канонический файл. Clobber-protection: filtered → throwaway ndjson; host → exit 1.

- Источник: RESEARCH §5.2, §8.3, §11.3 (инвариант 3)
- Проверка: запустить filtered run → канонический `.last-test-run.ndjson` не изменился
- В dev-pomogator: `run-bdd.mjs` — filtered → throwaway, host → exit 1; `docker-bdd.sh` — per-run ndjson → canonical copy

## NFR4. Anti-loop на каждом блокирующем гейте

Hash+cooldown+maxRetries+noProgressStreak+awaitingAsync. Без этого гейт — оружие против пользователя.

- Источник: RESEARCH §4.2, §11.3 (инвариант 4)
- Проверка: 3 одинаковых блока подряд → гейт пропускает с warning, не бесконечный loop
- В dev-pomogator: `.compliance-marker.json` (cooldown 30m, retries 1), `.dedup-marker.json` (cooldown 10m), `.claim-evidence-gate-marker.json` (hash+cooldown+maxRetries+noProgressStreak+awaitingAsync)

## NFR5. Escape всегда audited, never silent

`[skip-X: reason≥8]` → JSONL. Reason <8 chars → warning. Логи читаются stumble-отчётом.

- Источник: RESEARCH §4.2, §9, §11.3 (инвариант 5)
- Проверка: escape с reason "x" → warning; escape с reason "legitimate reason" → logged, no warning
- В dev-pomogator: `*-escapes.jsonl` для каждого гейта; `observability-review` — единый stumble-отчёт

## NFR6. Drift-check перед авторингом

Не писать дубликат того, что уже покрыто. Cite > author. Перед созданием теста/детектора — проверить, нет ли уже покрывающего.

- Источник: RESEARCH §6, §11.3 (инвариант 6)
- Проверка: test-author на уже покрытом сценарии → cite + STOP, не создаёт дубликат
- В dev-pomogator: test-author step 2 — drift-check (уже покрыто → cite, STOP)

## NFR7. Emit-only vs block

Advisory-сигналы (JIT, LLM-judge, conformance-push) никогда не блокируют. Блок только детерминистические проверки.

- Источник: RESEARCH §4.2, §11.3 (инвариант 7)
- Проверка: LLM-judge недоступен → emit-only, не block; compliance_check regex match → block
- В dev-pomogator: `posttool-jit` — emit-only additionalContext; `bdd-quality-judge` — advisory; `spec-conformance-push` — emit-only `<system-reminder>`; `compliance_check` — block

## NFR8. Real code, no mocks

Step-def/тест вызывает реальный модуль. Parallel-impl и tautology = дефект. Фикстура из реального producer или точный envelope.

- Источник: RESEARCH §6, §7, §11.3 (инвариант 8)
- Проверка: тест с mock вместо реального модуля → детектор flag; фикстура с полем, которого producer не эмитит → flag
- В dev-pomogator: test-author NEVER copy prod logic; `real-fixtures` — ни одного поля, которого producer не эмитит; `dead-integration-guard` — installed ≠ integrated

## NFR9. Zero npm dependencies

Только node builtins. Любая внешняя зависимость — отдельное обоснование.

- Источник: RESEARCH §11.2, AGENTS.md (zero external runtime dependencies)
- Проверка: `npm ls` — 0 dependencies; `node --test` работает без `npm install`

## NFR10. Fail-closed на инфраструктурных ошибках

Provider quota, rate-limit, auth, model-capacity → deterministic fallback chain → BLOCK с actionable сообщением, не PASS.

- Источник: AGENTS.md (fallback chain @smol → @task, probe before attempt)
- Проверка: убить все модели → BLOCK с сообщением «models attempted, how to repoint modelRoles»

## NFR11. Детерминизм

Одинаковый вход → одинаковый выход. Нет random, нет timestamp-dependent логики в вердиктах.

- Источник: RESEARCH §3.4 (stryker-агрегат недетерминирован — антипример), §11.3
- Проверка: 3 прогона на одном diff → идентичный вердикт

## NFR12. Windows-совместимость

CRLF, backslash paths, jscpd `/tmp` ловушки, `npx tsx` spawn-ловушки — учтены.

- Источник: RESEARCH §11.5
- Проверка: `node --test` на Windows; пути с `\` и `/` работают; `.feature` с CRLF парсится

## NFR13. Производительность

Compliance-гейт <100ms на файл. Verify-kill <5s на мутацию. Review <5min на типичный diff.

- Источник: RESEARCH §4.2 (compliance_check — regex, быстрый), §3.4 (verify-kill — один прогон)
- Проверка: benchmark на 1000-строчном тест-файле

## NFR14. Аудируемость

Каждое решение (TAKE/REJECT/DEFER) имеет источник в RESEARCH.md и файл в dev-pomogator. Нет «потому что так лучше».

- Источник: RESEARCH §0 (каждое утверждение привязано к файлу-источнику)
- Проверка: каждый FR/NFR имеет `Источник:` с файлом и секцией
