@feature1
Feature: slop-v2 test-review machinery port

  @feature1 @id:SCEN-slop-v2-001
  Scenario: compliance-gate blocks weak assertion
    Given a staged test file with "expect(x).toBeDefined()"
    When the developer commits and the pre-commit gate scans staged tests
    Then the commit is rejected with reason "weak-assertion" and review never starts

  @feature1 @id:SCEN-slop-v2-002
  Scenario: compliance-gate passes clean test
    Given a staged test file with "expect(result).toEqual({id: 1})"
    When the pre-commit gate scans staged tests
    Then the gate exits 0 and the commit proceeds to review

  @feature1 @id:SCEN-slop-v2-003
  Scenario: anti-loop prevents infinite block
    Given the compliance-gate rejected 3 commits with same hash
    When the developer makes a 4th commit without changes
    Then the gate passes with warning "anti-loop cooldown"

  @feature1 @id:SCEN-slop-v2-004
  Scenario: escape-hatch is audited
    Given a staged test file with "// test-compliance:skip legitimate reason"
    When the pre-commit gate scans at commit
    Then the escape is logged to escapes.jsonl

  @feature1 @id:SCEN-slop-v2-005
  Scenario: verify-kill proves test catches bug
    Given a passing test
    When verify-kill injects a mutation
    Then the test fails, restore, re-run passes, exit 0

  @feature1 @id:SCEN-slop-v2-006
  Scenario: verify-kill detects fake-positive
    Given a passing test
    When verify-kill injects a mutation
    Then the test passes, exit 1 (SURVIVED)

  @feature1 @id:SCEN-slop-v2-007
  Scenario: test-hunter finds weak assertion in diff
    Given staged diff with "expect(res.ok).toBe(true)"
    When slop-test-hunter analyzes
    Then candidate "response-ok-only" is emitted

  @feature1 @id:SCEN-slop-v2-008
  Scenario: test-author does drift-check
    Given a scenario already covered by existing test
    When test-author receives the task
    Then it cites existing test and stops

  @feature1 @id:SCEN-slop-v2-009
  Scenario: test-author never flips pre-green
    Given test-author wrote a test but did not run it
    When it tries to mark done
    Then the contract blocks "NEVER flip pre-green"

  @feature1 @id:SCEN-slop-v2-010
  Scenario: stumble-report shows escapes
    Given 3 escape entries in escapes.jsonl
    When /reviewer-kit:status is called
    Then output shows "3 escapes in 24h"
