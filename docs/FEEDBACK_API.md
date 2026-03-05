# Synesis Feedback API

Thumbs up/down for classifier tuning. Store votes with classification context for export.

## Flow

1. **Chat completion** returns `run_id` (in response body; streaming: in SSE chunks)
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

## Open WebUI Integration

### Feedback dashboard (inside Open WebUI)

A **Pipe plugin** adds a "Synesis Feedback" model. Use it to view stored feedback with classification context:

1. Import: **Workspace → Functions → Import Functions** → upload `integrations/openwebui-synesis-feedback/synesis_feedback_export.json`
2. Configure: Edit the function Valves, set `synesis_planner_url` (e.g. `http://synesis-planner:8000`)
3. Use: Start a chat, select **Synesis Feedback** as model, send `show` or `show down`

See `integrations/openwebui-synesis-feedback/README.md`.

### Storing feedback

1. **Webhook:** If Open WebUI supports feedback webhooks, configure to POST to `{planner_url}/v1/feedback` with `message_id`, `run_id`, `vote`. Planner must receive `run_id` — include it in the chat response and have the client (or proxy) preserve it for the feedback callback.

2. **Poll Open WebUI API:** Use `scripts/sync-openwebui-feedback.sh` (or cron) to fetch feedback from Open WebUI and POST to Synesis. Requires Open WebUI API key and matching `message_id` → `run_id` (e.g. store mapping when proxying).

3. **Custom client:** Clients that call Synesis directly can read `run_id` from the response and POST to `/v1/feedback` when the user votes.

## Run context cache

Classification context is cached for 24h after each run. When feedback arrives with `run_id`, we merge the cached context (message_snippet, response_snippet, classification_reasons, score_breakdown, task_size) into the stored feedback entry.

## Export for tuning

Negative feedback (`vote=down`) with `classification_reasons` and `score_breakdown` can be clustered to suggest YAML changes (e.g. add keywords, adjust thresholds). Future: `POST /v1/feedback/export` to generate tuning patches.
