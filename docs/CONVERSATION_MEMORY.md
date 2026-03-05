# Conversation Memory

Synesis maintains per-user conversation history so the system can understand references across chat sessions ("fix that script", "add error handling to it", "the previous one"). It also stores **pending plan** and **pending needs_input** context so the next user message can resume at the right node. See [WORKFLOW.md](WORKFLOW.md) for plan approval and needs_input flows.

## How It Works

1. **User identification**: Each request is associated with a user via a fallback chain:
   - The `user` field in the request body (OpenAI standard parameter) — preferred
   - A SHA256 hash of the `Authorization: Bearer <key>` header (auto-derived)
   - `"anonymous"` if neither is available

2. **Conversation scope (recommended)**: To avoid context drift across multiple chats, pass a `conversation_id` so memory is isolated per conversation:
   - Request body: `"conversation_id": "chat-abc123"`
   - Header: `X-Conversation-Id: chat-abc123` or `X-Chat-Id: chat-abc123`
   - When present, history, pending plans, and pivot state are scoped per conversation. New chat = no stale context from other chats.

3. **L1 in-memory store**: The last 20 turns (configurable) per user (or per user+conversation when scoped) are stored in-memory. When a new request arrives, the conversation history is retrieved and injected into the router prompt so it can resolve references and maintain continuity.

4. **Turn storage**: After each request completes, both the user's message and the assistant's response are stored as turns in the memory.

5. **Pending plan / needs_input**: When the Planner surfaces a plan for approval or the Worker asks a question (`needs_input`), the context is stored. On the user's next message, it is restored and the Entry node routes directly to the Worker (skipping Router/Planner).

6. **Eviction**: Users are tracked in LRU order. Inactive users (default 4h TTL) are cleaned up lazily. When the max user limit (default 5000) is reached, the least recently active user is evicted.

## Passing the `user` Field

Any OpenAI-compatible client can pass the `user` field:

```bash
curl -X POST https://synesis-api.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-agent",
    "user": "byron",
    "messages": [{"role": "user", "content": "Add compression to that script"}]
  }'
```

If you don't pass `user`, the system derives an ID from your API key — so each unique key gets its own conversation history automatically.

## Conversation Scoping (Open WebUI, Multi-Chat Clients)

Clients with multiple conversations per user (e.g. Open WebUI with multiple chats) should pass `conversation_id` so each chat has isolated memory. Without it, pending plans and history from one chat can bleed into another:

```bash
# Body
curl -X POST .../v1/chat/completions -d '{
  "model": "synesis-agent",
  "conversation_id": "chat-xyz789",
  "messages": [{"role": "user", "content": "What is the speed of light?"}]
}'

# Or via header (useful when the client proxies and can add headers)
curl -X POST .../v1/chat/completions \
  -H "X-Conversation-Id: chat-xyz789" \
  -d '{"model": "synesis-agent", "messages": [...]}'
```

Open WebUI users: If your setup forwards requests to Synesis, configure the proxy to add `X-Conversation-Id` from the active chat ID when available.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable/disable conversation memory |
| `MEMORY_MAX_TURNS_PER_USER` | `20` | Max turns stored per user |
| `MEMORY_MAX_USERS` | `5000` | Max concurrent users in memory |
| `MEMORY_TTL_SECONDS` | `14400` | User inactivity timeout (4 hours) |

## Limitations and Future L2

L1 memory is purely in-memory — it does not survive pod restarts. This is intentional for simplicity and speed. The architecture includes an explicit eviction hook (`_on_evict`) in the `ConversationMemory` class that can be wired to a Milvus-backed L2 store in the future. When L2 is added, evicted turns would be summarized and persisted, providing long-term memory across pod restarts without changing any graph nodes or API contracts.

---

Back to [README](../README.md) | See also: [Workflow](WORKFLOW.md)
