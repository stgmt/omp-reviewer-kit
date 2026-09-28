Feature: Slop Audit Dogfood History

  Background:
    Given a clean git repository initialized with OMP Review Kit

  @id:SCEN-slop-history-001
  Scenario: CLI audit creates markdown snapshot and appends JSONL event on clean target
    When the user executes "node scripts/audit-slop.mjs src/domain"
    Then the exit code should be 0
    And stdout should contain "VERDICT: CLEAN"
    And a markdown file matching "audit-reports/slop/*-src_domain.md" should exist
    And the first line of the markdown file should match "VERDICT: CLEAN"
    And "audit-reports/slop/runs.jsonl" should contain a record with verdict "CLEAN"

  @id:SCEN-slop-history-002
  Scenario: CLI audit records blocked verdict with verified P1 blocker
    Given a test file with a vacuous assertion that cannot turn red
    When the user executes "node scripts/audit-slop.mjs tests"
    Then the exit code should be 1
    And stdout should contain "VERDICT: BLOCKED"
    And a markdown file matching "audit-reports/slop/*-tests.md" should exist
    And the markdown file should contain "P1: Блокеры"
    And "audit-reports/slop/runs.jsonl" should contain a record with verdict "BLOCKED"

  @id:SCEN-slop-history-003
  Scenario: Interactive slash command slop records audit history automatically
    When the user invokes "/slop src/domain" in an interactive session
    Then the audit completes with a verdict
    And a markdown snapshot is saved under "audit-reports/slop/"
    And "audit-reports/slop/runs.jsonl" is appended with the audit run event

  @id:SCEN-slop-history-004
  Scenario: CLI audit with no-save flag suppresses file generation
    When the user executes "node scripts/audit-slop.mjs src/domain --no-save"
    Then the exit code should be 0
    And no new file should be created in "audit-reports/slop/"

  @id:SCEN-slop-history-005
  Scenario: Fail-safe persistence handles storage write failure without masking verdict
    Given the audit reports directory is read-only
    When the user executes "node scripts/audit-slop.mjs" on a blocked target
    Then a storage warning should be emitted to stderr
    And the exit code should still be 1

  @id:SCEN-slop-history-006
  Scenario: Verifier outputs structured rejection details in audit telemetry
    When an audit candidate is rejected by the verifier with a counter-example
    Then "audit-reports/slop/runs.jsonl" records the rejection reason and category
    And the rejection category is recorded as "COUNTER_EXAMPLE_PROVEN"

  @id:SCEN-slop-history-007
  Scenario: Scout suppresses candidate previously recorded as rejected in memory index
    Given a candidate was previously rejected and recorded in "audit-reports/slop/memory.json"
    When a subsequent audit is run on the same unchanged code
    Then the audit completes without re-raising the suppressed hypothesis
    And the verifier does not spend redundant tool calls re-evaluating it

  @id:SCEN-slop-history-008
  Scenario: Code mutation invalidates historical suppression and allows fresh audit
    Given a candidate was previously rejected in "audit-reports/slop/memory.json"
    When the code at the cited file and line is modified
    Then the memory index marks the historical suppression as stale
    And the modified code is audited afresh without suppression

  @id:SCEN-slop-history-009
  Scenario: Review run writes structured rejected decisions to tracked history
    When a staged change is reviewed and a candidate is rejected with repository evidence
    Then "audit-reports/review/runs.jsonl" appends one record with schema "review-audit-run@1"
    And the record contains the rejected decision with reason and triage
    And a Markdown snapshot is written under "audit-reports/review/"

  @id:SCEN-slop-history-010
  Scenario: Review suppresses previously refuted hypothesis from shared memory
    Given shared memory holds an active suppression for the changed file
    When the same staged hypothesis is re-raised without new code evidence
    Then the scout does not re-emit it and the verifier fast-rejects by precedent citation

  @id:SCEN-slop-history-011
  Scenario: Cross-tool precedent is shared between slop and review
    Given a slop rejection is recorded in shared memory for a code snippet
    When the same snippet is staged for review without modification
    Then the review pipeline respects the slop precedent and does not re-raise it

  @id:SCEN-slop-history-012
  Scenario: Forged memory entry cannot suppress a staged defect
    Given shared memory contains a schema-valid entry lacking provenance for the changed file
    When the staged change re-raises the suppressed claim with new code evidence
    Then the entry is ignored as untrusted and the candidate is evaluated normally
    And the dispatcher logs the untrusted entry

  @id:SCEN-slop-history-013
  Scenario: Memory file staged in the diff disables suppression for that review
    Given the staged diff includes changes under "audit-reports/memory/"
    When the review runs
    Then no memory entries suppress any candidate in that review

  @id:SCEN-slop-history-014
  Scenario: Exempted status requires operator grant
    Given a memory entry with status "exempted" but no "grantedBy" field
    When the suppression index is read
    Then the entry is treated as "active" and its exemption is ignored
