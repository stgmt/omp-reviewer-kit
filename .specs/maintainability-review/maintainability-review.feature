# language: en
Feature: Maintainability review of repeated parameter groups
  # Planning contract only. These scenarios are not implemented tests.

  Scenario: Groups are computed deterministically over the staged snapshot
    Given a staged change touching three supported files
    When the review starts
    Then the analyzer reads only staged snapshot paths and never the working tree
    And it writes maintainability.json with a diff hash
    And no model inference is used to count occurrences or groups

  Scenario: Empty result is distinguished from unknown result
    Given a staged change touching executable files of an unsupported language
    When the analyzer cannot parse any supported file
    Then the analysis status is unsupported
    And the report names the files and languages left unchecked
    And the report does not claim that no candidates exist

  Scenario: Unparsed files are recorded without stopping the commit
    Given a staged change where one TypeScript file uses syntax the parser does not accept
    When the analyzer runs
    Then that file is listed as unparsed with its path and reason
    And the analysis status is not failed and not no-candidates
    And the coverage is partial
    And the commit is not blocked because of that file

  Scenario: Only maximal groups are reported
    Given group A is a subset of group B with support not lower than A
    When the analyzer reports groups
    Then only group B is reported
    And the configured support threshold and minimum size appear in the report

  Scenario: Test code does not create candidates
    Given the same parameter group appears in a test file and in two source files
    When the analyzer counts support
    Then the test file does not raise the support count
    And the exclusion is listed with its path and ground

  Scenario: Maintainability stage runs only with candidates
    Given the analysis produced no groups above the threshold
    When the review runs
    Then the maintainability agent is not started
    And the report states why the stage was not planned

  Scenario: Plan, actions and reflection are observable
    Given the analysis produced five candidate groups
    When the maintainability agent analyzes a candidate
    Then its result contains planned checks with confirm and refute conditions
    And it contains the file and line ranges it read
    And it contains a counterargument with path and line evidence
    And a confirmed decision cites the evidence it read

  Scenario: Budget exhaustion is reported honestly
    Given the analysis produced twenty candidate groups
    When the agent reaches its analysis budget
    Then at most the configured number of candidates is analyzed
    And the remaining candidates are marked not_proven with reason budget

  Scenario: Advisory mode keeps the verdict unchanged
    Given the policy is explicitly set to advisory
    And the agent confirmed one maintainability candidate
    And no other finding exists
    When the review finishes
    Then the confirmed item appears under Maintainability
    And it is mirrored into Notes
    And the verdict stays PASS

  Scenario: Default policy blocks only with a proven cost
    Given the policy variable is not set
    When the agent confirms a candidate that names a coordinated change and its affected sites
    Then the verdict is BLOCK with priority P2
    And when a confirmed candidate names no such cost
    Then that candidate does not change the verdict

  Scenario: Blocking requires a proven maintenance cost
    Given the policy is block
    And a confirmed candidate states no coordinated change or affected sites
    When the review finishes
    Then the commit is not blocked by that candidate

  Scenario: Infrastructure failure fails closed
    Given the maintainability stage was planned
    When the stage fails, times out or returns an invalid shape
    Then the verdict is BLOCK
    And the report names the maintainability stage

  Scenario: Explicit opt-out is recorded
    Given the policy is off
    When the review runs
    Then the analysis and the agent stage are skipped
    And the report states that maintainability review was disabled

  Scenario: Model ownership stays with OMP
    Given the maintainability agent definition
    Then it declares the task model role and no explicit model
    And it has read-only tools only
    And it cannot spawn further agents

  Scenario: Existing verdict contract is unchanged
    Given confirmed maintainability items exist
    When the verdict is computed
    Then those items are not part of confirmed findings or confirmed coverage gaps
    And the existing PASS requirements still decide the result

  Scenario: Support is counted over the whole staged snapshot
    Given a parameter group appears at sixteen sites and the change touches two of them
    When the analyzer counts support
    Then support is sixteen and the staged touch count is two
    And the group is reported even though fewer than the threshold sites are in the change

  Scenario: A truncated scan is reported as a lower bound
    Given the snapshot exceeds the configured file or time limit
    When the analyzer stops early
    Then the scan is marked truncated and support is printed as a lower bound
    And the report prints how many files were read and skipped

  Scenario: A missing planned stage blocks the commit
    Given the analysis produced candidates and the stage was planned
    When the stage produces no completed result
    Then the verdict is BLOCK even when the report claims success
