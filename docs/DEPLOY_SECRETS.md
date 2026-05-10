# Deploy-time secrets (not in Kustomize)

These credentials are **created or updated by `./scripts/deploy.sh`** (or the Admin UI / `oc`). They are **intentionally omitted** from `kustomize build` output so a plain `oc apply` never resets them to placeholders.

| Secret (namespace) | Keys | Purpose |
|--------------------|------|-----------|
| `provider-api-keys` (synesis-gateway) | `OPENROUTER_API_KEY`, … | Provider credentials consumed by planner and Yarn for direct upstream calls |
| `webui-api-key` (synesis-webui) | `api-key` | Open WebUI `OPENAI_API_KEY` + `WEBUI_SECRET_KEY` for planner authentication |

Admin archive storage is configured on the Admin API deployment, not through a checked-in Secret manifest. Set `SYNESIS_ADMIN_ARCHIVE_S3_BUCKET` plus optional `SYNESIS_ADMIN_ARCHIVE_S3_PREFIX` and `SYNESIS_ADMIN_ARCHIVE_S3_ENDPOINT_URL`; provide credentials with IRSA/workload identity or your cluster's normal S3-compatible credential mechanism. See [admin archive storage](admin/ADMIN_ARCHIVE_STORAGE.md).

**Post-apply reconciliation** in `deploy.sh` (after manifest apply):

- `reconcile_provider_api_keys` — heal missing `OPENROUTER_API_KEY`, restart direct model runtime consumers
- `reconcile_webui_client_secret` — generate `webui-api-key` if needed; restart `open-webui` if fixed
- `patch_planner_retrieval_and_web` — **default on** (`SYNESIS_DEPLOY_PLANNER_RETRIEVAL` unset or `true`): sets `synesis-planner-ts` env for TEI embedder, NornicDB, SearXNG URL, and web search enabled so router retrieval does not depend on image defaults alone. Set `SYNESIS_DEPLOY_PLANNER_RETRIEVAL=false` to disable. Planner **web_search_log** still needs Secret `synesis-admin-db-url` in `synesis-planner` (same as `patch_admin_db_urls` for admin Yarn). See [WEB_SEARCH.md](WEB_SEARCH.md) (section *planner-ts and deploy.sh*).

**Personal Access Tokens** (`syn-*`) are stored in **Postgres** (`personal_access_tokens`); they are not affected by Kustomize Secret applies.

**Reference-only YAML** (not listed in any `kustomization.yaml`):  
`base/gateway/provider-api-keys.yaml`, `base/webui/webui-api-key-secret.yaml`

**Unused in builds:** `overlays/api/openrouter-api-key` style manifests if present — use `provider-api-keys` / deploy.sh instead.

## Applying manifest changes (env vars, images)

`oc rollout restart deployment/…` only restarts pods with whatever Deployment spec is **already stored in the cluster**. Edits in Git (e.g. `ENABLE_LOGIN_FORM`, `SYNESIS_KEYCLOAK_AUDIENCE`) do nothing until you apply them:

```bash
kustomize build overlays/api | oc apply -f -   # or your overlay
# or
./scripts/deploy.sh api
```

Then restart if needed so pods pick up new images.
