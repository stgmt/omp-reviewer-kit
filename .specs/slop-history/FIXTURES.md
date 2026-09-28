# Slop Audit Dogfood History: Fixtures

## Sample Markdown Snapshot

File: `audit-reports/slop/2026-09-21T14-30-00Z-src_domain.md`

```markdown
VERDICT: CLEAN — No critical slop detected

### 🔴 P1: Блокеры (0)
Отсутствуют.

### 🟡 P2: Паразитная архитектура и нейрослоп (0)
Отсутствуют.

### 🟢 P3: Дрифт документации и мелкие замечания (0)
Отсутствуют.

*(Отсеяно ревьюерских мнений и ложных срабатываний: 1)*
```

## Sample JSONL Record (`slop-audit-run@1`)

File: `audit-reports/slop/runs.jsonl`

```json
{"schema":"slop-audit-run@1","runId":"slop-1789701526662-a1b2","timestamp":"2026-09-21T14:30:00.000Z","commitSha":"2ff0ce9123456789abcdef0123456789abcdef01","target":"src/domain","focus":"architecture","verdict":"CLEAN","verdictReason":"No critical slop detected","counts":{"p1":0,"p2":0,"p3":0,"rejected":1},"verified":[],"rejected":[{"fingerprint":"c4d5e6f7","file":"tests/calc.test.mjs","line":"4","claim":"Vacuous check","rejectionReason":"Proven alive: mutating add() fails line 12","rejectionCategory":"COUNTER_EXAMPLE_PROVEN"}]}
```

## Sample Memory Index (`slop-memory@1`)

File: `audit-reports/slop/memory.json`

```json
{
  "schema": "slop-memory@1",
  "updatedAt": "2026-09-21T14:30:00.000Z",
  "files": {
    "tests/calc.test.mjs": [
      {
        "contentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "line": "4",
        "claim": "Vacuous check cannot turn red",
        "rejectionReason": "Proven alive: mutating add() to return a-b breaks assertion at line 12",
        "rejectionCategory": "COUNTER_EXAMPLE_PROVEN",
        "status": "active"
      }
    ]
  }
}
```

## Sample Review JSONL Record (`review-audit-run@1`)

File: `audit-reports/review/runs.jsonl`

```json
{"schema":"review-audit-run@1","runId":"review-1789701526663-b7c1","timestamp":"2026-09-21T15:00:00.000Z","diff_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","verdict":"BLOCK","confirmed_findings":[],"confirmed_coverage_gaps":[],"decisions":[{"candidate_id":"correctness-1","disposition":"rejected","triage":"not_applicable","reason":"Upstream caller sanitizes input before touched line","evidence":["src/app.mjs:42"]}]}
```

## Sample Shared Memory Entry (`audit-memory@1`)

File: `audit-reports/memory/memory.json`

```json
{"schema":"audit-memory@1","updatedAt":"2026-09-21T15:00:00.000Z","entries":[{"fingerprint":"a1b2c3d4","source":"review","file":"src/app.mjs","line_hint":"44-48","claim":"Missing null guard","reason":"Caller guarantees non-null via constructor invariant","category":"COUNTER_EXAMPLE_PROVEN","contentHash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","status":"active"}]}
```
