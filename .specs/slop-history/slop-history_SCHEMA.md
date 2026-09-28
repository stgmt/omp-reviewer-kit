# Slop Audit Dogfood History Schemas

## 1. slop-audit-run@1 Schema

Each line in `audit-reports/slop/runs.jsonl` must conform to `slop-audit-run@1`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SlopAuditRunEvent",
  "type": "object",
  "required": [
    "schema",
    "runId",
    "timestamp",
    "commitSha",
    "target",
    "focus",
    "verdict",
    "verdictReason",
    "counts",
    "verified",
    "rejected"
  ],
  "properties": {
    "schema": {
      "type": "string",
      "const": "slop-audit-run@1"
    },
    "runId": {
      "type": "string",
      "pattern": "^slop-[0-9a-fA-F-]+$"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "commitSha": {
      "type": "string",
      "pattern": "^[0-9a-fA-F]{7,40}$"
    },
    "target": {
      "type": "string"
    },
    "focus": {
      "type": "string",
      "enum": ["", "architecture", "specs", "tests", "plan"]
    },
    "verdict": {
      "type": "string",
      "enum": ["CLEAN", "BLOCKED", "ACCEPTABLE_WITH_NOTES", "ERROR"]
    },
    "verdictReason": {
      "type": "string"
    },
    "counts": {
      "type": "object",
      "required": ["p1", "p2", "p3", "rejected"],
      "properties": {
        "p1": { "type": "integer", "minimum": 0 },
        "p2": { "type": "integer", "minimum": 0 },
        "p3": { "type": "integer", "minimum": 0 },
        "rejected": { "type": "integer", "minimum": 0 }
      }
    },
    "verified": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["file", "line", "title", "category", "observation", "failureMechanism"],
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "string" },
          "title": { "type": "string" },
          "category": { "type": "string", "enum": ["P1", "P2", "P3"] },
          "observation": { "type": "string" },
          "failureMechanism": { "type": "string" },
          "nativeAlternative": { "type": "string" }
        }
      }
    },
    "rejected": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["file", "line", "claim", "rejectionReason", "rejectionCategory"],
        "properties": {
          "fingerprint": { "type": "string" },
          "file": { "type": "string" },
          "line": { "type": "string" },
          "claim": { "type": "string" },
          "rejectionReason": { "type": "string" },
          "rejectionCategory": {
            "type": "string",
            "enum": ["COUNTER_EXAMPLE_PROVEN", "NATIVE_ALTERNATIVE_ABSENT", "HALLUCINATION", "ACCEPTED_DESIGN_DECISION"]
          }
        }
      }
    }
  }
}
```

## 2. slop-memory@1 Schema

File `audit-reports/slop/memory.json` conforms to `slop-memory@1`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SlopMemoryIndex",
  "type": "object",
  "required": ["schema", "updatedAt", "files"],
  "properties": {
    "schema": {
      "type": "string",
      "const": "slop-memory@1"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    },
    "files": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["contentHash", "claim", "rejectionReason", "rejectionCategory"],
          "properties": {
            "contentHash": { "type": "string" },
            "line": { "type": "string" },
            "claim": { "type": "string" },
            "rejectionReason": { "type": "string" },
            "rejectionCategory": { "type": "string" },
            "status": { "type": "string", "enum": ["active", "stale", "exempted"] }
          }
        }
      }
    }
  }
}
```

## 3. review-audit-run@1 Schema

Each line in `audit-reports/review/runs.jsonl` conforms to `review-audit-run@1`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ReviewAuditRunEvent",
  "type": "object",
  "required": ["schema", "runId", "timestamp", "diff_hash", "verdict", "confirmed_findings", "confirmed_coverage_gaps", "decisions"],
  "properties": {
    "schema": {"type": "string", "const": "review-audit-run@1"},
    "runId": {"type": "string"},
    "timestamp": {"type": "string", "format": "date-time"},
    "diff_hash": {"type": "string"},
    "verdict": {"type": "string", "enum": ["PASS", "BLOCK"]},
    "confirmed_findings": {"type": "array"},
    "confirmed_coverage_gaps": {"type": "array"},
    "decisions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["candidate_id", "disposition", "reason"],
        "properties": {
          "candidate_id": {"type": "string"},
          "disposition": {"type": "string", "enum": ["confirmed", "rejected", "not_proven"]},
          "triage": {"type": "string"},
          "reason": {"type": "string"},
          "evidence": {"type": "array", "items": {"type": "string"}}
        }
      }
    }
  }
}
```

## 4. audit-memory@1 Schema (shared, supersedes slop-memory@1)

File `audit-reports/memory/memory.json` conforms to `audit-memory@1`. `slop-memory@1` remains as legacy read fallback.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AuditMemoryIndex",
  "type": "object",
  "required": ["schema", "updatedAt", "entries"],
  "properties": {
    "schema": {"type": "string", "const": "audit-memory@1"},
    "updatedAt": {"type": "string", "format": "date-time"},
    "entries": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fingerprint", "source", "file", "claim", "reason", "category", "contentHash", "status"],
        "properties": {
          "fingerprint": {"type": "string"},
          "source": {"type": "string", "enum": ["slop", "review"]},
          "file": {"type": "string"},
          "line_hint": {"type": "string"},
          "claim": {"type": "string"},
          "reason": {"type": "string"},
          "category": {"type": "string"},
          "contentHash": {"type": "string"},
          "status": {"type": "string", "enum": ["active", "stale", "exempted"]},
          "diff_hash": {"type": "string"},
          "provenance": {
            "type": "object",
            "required": ["runId", "artifactPath", "artifactSha"],
            "properties": {
              "runId": {"type": "string"},
              "artifactPath": {"type": "string"},
              "artifactSha": {"type": "string"}
            }
          },
          "grantedBy": {"type": "string"},
          "grantedAt": {"type": "string", "format": "date-time"},
          "updatedAt": {"type": "string", "format": "date-time"}
        }
      }
    }
  }
}
```

Entries lacking `provenance` MUST NOT auto-suppress (treated as informational); `exempted` status without `grantedBy` is invalid and degrades to `active` at read time.
