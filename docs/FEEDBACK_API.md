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

**Not the same as `webui-api-key`:** `./scripts/deploy.sh` syncs **`webui-api-key`** (and related LiteLLM material) so **Open WebUI → planner-ts** chat requests use a shared Bearer key. That key authenticates the **client to the planner**. **`SYNESIS_OPENWEBUI_ADMIN_TOKEN`** is different: it is whatever **Open WebUI’s HTTP API** accepts as an **admin** when **synesis-admin** calls **Open WebUI** at `/api/v1/evaluations/...`. Synesis does not generate or rotate that credential; you supply it (see below).

To show it in Synesis Admin:

1. On **synesis-admin**, set:
   - `SYNESIS_OPENWEBUI_URL` — public or in-cluster base URL (e.g. `https://synesis.apps...` or `http://open-webui.synesis-webui.svc.cluster.local:8080` depending on your Route/Service). The default in `base/admin/deployment.yaml` points at the in-cluster Open WebUI Service.
   - `SYNESIS_OPENWEBUI_ADMIN_TOKEN` — **Bearer** value that Open WebUI treats as an **admin** for the evaluations routes. In practice this is usually either:
     - a **session JWT** from an admin browser session (copy from `Authorization` on a request to `/api/v1/...` in devtools), or  
     - a **Personal Access Token** (or equivalent) **issued inside Open WebUI** for API access, *if* your Open WebUI version accepts it on `GET /api/v1/evaluations/feedbacks/all/export`.  
     It is **not** the planner/LiteLLM “API key” env that deploy.sh wires into the WebUI pod.  
     Optional: create Secret `synesis-openwebui-admin-token` with key `token` (see deployment env); if unset, sync returns a configure error until set.
2. In Admin → **Chat Feedback**, click **Sync from Open WebUI**. This calls Open WebUI `GET /api/v1/evaluations/feedbacks/all/export` (falls back to `/api/v1/evaluations/feedbacks/all` if export returns 404) and upserts into `openwebui_feedback`.

Re-run sync after bursts of user feedback when you want the admin list updated (manual sync is the default workflow).

#### Obtaining the token (to export before `./scripts/deploy.sh`)

You do **not** generate this in Synesis Admin — it comes from **Open WebUI**, because synesis-admin is calling **Open WebUI’s** REST API.

**Option A — Open WebUI account API key (best for automation, if enabled)**  
Open WebUI can issue a user **API key** (often prefixed with `sk-`) used as `Authorization: Bearer` on `/api/v1/...`. Synesis **`base/webui/deployment.yaml`** sets **`ENABLE_API_KEYS=true`** so those keys work on REST routes; without it, Open WebUI returns **403** `Use of API key is not enabled in the environment.` (see [Open WebUI authentication](https://docs.openwebui.com/features/authentication-access/)). As an **admin**, open Open WebUI → **user menu → Settings → Account** (wording varies by version) and create or copy the **API key**, or use the API (`GET`/`POST` `/api/v1/auths/api_key` after signing in). Use that string as `SYNESIS_OPENWEBUI_ADMIN_TOKEN`.

**Option B — JWT from sign-in (scriptable)**  
`POST` to Open WebUI **`/api/v1/auths/signin`** with the admin email/password (JSON body per Open WebUI docs). The response includes a **token**; use it as the Bearer value. Expiry depends on `JWT_EXPIRES_IN` in Open WebUI.

**Option C — Browser session JWT (quick test)**  
Log in to Open WebUI as an **admin** → browser **DevTools → Network** → trigger any `/api/v1/` request → **Request headers** → copy the value after `Authorization: Bearer `. Session JWTs may expire; prefer Option A for long-lived sync.

Then either `export SYNESIS_OPENWEBUI_ADMIN_TOKEN='…'` and run `./scripts/deploy.sh`, or create the Kubernetes Secret manually (see above).

## Open WebUI Integration

### Feedback dashboard (inside Open WebUI)

A **Pipe plugin** adds a "Synesis Feedback" model. Use it to view **planner** stored thumbs with classification context:

1. Import: **Workspace → Functions → Import Functions** → upload `integrations/openwebui-synesis-feedback/synesis_feedback_export.json`
2. Configure: Edit the function Valves, set `synesis_planner_url` (e.g. `http://synesis-planner-ts:8080`)
3. Use: Start a chat, select **Synesis Feedback** as model, send `show` or `show down`

See `integrations/openwebui-synesis-feedback/README.md`.

### Storing planner thumbs (`POST /v1/feedback`)

1. **Native Open WebUI evaluation UI** does not post to Synesis — use **admin sync** (above) to mirror it, or a custom proxy if you need real-time forwarding.
2. **Custom client / integration:** Read `run_id` from the chat completion (body or streaming chunks) and POST to `{planner}/v1/feedback` with `message_id`, `run_id`, `vote` when the user votes. Run context is merged from the planner cache when `run_id` is still valid (24h).

## Run context cache

Classification context is cached for 24h after each run. When feedback arrives with `run_id`, we merge the cached context (message_snippet, response_snippet, classification_reasons, score_breakdown, task_size) into the stored feedback entry.

## Export for tuning

Negative feedback (`vote=down`) with `classification_reasons` and `score_breakdown` can be clustered to suggest YAML changes (e.g. add keywords, adjust thresholds). Future: `POST /v1/feedback/export` to generate tuning patches.
