# Synesis Yarn: OpenAI Compatibility and Value-Add Architecture

## Overview

Synesis Yarn is the IDE/agent runtime that presents an OpenAI-compatible
API to coding clients (Cursor, Claude Code, Roo Code, Windsurf, OpenCode,
etc.). It wraps a session-aware agentic loop with tool orchestration,
escalation to the Synesis planner pipeline, and a structured context
channel for taxonomy, steering, and evidence injection.

This document defines the compatibility contract, mode mapping, value-add
injection model, and future Developer Hub integration blueprint.

---

## 1. OpenAI Compatibility Contract

### Base URL

```
https://<yarn-host>/v1
```

`GET /v1` returns a liveness probe: `{ "status": "ok", "service": "synesis-yarn" }`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic liveness |
| GET | `/health/readiness` | Readiness probe |
| GET | `/v1` | API root / liveness for clients |
| GET | `/v1/models` | List available models |
| POST | `/v1/chat/completions` | Chat completions (streaming default) |
| GET | `/v1/mcp/tools` | List MCP tools (auth required) |
| POST | `/v1/mcp/tools/call` | Execute an MCP tool (auth required) |
| GET | `/metrics` | Prometheus metrics (admin only) |

### Request Shape (`POST /v1/chat/completions`)

```json
{
  "model": "synesis-yarn",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..." | [{"type": "text", "text": "..."}]},
    {"role": "assistant", "content": "..."}
  ],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 65536,
  "tools": [...],
  "tool_choice": "auto" | "none" | {"type": "function", "function": {"name": "..."}},
  "conversation_id": "optional-stable-id",
  "synesis_context": { ... }
}
```

**Key behaviors:**

- **`messages[]`**: On first request (empty server buffer), the full
  transcript is seeded into the session buffer. Subsequent requests only
  need to send the latest user message; the server maintains the
  conversation state. Clients should send a stable `conversation_id`.

- **`content`**: Accepts `string`, `null`, or an array of content parts
  (multipart). Text parts are extracted; non-text parts (images) are
  stored but not currently processed.

- **`tool_choice`**: Threaded through to the upstream model provider.
  In `plan` and `ask` modes, tools are suppressed regardless of this field.

- **`stream`**: Defaults to `true`. Emits `data: {json}\n\n` chunks
  with `object: "chat.completion.chunk"` and a final `data: [DONE]\n\n`.

### Error Format

All HTTP errors use the OpenAI error envelope:

```json
{
  "error": {
    "message": "human-readable description",
    "type": "authentication_error | permission_error | rate_limit_error | invalid_request_error | server_error",
    "code": "401"
  }
}
```

### Authentication

| Method | Token | Behavior |
|--------|-------|----------|
| Keycloak JWT | `Authorization: Bearer <jwt>` | Validates against JWKS; org from claims |
| PAT | `Authorization: Bearer syn-...` | Hash lookup in admin DB |
| Legacy HS256 | `Authorization: Bearer <jwt>` | Local dev only (`auth_allow_legacy_fallback`) |

**Scope requirements for chat:** PATs must have at least one scope
starting with `coder`, `model:`, or `chat:`. PATs with no scopes
(empty list) are also permitted (Keycloak default). Only PATs with
an explicit scope list that lacks any of these prefixes are rejected.
The error message is actionable and lists current scopes.

---

## 2. Mode Mapping (plan / agent / debug / ask)

Modes map to Cursor/Claude-style interaction patterns. Clients send
`synesis_context.mode` on the chat completion request:

| Mode | System Prompt Suffix | Tool Policy | Use Case |
|------|---------------------|-------------|----------|
| `agent` | Execute autonomously | Full tools | Implementation, refactoring |
| `plan` | Propose approach, no changes | Tools suppressed | Architecture, design review |
| `debug` | Investigate systematically | Full tools | Bug investigation |
| `ask` | Explain, no changes | Tools suppressed | Questions, code explanation |
| (none) | Default Synesis Coder | Full tools | Unspecified / general |

When mode is `plan` or `ask`, tools are removed from the model context
to prevent unintended side effects. The model still has access to its
training knowledge for explanations and planning.

### Client Integration

```json
{
  "messages": [...],
  "synesis_context": {
    "mode": "agent",
    "taxonomy": ["kubernetes", "python"],
    "task_pack": {"component": "planner", "issue": "memory leak"}
  }
}
```

---

## 3. Value-Add Injection Model

### 3.1 Structured Context (`synesis_context`)

The `synesis_context` field on chat completions is the primary channel
for injecting value-add behavior without modifying the OpenAI message
contract. All fields are optional:

| Field | Type | Purpose |
|-------|------|---------|
| `version` | `"1"` | Schema version |
| `mode` | `agent\|plan\|debug\|ask` | Interaction mode steering |
| `workspace` | `WorkspaceMetadata` | Project/template context (Dev Hub) |
| `task_pack` | `dict` | Structured task description |
| `taxonomy` | `list[str]` | Domain classification tags |
| `trust_labels` | `dict[str,str]` | Evidence trust metadata |
| `evidence_objects` | `list[EvidenceObject]` | Pre-fetched evidence |
| `policy_requirements` | `list[str]` | Compliance/policy constraints |
| `validation_results` | `list[dict]` | Pre-run validation data |
| `open_questions` | `list[str]` | Unresolved questions |
| `decision_trace` | `list[dict]` | Decision audit trail |

All context is serialized into the user turn within
`<synesis_coder_turn>` tags, maintaining the trust boundary defined
in the system prompt.

### 3.2 Developer Taxonomy

Taxonomy tags in `synesis_context.taxonomy` provide domain hints
that can be used for:

- Steering prompt generation toward relevant patterns
- Filtering tool availability
- Selecting retrieval domains in RAG searches
- Telemetry and analytics

Tags are freeform strings but follow conventions like `kubernetes`,
`python`, `security`, `api_design`, `testing`, etc.

### 3.3 MCP Tools (Admin Gateway)

Yarn agents discover and execute tools through the Admin MCP gateway.
Developer-focused tools added:

| Tool | Min Role | Description |
|------|----------|-------------|
| `synesis_search` | user | Search the RAG corpus for coding/architecture answers |
| `synesis_classify_intent` | user | Classify a query into taxonomy categories |
| `synesis_retrieval_gaps` | user | Report a retrieval gap to the curator pipeline |

Tools are role-filtered (RBAC) and audit-logged. The orchestrator in
Yarn loads them via `GET /api/v1/mcp/tools` with the caller's token.

### 3.4 Prompt Steering (Lightweight)

Mode-based steering is implemented as a system prompt suffix, not a
post-processing pipeline. This avoids latency in the hot path while
still shaping model behavior for different interaction patterns.

The base system prompt (`SYSTEM_PROMPT`) includes:
- Role definition (Synesis Coder)
- Tool usage guidance
- Trust boundary enforcement
- Injection resistance framing

Mode suffixes are appended per-request based on `synesis_context.mode`.

---

## 4. Multi-Replica Reliability

### Session State

Session metadata (user, org, rate limits, usage counters) is persisted
to Redis (`yarn:session:{key}`) with configurable TTL. Any replica can
load/create sessions independently.

### Memory Buffer

The in-memory `MemoryBuffer` is now persisted to Redis
(`yarn:buf:{key}`) after each successful request. On cold start (new
replica or buffer miss), the buffer is recovered from Redis. If no
Redis backup exists and the client sends a full `messages[]` array,
the buffer is seeded from the client transcript.

### Failover Order

1. Check in-process `_buffers` dict (hot cache)
2. Load from Redis `yarn:buf:{key}` (cross-replica recovery)
3. Seed from client `messages[]` (cold start)
4. Create empty buffer (absolute fallback)

No sticky sessions required for correctness.

---

## 5. Developer Hub Integration Blueprint

### Design Boundary

Red Hat Developer Hub (RHDH / Backstage) integration is modeled as
**MCP tools + context metadata**, not a direct service dependency.

### Context Channel

The `synesis_context.workspace` field carries project metadata:

```json
{
  "synesis_context": {
    "workspace": {
      "component_name": "my-service",
      "template_id": "spring-boot-starter",
      "repo_url": "https://github.com/org/my-service",
      "owner": "team-backend",
      "lifecycle": "production",
      "tags": ["java", "spring", "microservice"]
    }
  }
}
```

### Proposed MCP Tools (Future)

| Tool | Description | Source |
|------|-------------|--------|
| `rhdh_list_templates` | List available scaffolding templates | RHDH API |
| `rhdh_get_component` | Get catalog entity details | RHDH API |
| `rhdh_scaffold_status` | Check scaffolding job status | RHDH API |
| `rhdh_search_docs` | Search Developer Hub TechDocs | RHDH API |

Implementation path: Add handlers in `admin_mcp.py` that call RHDH
REST APIs with service credentials. Yarn discovers them through the
existing tool orchestrator with no runtime changes.

### Session Metadata

`resolve_or_create_session` accepts `extra_meta` which can carry
workspace context. Future work: populate from `synesis_context.workspace`
or `x-synesis-workspace` header for persistence and analytics.

---

## 6. Rollout Phases

### Phase 1: Compatibility (Implemented)
- OpenAI error envelopes
- Full `messages[]` transcript seeding
- `tool_choice` pass-through
- Multipart content support
- `GET /v1` liveness
- PAT scope alignment

### Phase 2: Reliability (Implemented)
- Redis-backed buffer persistence
- Cross-replica buffer recovery
- Client transcript fallback

### Phase 3: Value-Add (Implemented)
- Mode mapping (plan/agent/debug/ask)
- Developer taxonomy via `synesis_context`
- MCP tools: `synesis_search`, `synesis_classify_intent`, `synesis_retrieval_gaps`
- `WorkspaceMetadata` schema for Dev Hub context

### Phase 4: Developer Hub (Design-Ready)
- RHDH MCP tool handlers
- Template/scaffolding workflow support
- Catalog entity awareness in steering

---

## 7. Test Matrix

Tests in `base/yarn/tests/`:

| Suite | Coverage |
|-------|----------|
| `test_api_integration.py` | Health, models, `/v1` root, error envelopes, multipart content, scope gating, mode mapping, workspace metadata |
| `test_coder_client_vendor_matrix.py` | Cursor, Claude Code, Roo Code, Kilo Code, Cline, OpenCode, Windsurf, Crush, Goose fingerprinting |

### Live Smoke Tests (Manual)

```bash
# Liveness
curl https://synesis-yarn.apps.openshiftdemo.dev/v1

# Models
curl https://synesis-yarn.apps.openshiftdemo.dev/v1/models

# Chat (streaming)
curl -X POST https://synesis-yarn.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Authorization: Bearer syn-..." \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

# Chat with mode
curl -X POST https://synesis-yarn.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Authorization: Bearer syn-..." \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain the planner architecture"}],"synesis_context":{"mode":"ask"}}'
```

---

## 8. IDE Client Onboarding

### Cursor

```
Settings > Models > OpenAI API
  Base URL: https://synesis-yarn.apps.openshiftdemo.dev/v1
  API Key:  syn-<your-pat>
  Model:    synesis-yarn
```

### Claude Code

```bash
claude config set api-base https://synesis-yarn.apps.openshiftdemo.dev/v1
claude config set api-key syn-<your-pat>
claude config set model synesis-yarn
```

### Roo Code / Kilo Code / Cline

Use the OpenAI-compatible provider setting with:
- API URL: `https://synesis-yarn.apps.openshiftdemo.dev/v1`
- API Key: `syn-<your-pat>`
- Model: `synesis-yarn`

### OpenCode

```bash
opencode --api-base https://synesis-yarn.apps.openshiftdemo.dev/v1 \
         --api-key syn-<your-pat> \
         --model synesis-yarn
```
