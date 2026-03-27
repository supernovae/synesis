# Open WebUI Admin Guide — Synesis Dashboards & Tools

This guide shows Open WebUI administrators how to import, configure, and use the Synesis admin panels and dashboards.

---

## Overview

| Tool | Location | Purpose |
|------|----------|---------|
| **Synesis Feedback** | Inside Open WebUI (Pipe plugin) | View thumbs up/down with classification context for classifier tuning |
| **synesis-admin** | Separate web app (port-forward or Route) | Failure patterns, Knowledge Gaps, self-heal workflow |
| **Planner API** | `synesis-planner-ts:8080` | `/v1/feedback`, `/v1/knowledge/submit`, health checks |

---

## 1. Synesis Feedback (Inside Open WebUI)

The **Synesis Feedback** Pipe adds a "model" to Open WebUI that displays classifier feedback — message snippets, response snippets, `classification_reasons`, `score_breakdown`, and `task_size`. Use it to review thumbs down for tuning.

### Prerequisites

- Open WebUI must reach the Synesis planner (same Kubernetes cluster, or port-forward, or public URL)
- Planner URL, e.g. `http://synesis-planner-ts:8080` or `http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080`

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
   - Same cluster (recommended): `http://synesis-planner-ts:8080`
   - With namespace: `http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080`
   - Local dev: `http://localhost:8080` (with port-forward)
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
oc port-forward svc/synesis-admin 8080:8080 -n synesis-admin
# Open http://localhost:8080/admin/failures
```

### Authentication (Keycloak vs legacy)

- **`SYNESIS_KEYCLOAK_ISSUER_URL` set** (default in `base/admin/deployment.yaml`): the UI redirects to Keycloak (`synesis-admin` client). Local username/password (`admin` / `viewer`) is **disabled**. Use a Keycloak user in the `synesis` realm.
- **Admin API role:** users need the **`synesis-admin`** realm role to get dashboard admin privileges. Without it, they authenticate but get a normal **`user`** role (limited access). Assign the role in Keycloak: *Users → user → Role mapping → Assign role → Filter by realm roles → `synesis-admin`*.
- **Not the same as Keycloak “admin”:** The Keycloak **master** realm `admin` user is only for the Keycloak Admin Console. Synesis uses the **`synesis`** realm. Open WebUI admin features use **`OAUTH_ADMIN_ROLES`** (default `synesis-admin`) — assign that **realm role** in the `synesis` realm to users who should manage Open WebUI as admins.
- **Issuer empty / dev without Keycloak:** unset `SYNESIS_KEYCLOAK_ISSUER_URL` on the deployment to fall back to legacy JWT users only (`admin`, `viewer` from env passwords).

If you use `./scripts/deploy.sh`, it also patches the issuer from the Keycloak Route; a plain `kustomize | oc apply` used to wipe that patch — the issuer is now in Git so re-applies stay on Keycloak.

**OIDC details:** The dashboard exchanges the authorization code via **`POST /api/v1/auth/oauth/token`** on the admin API (server-side), so the browser does not call Keycloak’s token endpoint (avoids CORS). Token exchange uses **`SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL`** when set (cluster Service URL) so the admin pod does not depend on hairpin access to the public Route.

**Loop: token OK (`POST …/oauth/token` 200) then “Authentication failed”:** Check **`GET /api/v1/auth/me`**: if it returns **401**, the JWT failed validation. A common cause is **`SYNESIS_KEYCLOAK_AUDIENCE=synesis-admin`** — Keycloak access tokens use **`aud=account`**, not the client id. In Git this is **`SYNESIS_KEYCLOAK_AUDIENCE=""`** with **`SYNESIS_KEYCLOAK_EXPECTED_AZP=synesis-admin`**. Apply the current `base/admin/deployment.yaml` (or `oc set env … AUDIENCE=""`) — **`oc rollout restart` alone does not change env vars** from Git.

**“No authorization code” / redirect loop:** Keycloak may return `error` instead of `code` (redirect URI mismatch, cancelled login). After a failure, login uses a **Continue to Keycloak** button instead of an immediate redirect so you are not stuck in a loop. Check:

```bash
oc logs -n synesis-admin -l app.kubernetes.io/name=synesis-admin --tail=150
# Look for identity_provider_http_error — wrong internal URL/port if connection errors.
```

**Keycloak “Invalid scopes: openid profile email”:** The live `synesis` realm must have **Client scopes** named `openid`, `profile`, and `email`, and `synesis-admin` / `synesis-webui` must include them as **default** scopes. The one-shot realm import job does not reliably patch an existing realm. **Repair (idempotent):** run **`./scripts/ensure-keycloak-oidc-scopes.sh`** with `oc` logged in, or **`./scripts/deploy.sh …`** (it runs that script after Keycloak is ready). Git manifests (`realm-import.yaml`) include the same definitions for new clusters.

### Pages

| Path | Description |
|------|-------------|
| `/admin/failures` | Paginated list of failures with language/type filters |
| `/admin/failures/stats` | Aggregate stats: failure rate by language, common error types, resolution rate |
| `/admin/failures/gaps` | RAG corpus gaps: unresolved failures suggest missing documentation |
| `/admin/failures/{id}` | Detail view with code, error output, resolution |
| `/admin/status` | Model health (executor, router, critic) |
| `/admin/observability/knowledge-gaps` | Knowledge gap list with status filter (open/resolved/reopened) and admin actions |
| `/admin/feedback/knowledge-gaps` | Knowledge gaps surfaced via user feedback, same lifecycle actions |

### Knowledge Gap Lifecycle

The admin UI allows managing the lifecycle of knowledge gaps:

- **Filter by status**: Open, Resolved, Reopened, or All
- **Resolve**: Mark a gap as addressed, with an optional resolution note
- **Reopen**: Return a resolved gap to open status if it resurfaces
- **Purge**: Permanently delete a gap and its status record

The gap status data is stored in a companion Milvus collection (`synesis_knowledge_gap_status`) alongside the original backlog collection.

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
| Planner (internal) | `http://synesis-planner-ts:8080` |
| Planner (with ns) | `http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080` |
| synesis-admin (port-forward) | `http://localhost:8080` |

---

## 5. Theme Customization

Synesis deploys a child Open WebUI image with a branded CSS theme (`base/webui/synesis-theme.css`). The theme is injected as `/static/custom.css` and loaded automatically — no admin action is needed.

To override or extend the theme, edit `synesis-theme.css`, rebuild the image (`./scripts/build-images.sh --only open-webui --push`), and restart the deployment. Admins can also apply per-instance CSS through Open WebUI's admin settings if needed; the image-baked theme provides the default look.

---

## See also

- [FEEDBACK_API.md](FEEDBACK_API.md) — Feedback API, run context, sync script
- [USERGUIDE.md](USERGUIDE.md) — User-facing triggers, /why, /reclassify
- [integrations/openwebui-synesis-feedback/README.md](../integrations/openwebui-synesis-feedback/README.md) — Plugin build and install
