# Conversation Memory (L1 / L2)

Synesis keeps **per-scope** state in the **planner** so the agent can resolve references (“fix that script”, “the previous one”), resume **plan approval** and **needs_input** flows, and apply **context pivots** (language / code-vs-text / domain) without losing safety. This page describes **what is implemented today** (L1 vs L2), how keys are formed, and **gaps vs typical user expectations** for “saved” conversations.

**Code (planner-ts):** `base/planner-ts/src/context/session-store.ts`, `session-manager.ts`, and request handling in `app.ts` (scope keys, pending flows, Redis-backed session store when configured).  
**Workflow:** [WORKFLOW_PLANNER.MD](./WORKFLOW_PLANNER.MD) (plan approval, needs_input).  
**OOM / graph state:** [PLANNER_MEMORY.md](PLANNER_MEMORY.md) (separate from conversation turns).

---

## Definitions: L1 and L2

| Layer | Storage | What it holds | Survives planner pod restart? |
|-------|---------|----------------|------------------------------|
| **L1** | In-process (`ConversationMemory`) | Recent turns, `pending_*` maps, last language / last routing context (`is_code_task`, domain refs), unified **pending question** snapshot | **No** — all L1 data is lost on rollout/restart |
| **L2 (Redis)** | Optional, same Redis URL as pivot archive when configured | (a) **Pending question** write-through: `store_pending_question` mirrors to Redis so a reply can resume after L1 loss; (b) **Pivot archive**: raw history strings archived on context pivot | **Yes**, within TTL — but only for those two mechanisms, not general chat |

**Not implemented yet:** The `_on_evict` hook on L1 turn eviction is still a **stub** (debug log only). A future design could summarize evicted turns and upsert to Milvus (`conversation_memory_v1` or similar) for long-horizon memory — see [Future work](#future-work-user-expectations-and-recommended-changes).

---

## Memory scope key (`memory_scope`)

All L1 operations (history, pivot state, pending questions) use a single string key:

- **`user_id` only** — if no conversation id is provided.
- **`{user_id}:{conversation_id}`** — if `conversation_id` is present (body or header).

So **multi-chat clients must send a stable `conversation_id` per chat**; otherwise every chat shares one history bucket for that user.

**User id resolution order** (first match wins):

1. Header **`X-OpenWebUI-User-Id`** (trimmed, max 128 chars)
2. Request body **`user`** (OpenAI standard)
3. SHA256 of the raw **Bearer token** (no `Bearer ` prefix in the hash input), first **16** hex chars
4. **`anonymous`**

**Conversation id resolution order:**

1. Body **`conversation_id`**
2. **`X-OpenWebUI-Chat-Id`**
3. **`X-Conversation-Id`** or **`X-Chat-Id`**

---

## L1: What is stored

1. **Turn deque** (default **20** turns per scope, content truncated for storage/display caps). Injected into the router as **recent history** when memory is enabled.
2. **Last active language** — for language-change pivot detection.
3. **Last context** — `(is_code_task, active_domain_refs)` for deliverable/domain pivot detection.
4. **Pending plan / pending needs_input** — legacy dicts (still on the object); the graph primarily uses the **unified** `pending_questions` path for plan approval, clarification, and needs_input.
5. **Unified pending question** — written in `respond` when the user must answer (plan, clarification, needs_input). Includes `pending_question_id`, `run_id`, `turn_id`, `expires_at` (TTL from `pending_question_ttl_seconds`, default 24h).

**Eviction / caps:**

- Per-scope turn deque maxlen → oldest turn dropped; `_on_evict` called (stub).
- Global **max users/scopes** (default **5000**) → LRU entire scope evicted.
- **TTL** (default **4h** inactivity) → lazy cleanup; expired scope removed and evicted turns passed to `_on_evict`.

---

## L2: Redis (when `L2_ARCHIVE_REDIS_URL` is set)

Configured via **`SYNESIS_PLANNER_TS_REDIS_URL`** (and related Redis env vars in `base/planner-ts/src/config.ts`) when using the Redis session backend (e.g. `redis://synesis-redis.synesis-rag.svc.cluster.local:6379/2`).

### A) Pending question checkpoint

- **Write:** On `store_pending_question`, L1 is updated and, if Redis is configured, a JSON snapshot is stored under **`synesis:pending:{memory_scope}`** with TTL (default 86400s).
- **Read:** `get_and_clear_pending_question` reads L1 first; on miss, **GETDEL** from Redis and restores `_full` payload if present.

This is the **only** path that makes “reply to the plan after a pod restart” possible without L1.

### B) Pivot archive (`archive_to_l2`)

On **language or context pivot**, the planner:

1. Optionally summarizes the pre-pivot era (`summarize_pivot_history` — needs **`summarizer_model_url`** for real summaries; otherwise stub text).
2. Calls **`archive_to_l2(run_id, user_id, conversation_history)`** which, if Redis is set, does **`SETEX synesis:l2:{user_id}:{run_id}`** with TTL **`l2_archive_ttl_seconds`** (default **7 days**).

**Important quirk:** the archive key uses **`user_id` only**, not **`memory_scope`**. Two different `conversation_id`s for the same user could theoretically collide only on `run_id` (UUID — practically rare), but **browsing or replay APIs keyed by user_id** would not separate chats. Prefer scoping archive keys by **`memory_scope`** in a future change (see below).

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Master switch for L1 history injection and turn storage |
| `MEMORY_MAX_TURNS_PER_USER` | `20` | Max turns per **scope** |
| `MEMORY_MAX_USERS` | `5000` | Max distinct scopes (LRU eviction) |
| `MEMORY_TTL_SECONDS` | `14400` | Inactivity TTL (4h) for a scope |
| `L2_ARCHIVE_REDIS_URL` | `""` | If set, enables **pending checkpoint** write-through + **pivot** `archive_to_l2` |
| `L2_ARCHIVE_TTL_SECONDS` | `604800` | Redis TTL for pivot archives (7 days) |
| `PENDING_QUESTION_TTL_SECONDS` | `86400` | `expires_at` on pending snapshots; stale detection |
| `PIVOT_SUMMARY_ENABLED` | `true` | Call summarizer on pivot when history exists |
| `SUMMARIZER_MODEL_URL` / `SUMMARIZER_MODEL_NAME` | `""` / `synesis-summarizer` | Small LLM for pivot summaries; empty → stub summary |

Planner deployment env vars follow the same names with appropriate prefixing in your overlay (see [`base/planner/deployment.yaml`](../base/planner/deployment.yaml)).

---

## Client guidance

**Open WebUI / multi-chat:** Send **`conversation_id`** (or **`X-OpenWebUI-Chat-Id`**) so each chat is isolated. Without it, history and pending state **bleed across chats** for the same user id.

**Plan / needs_input resume:** For reliability across pod restarts, set **`L2_ARCHIVE_REDIS_URL`** to the same Redis the cluster already uses for planner/session workloads if applicable.

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

1. **Survive restarts** — Full turn history today is **L1-only**; after a deploy they see an empty memory unless Redis pending or a new product-level store restores it.
2. **Stay isolated per chat** — Handled when `conversation_id` is wired end-to-end from the UI/proxy.
3. **Resume exactly where they left off** — Pending checkpoint + L2 Redis helps for **interrupted plan/question** flows; general “scroll back through last week” needs **durable turn storage**.
4. **Not lose “old” context when the window slides** — Today, turns beyond maxlen or TTL are dropped with **no retrieval** (eviction hook is a stub).

**Recommended directions (engineering):**

| Change | Why |
|--------|-----|
| **Durable L2 for turns** (Postgres per `memory_scope`, or append-only object store) | Matches “saved chat” semantics; optional compaction/summarization |
| **Implement `_on_evict`** → summary + optional vector store | Long-horizon recall without unbounded L1 |
| **Scope `archive_to_l2` with `memory_scope`** | Align pivot archives with multi-chat isolation |
| **Expose `pending_question_id` in API responses** (e.g. response extension) so clients must echo it | Already generated server-side; tighter multi-tab safety if clients cooperate |
| **Reload path** (optional): hydrate L1 from durable store on first message of a session | Bridges “open saved chat” UX |
| **Product integration** — if Admin/WebUI stores conversations, define whether planner memory is source of truth or a cache of that store | Avoid two divergent histories |

---

Back to [README](../README.md) | See also: [Workflow](./WORKFLOW_PLANNER.MD), [Planner memory / OOM](PLANNER_MEMORY.md)
