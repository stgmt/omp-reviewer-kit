# CHANGELOG — slop-v2

## [Unreleased]

### Added
- `slop-test-hunter` agent: test-quality defect specialist (weak assertion, fake-green, missing edge-case, untested branch, fixture-fake)
- `test-author` agent: authoring contract (drift-check → author → run → green → flip, NEVER flip first)
- `test-slop` skill: 9 anti-patterns, 12-point self-eval, 21 NEVER-rules, fixture-gate, dirty-tree rule, generic-scope verify, dogfood pattern
- `verify-kill.mjs`: deterministic kill-proof (inject→FAIL→restore→PASS)
- `test-compliance.mjs`: 9 anti-pattern scanner (regex, zero-dep)
- `marker-utils.mjs`: anti-loop markers (hash+cooldown+maxRetries)
- `escape-log.mjs`: escape-hatch audit (`[skip-X: reason≥8]` → JSONL)
- `test-compliance` hook: tool_call block on anti-pattern in test files
- `/reviewer-kit:status` extended: escapes + last-run + pending → 🟢/🟡

### Changed
- `reviewer-kit.md`: added `slop-test-hunter` to spawns allowlist
- `reality-first-review/SKILL.md`: added test-slop criteria
- `multi-stage-review/SKILL.md`: added test-quality lane in Stage 2

### Research
- `RESEARCH.md`: full dev-pomogator test/review machinery map (65KB, 462 lines)
- `FR.md`: 20 TAKE / 17 REJECT / 6 DEFER requirements
- `NFR.md`: 14 invariants
- `DESIGN.md`: implementation options per requirement
