# M11: Safety Hardening & Observability

Milestone 11 introduces circuit breakers, token budget enforcement, and per-request
diagnostic capture to prevent runaway token consumption and surface policy events
for admin review.

## P0 Fix: Artifact Tool Injection in Claude Path

The `synesis_artifact_retrieve` tool was injected into Claude's tool list but the
auto-resolve loop only existed for the OpenAI non-streaming path. Claude Code users
experienced tool-call loops because the model would call the injected tool and the
response was forwarded directly to the client (which had no handler for it).

**Resolution:** Artifact tool injection is now disabled for the Claude path entirely.
The feature flag `SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED` defaults to `false` and
only gates the OpenAI path. Claude streaming and non-streaming responses additionally
filter out any `synesis_artifact_retrieve` tool calls as a safety net.
`BASE_INSTRUCTIONS` no longer mentions the artifact tool.

## Policy Engine Hardening

The `DeterministicPolicyEngine` now enforces three circuit-breaker rules in addition
to the existing `patch-first` and `repeat-loop-pivot` policies:

| Rule | Trigger | Action |
|------|---------|--------|
| Session token budget | `totalTokensIn > SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS` | Hard reject 400 |
| Consecutive tool calls | `consecutiveToolCalls >= SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT` | Hard reject 400 |
| Repeat hard reject | Identical request pattern repeated N times (`SYNESIS_YARN_POLICY_HARD_REJECT_AFTER`) | Hard reject 400 |

The repeat-loop-pivot rule now warns the model of remaining attempts before the
hard limit activates.

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `SYNESIS_YARN_POLICY_HARD_REJECT_AFTER` | 6 | Identical pattern repeats before hard reject |
| `SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS` | 500,000 | Per-session cumulative input token budget |
| `SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT` | 8 | Consecutive tool_call responses without user turn |

### M10 Feature Flags

Each M10 enhancement has an independent kill-switch for bisecting regressions:

| Flag | Default | Feature |
|------|---------|---------|
| `SYNESIS_YARN_STABLE_PREFIX_ENABLED` | true | E2: Stable prefix partitioning |
| `SYNESIS_YARN_JSON_COMPACTION_ENABLED` | true | E3: JSON array compaction |
| `SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED` | true | E4: Attention-aware positioning |
| `SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED` | false | E5: Artifact retrieval tool injection |
| `SYNESIS_YARN_SESSION_CONTINUITY_ENABLED` | true | E6: Cross-session continuity |
| `SYNESIS_YARN_CONTENT_DISPATCH_ENABLED` | true | E8: Content-type dispatch |

## Observability

### Structured Logging

Policy safety events are logged at `warn` level with structured fields:

```json
{
  "safetyEvent": "hard_reject_budget",
  "sessionKey": "user-abc",
  "detail": "Session exceeded 500,000 input token budget (used: 600,000)",
  "tokensBurned": 600000
}
```

### Request Diagnostics

`GET /v1/diagnostics/recent` returns the last 20 request diagnostics:

```json
{
  "diagnostics": [
    {
      "timestamp": 1711400000000,
      "sessionKey": "user-abc",
      "path": "/v1/messages (stream)",
      "systemMessageCount": 3,
      "userMessageCount": 5,
      "toolMessageCount": 4,
      "totalInputChars": 28000,
      "toolDefinitionCount": 22,
      "artifactToolInjected": false,
      "reducedToolResults": 3,
      "finishReason": "tool_use",
      "tokensIn": 8200,
      "tokensOut": 450,
      "policyDecision": "allow",
      "latencyMs": 2400
    }
  ]
}
```

### Admin Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/yarn/safety-events` | Paginated safety event log |
| `GET /api/v1/yarn/safety-summary` | Aggregate counts by event kind |
| `GET /api/v1/yarn/diagnostics/recent` | Proxy to Yarn diagnostics ring buffer |

### Database Table

`yarn_safety_events` stores persisted policy events for historical analysis:

- `session_key`, `user_id`, `org_id` for scoping
- `event_kind`: `pivot_injected`, `hard_reject_repeats`, `hard_reject_budget`, `hard_reject_tool_loop`, `patch_first_reject`
- `detail`: Human-readable event description
- `repeat_count`, `tokens_burned`, `consecutive_tool_calls`: Numeric context

### Telemetry

`GET /health/telemetry` now includes:

- `featureFlags`: Current state of all M10 feature flags
- `safetyLimits`: Configured safety thresholds
- `deterministicPolicy.recentEvents`: Last 50 in-memory policy events
