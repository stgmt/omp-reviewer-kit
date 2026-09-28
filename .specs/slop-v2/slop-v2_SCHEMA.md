# slop-v2 Schema

## Entities

| Entity | Kind | Description |
|--------|------|-------------|
| FR-A1..A6 | FR | Test quality detectors |
| FR-B1, FR-B2 | FR | Mutation kill-proof |
| FR-C1, FR-C2 | FR | Agents |
| FR-D1, FR-D7, FR-D8 | FR | Gates and hooks |
| FR-E1..E7 | FR | Rules and procedures |
| NFR1..NFR14 | NFR | Non-functional invariants |
| SCEN-slop-v2-001..010 | Scenario | BDD acceptance scenarios |

## Edges

- FR-A1 → SCEN-slop-v2-001, SCEN-slop-v2-002 (compliance-gate block/pass)
- FR-D7 → SCEN-slop-v2-003 (anti-loop)
- FR-D8 → SCEN-slop-v2-004 (escape-audit)
- FR-B1 → SCEN-slop-v2-005, SCEN-slop-v2-006 (verify-kill)
- FR-C1 → SCEN-slop-v2-007 (test-hunter)
- FR-C2 → SCEN-slop-v2-008, SCEN-slop-v2-009 (test-author)
- FR-E5 → SCEN-slop-v2-010 (stumble-report)
