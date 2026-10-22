Feature: Review uses OMP native task and owner task policy end to end
  # Planning contract only. These scenarios are not yet implemented tests.

  Scenario: No model-powered gate before reviewer task
    Given a non-empty staged snapshot and a supported native task entrypoint
    When the pre-commit hook starts the review
    Then the adapter directly invokes native task with agent reviewer-kit
    And it supplies no model or effort override
    And no kit preflight or dispatcher provider request occurs before that task
    And the owner task role is resolved by OMP

  Scenario: Initial auto primary does not skip configured Luna
    Given the task primary is longcat:auto
    And the task fallback list is Luna:xhigh, router, Luna:medium, longcat, Haiku:medium, cat-jam
    And the initial runtime selector is bare longcat
    And longcat fails with HTTP 401
    And Luna:xhigh is eligible and returns a valid native response
    When OMP recovers the native task request
    Then its first eligible fallback request is Luna:xhigh
    And kit has neither reordered the list nor implemented a provider walk
    And the role provenance still identifies task

  Scenario: Completed report is recovered without another model
    Given a completed native reviewer task with all required stages
    And its transport output is truncated
    When kit reads the result
    Then it reads the matching native artifact deterministically
    And it does not invoke a model to re-emit the report

  Scenario: Unsupported native entrypoint has no hidden fallback
    Given OMP lacks the approved direct native task capability
    When the hook checks the local runtime
    Then it blocks with a specific unsupported-capability diagnostic
    And no provider request is sent
    And the old model dispatcher is not launched

  Scenario: Existing review rejection remains blocking
    Given native verifier confirms a finding or a harness-coverable coverage gap
    When native reviewer-kit synthesizes the report
    Then the commit is blocked
    And the adapter cannot override the result with PASS

  Scenario: User configuration remains unchanged
    Given owner task roles, fallback chains and agent overrides
    When a native review completes or fails
    Then owner settings and credential stores remain unchanged
    And kit has not generated a model-chain overlay for default
