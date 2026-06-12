# Open WebUI Admin Guide — Synesis Dashboards & Tools

This guide shows Open WebUI administrators how to import, configure, and use the Synesis admin panels and dashboards.

---

## Overview

| Tool | Location | Purpose |
|------|----------|---------|
| **synesis-admin** | Separate web app (port-forward or Route) | Failure patterns, Knowledge Gaps, Open WebUI feedback sync, self-heal workflow |
| **Planner API** | `synesis-planner-ts:8080` | `/v1/feedback`, `/v1/knowledge/submit`, health checks |

---

## 1. Feedback review

The old **Synesis Feedback** Open WebUI Pipe export is not shipped in this
repository. Use **synesis-admin → Chat Feedback → Sync from Open WebUI** to
mirror Open WebUI evaluation records into the admin database, then review
message snippets, response snippets, and trace context in the admin UI.

### Troubleshooting

| Error | Fix |
|-------|-----|
| **No feedback entries** | Feedback is stored in Open WebUI after users vote. Confirm Helm wired `SYNESIS_OPENWEBUI_URL` and the generated `synesis-openwebui-admin-token`, run a chat, vote, then use **Sync from Open WebUI** (see [FEEDBACK_API.md](../FEEDBACK_API.md)). |
| **403 from Open WebUI** | Confirm the same `synesis-openwebui-admin-token` value exists in the WebUI, admin, and planner namespaces. It is separate from the `webui-api-key` used for Open WebUI → planner requests. |

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

### Authentication

- **`SYNESIS_KEYCLOAK_ISSUER_URL` set** (default in `base/admin/deployment.yaml`): the UI redirects to Keycloak (`synesis-admin` client). Local username/password (`admin` / `viewer`) is **disabled**. Use a Keycloak user in the `synesis` realm.
- **Admin API role:** users need the **`synesis-admin`** realm role to get dashboard admin privileges. Without it, they authenticate but get a normal **`user`** role (limited access). Assign the role in Keycloak: *Users → user → Role mapping → Assign role → Filter by realm roles → `synesis-admin`*.
- **Not the same as Keycloak “admin”:** The Keycloak **master** realm `admin` user is only for the Keycloak Admin Console. Synesis uses the **`synesis`** realm. Open WebUI admin features use **`OAUTH_ADMIN_ROLES`** (default `synesis-admin`) — assign that **realm role** in the `synesis` realm to users who should manage Open WebUI as admins.
- **Issuer empty / dev without Keycloak:** interactive admin login is disabled. There is no local username/password fallback. Use OIDC for browser login or PAT-backed API calls for automation.

Manage the issuer through Helm values so `SYNESIS_KEYCLOAK_ISSUER_URL` and related OIDC settings stay stable across upgrades.

**OIDC details:** The dashboard exchanges the authorization code via **`POST /api/v1/auth/oauth/token`** on the admin API (server-side), so the browser does not call Keycloak’s token endpoint (avoids CORS). Token exchange uses **`SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL`** when set (cluster Service URL) so the admin pod does not depend on hairpin access to the public Route.

**Loop: token OK (`POST …/oauth/token` 200) then “Authentication failed”:** Check **`GET /api/v1/auth/me`**: if it returns **401**, the JWT failed validation. A common cause is **`SYNESIS_KEYCLOAK_AUDIENCE=synesis-admin`** — Keycloak access tokens use **`aud=account`**, not the client id. In Git this is **`SYNESIS_KEYCLOAK_AUDIENCE=""`** with **`SYNESIS_KEYCLOAK_EXPECTED_AZP=synesis-admin`**. Apply the current `base/admin/deployment.yaml` (or `oc set env … AUDIENCE=""`) — **`oc rollout restart` alone does not change env vars** from Git.

**“No authorization code” / redirect loop:** Keycloak may return `error` instead of `code` (redirect URI mismatch, cancelled login). After a failure, login uses a **Continue to Keycloak** button instead of an immediate redirect so you are not stuck in a loop. Check:

```bash
oc logs -n synesis-admin -l app.kubernetes.io/name=synesis-admin --tail=150
# Look for identity_provider_http_error — wrong internal URL/port if connection errors.
```

**Keycloak “Invalid scopes: openid profile email”:** The live `synesis` realm must have **Client scopes** named `openid`, `profile`, and `email`, and `synesis-admin` / `synesis-webui` must include them as **default** scopes. The one-shot realm import job does not reliably patch an existing realm. **Repair (idempotent):** run **`./scripts/ensure-keycloak-oidc-scopes.sh`** with `oc` logged in, or update the realm import values and run `helm upgrade`. Git manifests include the same definitions for new clusters.

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

The gap status data is stored in Admin/Postgres alongside the original backlog records.

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

Use these from scripts, curl, or custom tooling. See [FEEDBACK_API.md](../FEEDBACK_API.md) for request/response formats.

---

## 4. Quick reference

### Feedback sync checklist

- [ ] Confirm Helm generated `synesis-openwebui-admin-token` and mounted it into synesis-admin as `SYNESIS_OPENWEBUI_ADMIN_TOKEN`.
- [ ] Run a chat in Open WebUI and submit a thumbs up/down evaluation.
- [ ] Open synesis-admin → Chat Feedback → **Sync from Open WebUI**.
- [ ] Review mirrored feedback rows in synesis-admin.

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

- [FEEDBACK_API.md](../FEEDBACK_API.md) — Feedback API, run context, sync script
- [User guide](../user/README.md) — User-facing setup and troubleshooting
- [Open WebUI](OPENWEBUI.md) — Built-in Open WebUI integration
