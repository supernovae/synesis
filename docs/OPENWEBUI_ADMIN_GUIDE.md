# Open WebUI Admin Guide — Synesis Dashboards & Tools

This guide shows Open WebUI administrators how to import, configure, and use the Synesis admin panels and dashboards.

---

## Overview

| Tool | Location | Purpose |
|------|----------|---------|
| **Synesis Feedback** | Inside Open WebUI (Pipe plugin) | View thumbs up/down with classification context for classifier tuning |
| **synesis-admin** | Separate web app (port-forward or Route) | Failure patterns, Knowledge Gaps, self-heal workflow |
| **Planner API** | `synesis-planner:8000` | `/v1/feedback`, `/v1/knowledge/submit`, health checks |

---

## 1. Synesis Feedback (Inside Open WebUI)

The **Synesis Feedback** Pipe adds a "model" to Open WebUI that displays classifier feedback — message snippets, response snippets, `classification_reasons`, `score_breakdown`, and `task_size`. Use it to review thumbs down for tuning.

### Prerequisites

- Open WebUI must reach the Synesis planner (same Kubernetes cluster, or port-forward, or public URL)
- Planner URL, e.g. `http://synesis-planner:8000` or `http://synesis-planner.synesis-planner.svc.cluster.local:8000`

### Import the plugin

1. Obtain the export file:
   - From the Synesis repo: `integrations/openwebui-synesis-feedback/synesis_feedback_export.json`
   - Or build it: `cd integrations/openwebui-synesis-feedback && python build_export.py`
2. In Open WebUI, go to **Workspace → Functions**
3. Click **Import Functions**
4. Choose **Upload** and select `synesis_feedback_export.json`
5. Confirm the import

### Configure Valves

1. In **Workspace → Functions**, find **Synesis Feedback**
2. Click the function to open its settings
3. Set **synesis_planner_url**:
   - Same cluster (recommended): `http://synesis-planner:8000`
   - With namespace: `http://synesis-planner.synesis-planner.svc.cluster.local:8000`
   - Local dev: `http://localhost:8000` (with port-forward)
4. Optionally set **limit** (default 20) — max feedback entries to fetch

### Use it

1. Start a **new chat**
2. Click the model selector (top of chat)
3. Select **Synesis Feedback** (it appears as a model/agent)
4. Send a message:
   - `show` — all feedback (up and down)
   - `show down` — thumbs down only (tuning candidates)
   - `show up` — thumbs up only

The response shows a formatted list with message snippet, response snippet, `task_size`, `classification_reasons`, and `score_breakdown` for each entry.

### Troubleshooting

| Error | Fix |
|-------|-----|
| **Connection error** | Check `synesis_planner_url`, network (same namespace/cluster), firewall |
| **No feedback entries** | Feedback is stored when users thumbs up/down and `run_id` is passed to `POST /v1/feedback`. Run a chat, vote, then sync or ensure your setup posts feedback (see [FEEDBACK_API.md](FEEDBACK_API.md)) |
| **422 or import error** | Ensure `synesis_feedback_export.json` is valid JSON; regenerate with `build_export.py` |

---

## 2. synesis-admin (Failure Dashboard)

The **synesis-admin** service is a separate web app (not inside Open WebUI) for browsing failure patterns and Knowledge Gaps.

### Access

**Option A — Route (if exposed):**

```
https://synesis-admin.<cluster-domain>/admin/failures
```

**Option B — Port-forward:**

```bash
oc port-forward svc/synesis-admin 8080:8080 -n synesis-planner
# Open http://localhost:8080/admin/failures
```

### Pages

| Path | Description |
|------|-------------|
| `/admin/failures` | Paginated list of failures with language/type filters |
| `/admin/failures/stats` | Aggregate stats: failure rate by language, common error types, resolution rate |
| `/admin/failures/gaps` | RAG corpus gaps: unresolved failures suggest missing documentation |
| `/admin/failures/{id}` | Detail view with code, error output, resolution |
| `/admin/status` | Model health (executor, supervisor, critic) |

---

## 3. Planner API (Admin Endpoints)

The Synesis planner exposes endpoints useful for admin and tuning:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/feedback` | GET | List stored feedback (query: `vote`, `limit`, `offset`) |
| `/v1/feedback` | POST | Store a vote (`message_id`, `run_id`, `vote`) |
| `/v1/knowledge/submit` | POST | Submit user knowledge to fill RAG gaps |
| `/health` | GET | Liveness |
| `/health/readiness` | GET | Readiness |

Use these from scripts, curl, or custom tooling. See [FEEDBACK_API.md](FEEDBACK_API.md) for request/response formats.

---

## 4. Quick reference

### Import checklist

- [ ] Obtain `synesis_feedback_export.json` from `integrations/openwebui-synesis-feedback/`
- [ ] Open WebUI → Workspace → Functions → Import Functions → Upload JSON
- [ ] Edit Synesis Feedback → set `synesis_planner_url`
- [ ] New chat → Select "Synesis Feedback" model → Send `show` or `show down`

### URLs (adjust for your cluster)

| Service | Default URL |
|---------|------------|
| Planner (internal) | `http://synesis-planner:8000` |
| Planner (with ns) | `http://synesis-planner.synesis-planner.svc.cluster.local:8000` |
| synesis-admin (port-forward) | `http://localhost:8080` |

---

## See also

- [FEEDBACK_API.md](FEEDBACK_API.md) — Feedback API, run context, sync script
- [USERGUIDE.md](USERGUIDE.md) — User-facing triggers, /why, /reclassify
- [integrations/openwebui-synesis-feedback/README.md](../integrations/openwebui-synesis-feedback/README.md) — Plugin build and install
