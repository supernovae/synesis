# Planner-TS Memory Lifecycle

This document describes how `planner-ts` manages conversation memory (L1/L2 session state), how it integrates with Redis for persistence, and how frontends like Open WebUI can purge memory when a chat is deleted.

## Architecture

```
┌──────────────┐       ┌──────────────────────┐       ┌─────────┐
│  Open WebUI  │──────▶│    planner-ts API     │──────▶│  Redis   │
│  (frontend)  │       │  /v1/chat/completions │       │  (L1/L2) │
└──────────────┘       │  /v1/memory/:id       │       └─────────┘
                       └──────────────────────┘            │
                                │ fallback                 │
                                ▼                          │
                       ┌──────────────────────┐            │
                       │  In-memory Map (L1)   │◀───────────┘
                       │  (no Redis configured) │
                       └──────────────────────┘
```

## Storage tiers

| Tier | Backend | Scope | TTL | Pod-restart safe |
|------|---------|-------|-----|-----------------|
| **L1** | In-memory `Map` | Per-process | Configurable (default 4h) | No |
| **L2** | Redis | Cluster-wide | Configurable (default 4h) | Yes |

When `SYNESIS_PLANNER_TS_REDIS_URL` is set, planner-ts uses Redis as the session store. Otherwise, it falls back to in-memory storage. Both backends implement the same `SessionStore` interface.

## Session scoping

Sessions are keyed by `conversation_id` (from the OpenAI chat completions request body, metadata, or trusted OpenWebUI chat headers). Requests without a conversation id use a per-request ephemeral key, so cross-turn memory is disabled instead of being shared across chats. Redis keys follow the pattern:

```
{prefix}{conversation_id}
```

Default prefix: `synesis:planner:session:`. Example key:

```
synesis:planner:session:chat-abc123
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SYNESIS_PLANNER_TS_SESSION_ENABLED` | `true` | Enable session memory |
| `SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY` | `60` | Max turns kept per session |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES` | `12` | Trigger checkpoint/summarize after N messages |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_INCLUDE_RECENT` | `false` | Include verbatim recent exchanges in checkpoint blocks; off by default because OpenAI-style clients already send transcript history |
| `SYNESIS_PLANNER_TS_SESSION_TTL_MS` | `14400000` | In-memory TTL (4h) |
| `SYNESIS_PLANNER_TS_REDIS_URL` | (empty) | Redis connection URL; empty = in-memory only |
| `SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX` | `synesis:planner:session:` | Redis key prefix |
| `SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S` | `14400` | Redis key TTL in seconds (4h) |
| `SYNESIS_PLANNER_TS_CONTEXT_SELECTION_ENABLED` | `true` | Trim chat history before model admission so the latest user turn remains primary |
| `SYNESIS_PLANNER_TS_CONTEXT_RECENT_TURNS` | `2` | Number of recent user/assistant turns to keep for balanced continuity |

## Memory purge API

The OpenAI chat completions API does not define a delete/purge operation. Planner-ts provides an explicit purge endpoint:

```
DELETE /v1/memory/{conversation_id}
Authorization: Bearer <token>
```

### Response

```json
{
  "deleted": true,
  "conversation_id": "chat-abc123",
  "authz_trace_id": "uuid"
}
```

`deleted: false` means no session existed for that key. The endpoint requires the same auth as `/v1/chat/completions`.

## Open WebUI integration

Open WebUI does not natively fire a webhook on chat deletion. To wire delete-chat → planner-ts purge:

### Option A: Open WebUI Function/Action (recommended)

Create an Open WebUI **Function** of type "action" that calls the purge endpoint when a user deletes a chat. The function receives the chat metadata (including its ID) and can make an HTTP DELETE to planner-ts:

```python
# Open WebUI Action function (pseudo-code)
import requests

class Action:
    def action(self, body, __user__=None):
        chat_id = body.get("id", "")
        if not chat_id:
            return
        requests.delete(
            f"http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080/v1/memory/{chat_id}",
            headers={"Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"},
            timeout=5
        )
```

### Option B: External automation

Run a sidecar or CronJob that polls Open WebUI's API for deleted chats and calls the planner-ts purge endpoint accordingly.

### Option C: TTL-only (no active purge)

If strict lifecycle alignment is not required, rely on Redis TTL to expire sessions naturally. Default TTL is 4 hours. Stale sessions are harmless (they just add a context summary to future turns with the same conversation ID, which is unlikely after deletion).

## Prefix caching policy

Planner-ts is designed to maximize provider-level prefix caching (KV cache reuse). This is distinct from prompt-response replay caching (which is intentionally not implemented).

| Strategy | Status | Rationale |
|----------|--------|-----------|
| Provider prefix caching (system + history prefix reuse) | Enabled | Reduces prefill cost across turns |
| Prompt-response replay cache | Not implemented | Low value for real conversations; masks planner behavior |

### How prefix caching works

1. System prompts are stable and identical across calls within the same role (writer, critic)
2. Focused recent conversation history is kept in chronological order before the current turn
3. The provider (vLLM, OpenAI) automatically caches the KV state for matching prefixes
4. Planner-ts extracts `cached_prompt_tokens` from provider responses and surfaces them in usage telemetry

### Telemetry

The `usage` block in both stream and non-stream responses includes `cached_prompt_tokens`:

```json
{
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 350,
    "total_tokens": 1550,
    "cached_prompt_tokens": 800
  }
}
```

The `/health` endpoint reports `llm.prefixCacheMode` and `redis.configured` to confirm operational config.

## Redis vs pgvector

| Purpose | Store | Rationale |
|---------|-------|-----------|
| Active L1/L2 session state | Redis | Fast read/write, TTL, key-level delete, predictable scoping |
| Long-horizon semantic memory | pgvector (future) | Vector similarity for cross-conversation recall; not active session state |

pgvector is not used for active chat state. It may be added later as an optional long-horizon memory index for cross-conversation semantic recall.

---

Back to [README](../README.md) | See also: [OpenWebUI](./OPENWEBUI.md), [Chat feature tracker](../development/chat-planner-ts-feature-tracker.md)
