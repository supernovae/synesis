# Conversation Memory (L1 / L2)

Synesis keeps **per-conversation** state in the **planner** so the agent can resolve references (“fix that script”, “the previous one”) and resume pending clarification flows without mixing chats. This page describes **what is implemented today** in `planner-ts`, how keys are formed, and **gaps vs typical user expectations** for “saved” conversations.

**Code (planner-ts):** `base/planner-ts/src/context/session-store.ts`, `session-manager.ts`, and request handling in `app.ts` (scope keys, pending flows, Redis-backed session store when configured).  
**Workflow:** [WORKFLOW_PLANNER.MD](./WORKFLOW_PLANNER.MD) (plan approval, needs_input).  
**OOM / graph state:** [PLANNER_MEMORY.md](PLANNER_MEMORY.md) (separate from conversation turns).

---

## Definitions: L1 and L2

| Layer | Storage | What it holds | Survives planner pod restart? |
|-------|---------|----------------|------------------------------|
| **L1** | In-process `MemorySessionStore` | Recent turns, deterministic checkpoint, pending clarification snapshot | **No** — all L1 data is lost on rollout/restart |
| **L2 (Redis)** | Optional `RedisSessionStore` | Same session payload as L1, stored with TTL and compare-and-swap updates | **Yes**, within TTL |

**Not implemented today:** Conversation memory is active session state only. It
does not write durable turn history or semantic long-horizon memory to NornicDB,
Postgres, object storage, or pgvector. Older turns are represented only by the
deterministic checkpoint block after compaction, then the raw recent tail is
kept in the session store.

---

## Memory scope key (`memory_scope`)

Current `planner-ts` session state uses a scoped key:

- **`conversation:principal:{org}:{user}:{conversation_id}`** — authenticated request with a conversation id.
- **`conversation:anonymous:{request_id}:{conversation_id}`** — anonymous request with a conversation id.
- **`ephemeral:{request_id}`** — if no conversation id is present.

So **multi-chat clients must send a stable `conversation_id` per chat** for
cross-turn continuity. Without it, planner memory and pending clarification
state are intentionally per-request and do not bleed across chats. Authenticated
scoping prevents two users with the same frontend chat id from sharing planner
memory.

**User id resolution order** (first match wins, for auth/attribution rather than session keying):

1. Header **`X-OpenWebUI-User-Id`** (trimmed, max 128 chars)
2. Request body **`user`** (OpenAI standard)
3. SHA256 of the raw **Bearer token** (no `Bearer ` prefix in the hash input), first **16** hex chars
4. **`anonymous`**

**Conversation id resolution order:**

1. Body **`conversation_id`**
2. Body **`session_id`** or **`chat_id`**
3. Body **`metadata.conversation_id`**, **`metadata.synesis_conversation_id`**, **`metadata.session_id`**, or **`metadata.chat_id`**
4. **`X-Synesis-Conversation-Id`**, **`X-OpenWebUI-Conversation-Id`**, **`X-OpenWebUI-Chat-Id`**, **`X-Chat-Id`**, or **`X-Session-Id`**

---

## L1: What is stored

1. **Recent turn history** — user/assistant turns recorded after each response, capped by `SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY`.
2. **Structured checkpoint** — deterministic `<SESSION_STATE>` with conversation arc, active domains, topic threads, and user facts/preferences after compaction.
3. **Pending clarification** — original task, clarification prompt/options, and assumptions so a short follow-up can be merged back into the original request.

**Eviction / caps:**

- Session history is compacted into a checkpoint after `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES`.
- Global **max sessions** (default **5000**) → LRU entire session evicted in the in-memory backend.
- **TTL** (default **4h** inactivity) → lazy cleanup in memory and Redis key expiry when Redis is configured.

---

## L2: Redis (when `SYNESIS_PLANNER_TS_REDIS_URL` is set)

Configured via **`SYNESIS_PLANNER_TS_REDIS_URL`** (and related Redis env vars in `base/planner-ts/src/config.ts`) when using the Redis session backend (e.g. `redis://synesis-redis.synesis-rag.svc.cluster.local:6379/2`).

Redis stores the same `SessionData` payload as the in-memory backend under `SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX + session_key`, with TTL from `SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S`. This makes checkpointed continuity and pending clarification survive planner pod restarts within the configured TTL.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `SYNESIS_PLANNER_TS_SESSION_ENABLED` | `true` | Master switch for session checkpoint and pending clarification state |
| `SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY` | `60` | Max stored messages per session before compaction |
| `SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS` | `5000` | Max in-memory sessions when Redis is not configured |
| `SYNESIS_PLANNER_TS_SESSION_TTL_MS` | `14400000` | Inactivity TTL (4h) |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES` | `12` | Messages before deterministic checkpoint compaction |
| `SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_INCLUDE_RECENT` | `false` | Include verbatim recent exchanges in checkpoints; off by default for OpenWebUI-style clients |
| `SYNESIS_PLANNER_TS_CONTEXT_SELECTION_ENABLED` | `true` | Trim input transcript so the latest user turn remains primary |
| `SYNESIS_PLANNER_TS_CONTEXT_RECENT_TURNS` | `2` | Recent user/assistant turns retained for normal continuity |
| `SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT` | `24` | Hard cap used by the context optimizer after session checkpoint injection |
| `SYNESIS_PLANNER_TS_REDIS_URL` | `""` | Redis session backend; empty means in-memory only |

---

## Client guidance

**Open WebUI / multi-chat:** Send **`conversation_id`** (or **`X-OpenWebUI-Chat-Id`**) so each chat has cross-turn continuity. Without it, planner uses ephemeral per-request state, so prior turns are available only if the client includes them in the OpenAI `messages` transcript.

**Pending clarification resume:** For reliability across pod restarts, set **`SYNESIS_PLANNER_TS_REDIS_URL`** to the same Redis the cluster already uses for planner/session workloads if applicable.

**API compatibility:** Standard OpenAI clients can pass **`user`**. Synesis-specific headers are optional.

Example:

```bash
curl -X POST https://synesis-api.example/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-agent",
    "user": "byron",
    "conversation_id": "chat-abc123",
    "messages": [{"role": "user", "content": "Add compression to that script"}]
  }'
```

---

## Future work: user expectations and recommended changes

Users often expect **saved conversations** to:

1. **Survive restarts** — Set `SYNESIS_PLANNER_TS_REDIS_URL` for TTL-bound session continuity; longer saved-chat history still needs product-level durable turn storage.
2. **Stay isolated per chat** — Handled when `conversation_id` is wired end-to-end from the UI/proxy.
3. **Resume exactly where they left off** — Redis helps for active session checkpoints and pending clarification; general “scroll back through last week” needs **durable turn storage**.
4. **Not lose “old” context when the window slides** — Today, turns beyond max history or TTL are dropped after deterministic checkpointing, with no semantic retrieval or durable transcript reload.

**Recommended directions (engineering):**

| Change | Why |
|--------|-----|
| **Durable store for turns** (Postgres per `conversation_id`, or append-only object store) | Matches “saved chat” semantics; optional compaction/summarization |
| **Summarize evicted history** → summary + optional vector store | Long-horizon recall without unbounded active session state |
| **Expose pending clarification ids in API responses** so clients can echo them | Tighter multi-tab safety if clients cooperate |
| **Reload path** (optional): hydrate L1 from durable store on first message of a session | Bridges “open saved chat” UX |
| **Product integration** — if Admin/WebUI stores conversations, define whether planner memory is source of truth or a cache of that store | Avoid two divergent histories |

---

Back to [README](../README.md) | See also: [Workflow](./WORKFLOW_PLANNER.MD), [Planner memory / OOM](PLANNER_MEMORY.md)
