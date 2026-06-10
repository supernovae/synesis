# Planner-TS Memory Lifecycle

This document describes how `planner-ts` manages active conversation memory,
how Redis makes that memory safe across planner pods, and how frontends can
purge planner memory when a chat is deleted.

For the user-facing explanation of L1/L2 conversation memory, see
[CONVERSATION_MEMORY.md](CONVERSATION_MEMORY.md). For capacity and runtime
controls, see [planner-scaling.md](planner-scaling.md).

## Architecture

```
┌──────────────┐       ┌──────────────────────┐       ┌─────────┐
│  Open WebUI  │──────▶│    planner-ts API     │──────▶│  Redis   │
│  (frontend)  │       │  /v1/chat/completions │       │  (L2)    │
└──────────────┘       │  /v1/memory/:id       │       └─────────┘
                       └──────────────────────┘            │
                                │ fallback                 │
                                ▼                          │
                       ┌──────────────────────┐            │
                       │  MemorySessionStore    │◀───────────┘
                       │  (no Redis configured) │
                       └──────────────────────┘
```

## Storage Backends

| Backend | Scope | TTL | Pod-restart safe | Multi-replica safe |
|---------|-------|-----|------------------|--------------------|
| `MemorySessionStore` | Per-process | Inactivity TTL, default 4h | No | No |
| `RedisSessionStore` | Cluster-wide | Redis key TTL, default 4h | Yes | Yes, with CAS retries |

When `SYNESIS_PLANNER_TS_REDIS_URL` is set, planner-ts uses Redis as the session store. Otherwise, it falls back to in-memory storage. Both backends implement the same `SessionStore` interface.

Stored `SessionData` contains:

- `history`: recent user/assistant/tool/system messages retained for active continuity.
- `checkpointBlock`: deterministic `<SESSION_STATE>` summary injected into later requests.
- `pendingClarification`: clarification question/options/assumptions and original task.
- `lastSeenAt`: inactivity timestamp for TTL cleanup.

## Session scoping

Sessions are scoped by authenticated principal plus conversation id. Requests
without a conversation id use a per-request ephemeral key, so cross-turn memory
is disabled instead of being shared across chats.

Conversation id resolution order:

1. Body `conversation_id`
2. Body `session_id` or `chat_id`
3. Body `metadata.conversation_id`, `metadata.synesis_conversation_id`, `metadata.session_id`, or `metadata.chat_id`
4. Header `X-Synesis-Conversation-Id`, `X-OpenWebUI-Conversation-Id`, `X-OpenWebUI-Chat-Id`, `X-Chat-Id`, or `X-Session-Id`

Session key shape:

| Case | Session key shape |
|------|-------------------|
| Authenticated conversation | `conversation:principal:{org}:{user}:{conversation}` |
| Anonymous conversation | `conversation:anonymous:{request}:{conversation}` |
| No conversation id | `ephemeral:{request}` |

Redis stores the sanitized session key under:

```text
{SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX}{sanitized_session_key}
```

Default Redis prefix:

```text
synesis:planner:session:
```

For purge compatibility, planner also attempts legacy keys
`conversation:{conversation_id}` and `{conversation_id}` when deleting memory.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SYNESIS_PLANNER_TS_SESSION_ENABLED` | `true` | Enable session memory |
| `SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY` | `60` | Max turns kept per session |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES` | `12` | Trigger checkpoint/summarize after N messages |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_INCLUDE_RECENT` | `false` | Include verbatim recent exchanges in checkpoint blocks; off by default because OpenAI-style clients already send transcript history |
| `SYNESIS_PLANNER_TS_SESSION_TTL_MS` | `14400000` | In-memory TTL (4h) |
| `SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS` | `5000` | Max sessions in the in-memory fallback store |
| `SYNESIS_PLANNER_TS_REDIS_URL` | (empty) | Redis connection URL; empty = in-memory only |
| `SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX` | `synesis:planner:session:` | Redis key prefix |
| `SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S` | `14400` | Redis key TTL in seconds (4h) |
| `SYNESIS_PLANNER_TS_REDIS_CAS_MAX_RETRIES` | `5` | Redis compare-and-set retries for concurrent session mutation |
| `SYNESIS_PLANNER_TS_CONTEXT_SELECTION_ENABLED` | `true` | Trim chat history before model admission so the latest user turn remains primary |
| `SYNESIS_PLANNER_TS_CONTEXT_RECENT_TURNS` | `2` | Number of recent user/assistant turns to keep for balanced continuity |
| `SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT` | `24` | Hard cap used by the context optimizer after session checkpoint injection |

In Helm, `workloads.plannerTs` wires `SYNESIS_PLANNER_TS_REDIS_URL` from the
`synesis-redis` secret by default. Multi-replica planner deployments should keep
that Redis setting populated.

## Turn Lifecycle

1. The request enters `POST /v1/chat/completions`.
2. Planner resolves auth and the scoped session key.
3. `SessionManager.enrichIncomingMessages()` prepends the stored
   `<SESSION_STATE>` checkpoint when one exists.
4. Context selection keeps the newest user turn primary and retains a bounded
   number of recent turns.
5. The context optimizer caps oversized messages before model admission.
6. If a pending clarification exists and the new user turn looks like the
   answer, planner merges the original request and clarification response,
   raises minimum planning difficulty, and clears the pending clarification.
7. After the response, `recordTurn()` appends the latest user/assistant turn,
   sanitizes assistant content, and checkpoint-compacts history when the
   message threshold is reached.

Checkpoint compaction is deterministic. It stores a `<SESSION_STATE>` block with:

- conversation arc
- active domains and frame coherence
- topic threads
- extracted user facts/preferences
- optional recent exchanges when explicitly enabled

After checkpointing, planner keeps the recent tail in `history` rather than
discarding all raw turns.

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

The purge endpoint resolves the caller's scoped session key for the supplied
conversation id, deletes that scoped key, and also deletes legacy unscoped keys
for compatibility with older deployments.

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

Clarification resume still runs the normal `entry_pipeline` and planner path.
The planner reuses pending clarification context and prior plan state, but it
does not skip entry classification just because a user is answering a
clarification question. That keeps stale or changed user intent from bypassing
classification. If clarification resume latency becomes a real bottleneck,
profile entry-vs-planner cost first; otherwise rely on provider prefix caching
for repeated stable prompt prefixes instead of adding another branch.

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

`/health/detailed` reports `llm.prefixCacheMode`, `redis.configured`, session
telemetry, and admission-control stats. It requires
`SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN`. `/health/readiness` reports whether
planner can use its configured Redis session backend.

Cache effectiveness is provider- and deployment-specific. Validate it with
provider dashboards, model-server metrics, or raw usage payloads before treating
cached tokens as a cost or latency guarantee. Frequent model/version changes,
large dynamic prefixes, or providers without prefix caching will limit the win.

## Redis vs pgvector

| Purpose | Store | Rationale |
|---------|-------|-----------|
| Active planner session state | Redis | Fast read/write, TTL, key-level delete, predictable scoping |
| Long-horizon semantic memory | pgvector (future) | Vector similarity for cross-conversation recall; not active session state |

pgvector is not used for active chat state. It may be added later as an optional long-horizon memory index for cross-conversation semantic recall.

---

Back to [README](../README.md) | See also: [OpenWebUI](./OPENWEBUI.md), [Chat docs](README.md), [Planner scaling](planner-scaling.md)
