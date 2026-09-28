# Slop v2 — dev-pomogator test-review machinery port

Status: DRAFT

## Backlog — [REJECT] FR-B3: Полный mutation-конвейер (stryker/mutmut/pit/stryker-net/cargo-mutants/go-mutating + конфиги + Docker) — инфра dev-pomog

- **Status:** done
- **Done When:** Register REJECT item FR-B3 as backlog task

## Backlog — [DEFER] FR-B4: LLM survivor analysis (batch-prompt → Agent() → merge-verdicts) — через OMP agent()/completion(), не внешние API

- **Status:** deferred
- **Done When:** Register DEFER item FR-B4 as backlog task

## Backlog — [REJECT] FR-C3: bdd-migrator конвейер — нет BDD-корпуса в целевом репо

- **Status:** done
- **Done When:** Register REJECT item FR-C3 as backlog task

## Backlog — [REJECT] FR-C4: spec-phase-* агенты (discovery/requirements/audit/finalization) — нет spec-системы

- **Status:** done
- **Done When:** Register REJECT item FR-C4 as backlog task

## Backlog — [REJECT] FR-D2: BDD-only-guard (deny non-BDD тестов) — нет BDD-политики; тесты node:test

- **Status:** done
- **Done When:** Register REJECT item FR-D2 as backlog task

## Backlog — [DEFER] FR-D3: Test-guard (deny прямых test-команд → wrapper hint) — нужен аналог test_runner_wrapper; OMP hub processes

- **Status:** deferred
- **Done When:** Register DEFER item FR-D3 as backlog task

## Backlog — [REJECT] FR-D4: Test-spec-gate (tests/ без spec/.feature → block) — нет spec-привязки тестов

- **Status:** done
- **Done When:** Register REJECT item FR-D4 as backlog task

## Backlog — [DEFER] FR-D5: Test-quality-gate (DONE без STRONG → block) — зависит от spec-графа; концепция verdict-computed переносится в review syn

- **Status:** deferred
- **Done When:** Register DEFER item FR-D5 as backlog task

## Backlog — [REJECT] FR-D6: Claim-evidence-gate как Stop-хук — OMP session_stop не pre-display gate; идея claims→evidence перенесена в verifier (FR-

- **Status:** done
- **Done When:** Register REJECT item FR-D6 as backlog task

## Backlog — [REJECT] FR-F1: hook-service HTTP-демон — OMP extension API даёт tool_call hooks нативно

- **Status:** done
- **Done When:** Register REJECT item FR-F1 as backlog task

## Backlog — [REJECT] FR-F2: tui-test-runner + statusline + TUI — Claude-специфичный UX; OMP hub processes

- **Status:** done
- **Done When:** Register REJECT item FR-F2 as backlog task

## Backlog — [REJECT] FR-F3: Docker-стенд (Dockerfile.test.base, compose, WSL) — инфра dev-pomogator

- **Status:** done
- **Done When:** Register REJECT item FR-F3 as backlog task

## Backlog — [REJECT] FR-F4: Spec-граф + MCP-дверь (46 модулей, 46 инструментов) — отдельная фича; концепция verdict-computed-not-claimed перенесена

- **Status:** done
- **Done When:** Register REJECT item FR-F4 as backlog task

## Backlog — [REJECT] FR-F5: spec-access/phase/form/extension-json-meta guards — защита их spec-MCP

- **Status:** done
- **Done When:** Register REJECT item FR-F5 as backlog task

## Backlog — [REJECT] FR-F6: Cucumber/BDD-корпус (40 wired .feature, 186 step-defs) — нет BDD в целевом репо

- **Status:** done
- **Done When:** Register REJECT item FR-F6 as backlog task

## Backlog — [REJECT] FR-F7: CI workflows (test.yml, session-pilot.yml, release.yml) — у reviewer-kit свой CI

- **Status:** done
- **Done When:** Register REJECT item FR-F7 as backlog task

## Backlog — [DEFER] FR-F8: Evals-инфраструктура (iterations/, bench, bulk-run) — паттерн {good,broken} взят в FR-A6

- **Status:** deferred
- **Done When:** Register DEFER item FR-F8 as backlog task

## Backlog — [REJECT] FR-F9: session-pilot (dashboard, autostart, Pilot API) — worktree dashboard, не тестовая машинерия

- **Status:** done
- **Done When:** Register REJECT item FR-F9 as backlog task

## Backlog — [DEFER] FR-F10: LLM-судьи (bdd-quality-judge, meridian-judge, spec-llm-judge) — через OMP agent()/completion()

- **Status:** deferred
- **Done When:** Register DEFER item FR-F10 as backlog task

## Backlog — [REJECT] FR-F11: spec-backlog (auto-ingest, session-summary) — часть spec-системы

- **Status:** done
- **Done When:** Register REJECT item FR-F11 as backlog task

## Backlog — [REJECT] FR-F12: research-workflow-marker-guard — маркеры их скилла

- **Status:** done
- **Done When:** Register REJECT item FR-F12 as backlog task

## Backlog — [REJECT] FR-F13: anchor-integrity (anchor_gate_stop, anchor_check_post) — link-anchors их spec-системы

- **Status:** done
- **Done When:** Register REJECT item FR-F13 as backlog task

## Backlog — [DEFER] FR-F14: out-session-advisor/verify_claims (claim→fact deterministic verifier) — полезно для verifier'а, отдельная работа

- **Status:** deferred
- **Done When:** Register DEFER item FR-F14 as backlog task

## Phase — Wave 1

Одна волна: все 20 TAKE (DEC-5). Порядок: сканер → гейт → инварианты → агенты → скиллы → отчёт → фикстуры/проверка.

## TASK-1: сканер антипаттернов test-compliance

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-001, SCEN-slop-v2-002
- **Done When:** `src/infra/test-compliance.mjs` находит 9 антипаттернов (FR-A1) на фикстурах; `tests/test-compliance.test.mjs` зелёный; каждый детектор доказан kill-proof через TASK-5.

## TASK-2: pre-commit gate (D1c)

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-001, SCEN-slop-v2-002, UC-1
**Depends On:** TASK-1
- **Done When:** `scripts/test-compliance.mjs` сканирует staged тест-файлы и возвращает exit 1 с причиной на антипаттерне; `templates/githooks/pre-commit` вызывает гейт до `run-review.mjs`; self-hosted `.githooks/pre-commit` обновлён; плохой staged тест блокирует коммит, чистый — проходит (UC-1).

## TASK-3: anti-loop маркеры

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-003, US-4
- **Done When:** `src/infra/marker-utils.mjs` (hash+cooldown+maxRetries); гейт после 3 одинаковых блоков пропускает с warning; `tests/marker-utils.test.mjs` зелёный.

## TASK-4: escape-hatch аудит

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-004, UC-4, US-5
- **Done When:** `src/infra/escape-log.mjs`; `[skip-X: reason≥8]` в staged тесте пишется в `audit-reports/escapes.jsonl`; reason <8 символов даёт warning; `tests/escape-log.test.mjs` зелёный (UC-4).

## TASK-5: verify-kill.mjs

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-005, SCEN-slop-v2-006, UC-3
**Depends On:** TASK-1
- **Done When:** `scripts/verify-kill.mjs` делает inject→FAIL→restore→PASS (KILLED, exit 0) и детектит SURVIVED (exit 1); `tests/verify-kill.test.mjs` зелёный; все детекторы TASK-1 прогнаны через verify-kill (UC-3).

## TASK-6: slop-test-hunter агент

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-007, UC-2, US-2
**Depends On:** TASK-8
- **Done When:** `agents/slop-test-hunter.md` (model @slow, lane test-quality); `agents/reviewer-kit.md` spawns-allowlist расширен; `skills/multi-stage-review/SKILL.md` Stage 2 включает test-quality lane; hunter находит response-ok-only в staged diff (UC-2).

## TASK-7: test-author агент

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-008, SCEN-slop-v2-009, UC-5, US-3
**Depends On:** TASK-8
- **Done When:** `agents/test-author.md` с контрактом drift-check → author → run → green → flip и NEVER flip first; дубликат сценария даёт cite+STOP; done без прогона блокируется (UC-5).

## TASK-8: test-slop skill

- **Status:** todo
- **Phase:** Wave 1
**Refs:** US-2, US-6
- **Done When:** `skills/test-slop/SKILL.md`: 9 антипаттернов, 12-point self-eval, NEVER-правила, fixture-gate, dirty-tree правило, generic-scope verify, dogfood-процедура (FR-A2..A6, FR-E1..E4, FR-E6, FR-E7).

## TASK-9: stumble-отчёт в reviewer-kit status

- **Status:** todo
- **Phase:** Wave 1
**Refs:** SCEN-slop-v2-010, US-5
**Depends On:** TASK-4
- **Done When:** `src/extension.mjs` status показывает escapes за 24h + last-run + pending → зелёный/жёлтый индикатор; 3 записи в escapes.jsonl видны в выводе.

## TASK-10: фикстуры, доки, финальная проверка

- **Status:** todo
- **Phase:** Wave 1
**Refs:** US-6
**Depends On:** TASK-1, TASK-2, TASK-3, TASK-4, TASK-5, TASK-6, TASK-7, TASK-8, TASK-9
- **Done When:** фикстуры из FIXTURES.md на месте; `AGENTS.md` документирует новых агентов/скиллы; `CHANGELOG.md` обновлён; `npm test`, `npm run test:mutation`, `npm run check` зелёные.
