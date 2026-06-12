# Synesis Feedback API

Thumbs up/down for classifier tuning. Store votes with classification context for export.

## Flow

1. **Chat completion** returns `run_id` (in response body; streaming: on the final `chat.completion.chunk` alongside `usage`, plus optional `authz_trace_id`)
2. **Client** (Open WebUI, custom UI) echoes `run_id` when user votes
3. **POST /v1/feedback** stores vote + associates with run context (classification_reasons, score_breakdown, task_size)
4. **GET /v1/feedback** lists stored feedback for admin/tuning

## Endpoints

### POST /v1/feedback

Store a vote. Run context (classification_reasons, etc.) is looked up by `run_id` from the run context cache (TTL 24h).

```json
{
  "message_id": "msg_abc123",
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "vote": "down",
  "user_id": "optional",
  "model": "synesis-agent"
}
```

- `message_id`: Client message ID (e.g. from Open WebUI)
- `run_id`: From Synesis chat response
- `vote`: `"up"` or `"down"`
- `user_id`: Optional (filled from context if omitted)
- `model`: Optional

**Response:** `{"status": "stored", "run_id": "..."}`

### GET /v1/feedback

List stored feedback. Query params:

- `vote`: Filter by `up` or `down`
- `limit`: Max entries (default 50)
- `offset`: Pagination offset

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "message_id": "...",
      "run_id": "...",
      "vote": "down",
      "message_snippet": "...",
      "response_snippet": "...",
      "classification_reasons": ["io_basic(+1)", "..."],
      "score_breakdown": {"io_basic": 1},
      "task_size": "trivial",
      "timestamp": "2025-02-25T12:00:00Z"
    }
  ]
}
```

## Admin UI (`synesis-admin`)

The **Chat Feedback** page calls the planner `GET /v1/feedback` and merges rows with **mirrored Open WebUI evaluation feedback** from Postgres (see below). It expects the planner response shape `{"object":"list","data":[...]}` (not `entries`).

- **Filters:** source (planner / Open WebUI), rating (up/down), review status (pending / reviewed / closed).
- **Trace link:** When a `run_id` is present (planner rows always; Open WebUI rows if `run_id` / `synesis_run_id` appears in the stored snapshot — set by the Synesis Open WebUI image from planner SSE), the UI links to `/traces/{run_id}` (same id as the planner pipeline trace).
- **Workspace:** Admins can set review status and an internal note (`PATCH /api/v1/feedback/workspace`).

### Syncing Open WebUI evaluation feedback

Open WebUI stores “Submit feedback” / evaluation data in **its own** SQLite database (`POST /api/v1/evaluations/feedback` — see [Open WebUI evaluations API](https://github.com/open-webui/open-webui/blob/main/src/lib/apis/evaluations/index.ts)). That does **not** call Synesis automatically.

**Not the same as `webui-api-key`:** Helm creates **`webui-api-key`** so **Open WebUI → planner-ts** chat requests use a shared Bearer key. That key authenticates the **client to the planner**. Helm also creates **`synesis-openwebui-admin-token`**, a Synesis-owned service token used only for Open WebUI feedback export and planner message status events.

To show it in Synesis Admin:

1. On **synesis-admin**, set:
   - `SYNESIS_OPENWEBUI_URL` — public or in-cluster base URL (e.g. `https://synesis.apps...` or `http://open-webui.synesis-webui.svc.cluster.local:8080` depending on your Route/Service). The default in `base/admin/deployment.yaml` points at the in-cluster Open WebUI Service.
   - `SYNESIS_OPENWEBUI_ADMIN_TOKEN` — read from Secret `synesis-openwebui-admin-token`, key `token`. Helm generates a stable `sk-synesis-*` token on first install unless `secrets.openwebuiAdminToken` is supplied, then mounts the same secret into Open WebUI, synesis-admin, and planner-ts.
2. In Admin → **Chat Feedback**, click **Sync from Open WebUI**. This calls Open WebUI `GET /api/v1/evaluations/feedbacks/all/export` (falls back to `/api/v1/evaluations/feedbacks/all` if export returns 404) and upserts into `openwebui_feedback`.

Re-run sync after bursts of user feedback when you want the admin list updated (manual sync is the default workflow).

#### Service-token behavior

The Synesis Open WebUI image loads `base/webui/overrides/sitecustomize.py`, which accepts `SYNESIS_OPENWEBUI_SERVICE_TOKEN` only on:

- `GET /api/v1/evaluations/feedbacks/all`
- `GET /api/v1/evaluations/feedbacks/all/export`
- `POST /api/v1/chats/{chat_id}/messages/{message_id}/event`

Normal Open WebUI user API keys are disabled with `ENABLE_API_KEYS=false`, so users cannot mint Open WebUI API keys and use Open WebUI as a general API gateway in front of Synesis planner authentication. The service token is not stored as a user API key; it is a deployment secret shared only between trusted Synesis components and Open WebUI.

### Chat Feedback sync returns 502 (Bad Gateway)

synesis-admin maps most Open WebUI failures to **HTTP 502** with a **detail** string (shown in the admin UI). Typical causes:

| Cause | What to do |
|--------|------------|
| **Token mismatch** | Confirm Secret `synesis-openwebui-admin-token` has the same value in `synesis-webui`, `synesis-admin`, and `synesis-planner`, then restart Open WebUI, synesis-admin, and planner-ts. |
| **Wrong token type** | `webui-api-key` authenticates **Open WebUI → planner**, not **admin/planner → Open WebUI**. Use the Helm-managed `synesis-openwebui-admin-token`. |
| **Open WebUI API keys disabled** | This is expected. Synesis uses the service-token bridge, not normal Open WebUI user API keys. If Open WebUI rejects the token with “API key not enabled,” confirm the deployed image includes `base/webui/overrides/sitecustomize.py` and `SYNESIS_OPENWEBUI_SERVICE_TOKEN` is set. |
| **Service endpoint denied** | The service token only works for feedback export and message status events. Other Open WebUI API paths intentionally return 403. |
| **Unreachable URL** | Wrong `SYNESIS_OPENWEBUI_URL`, DNS, port, or NetworkPolicy blocking `synesis-admin` → `open-webui`. Confirm the Service URL matches your namespace (e.g. `http://open-webui.synesis-webui.svc.cluster.local:8080`). |
| **Open WebUI image** | Use the Synesis-built Open WebUI image. Upstream Open WebUI does not know about `SYNESIS_OPENWEBUI_SERVICE_TOKEN`. |

## Open WebUI Integration

### Feedback dashboard

The old Open WebUI **Pipe plugin** export is not shipped in this repository.
Use **synesis-admin → Chat Feedback → Sync from Open WebUI** to mirror native
Open WebUI evaluations into the admin database, then review them in the admin
UI.

### Storing planner thumbs (`POST /v1/feedback`)

1. **Native Open WebUI evaluation UI** does not post to Synesis — use **admin sync** (above) to mirror it, or a custom proxy if you need real-time forwarding.
2. **Custom client / integration:** Read `run_id` from the chat completion (body or streaming chunks) and POST to `{planner}/v1/feedback` with `message_id`, `run_id`, `vote` when the user votes. Run context is merged from the planner cache when `run_id` is still valid (24h).

## Run context cache

Classification context is cached for 24h after each run. When feedback arrives with `run_id`, we merge the cached context (message_snippet, response_snippet, classification_reasons, score_breakdown, task_size) into the stored feedback entry.

## Export for tuning

Negative feedback (`vote=down`) with `classification_reasons` and `score_breakdown` can be clustered to suggest YAML changes (e.g. add keywords, adjust thresholds). Future: `POST /v1/feedback/export` to generate tuning patches.
