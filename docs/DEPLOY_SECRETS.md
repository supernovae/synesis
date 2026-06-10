# Deployment Secrets

Synesis deployment secrets are Helm-managed through `charts/synesis` values or managed explicitly by operators through Kubernetes Secrets and the Admin UI. Do not use plain `kustomize build | kubectl apply` as the deployment source of truth; Helm owns the release and should apply chart-managed manifests.

| Secret (namespace) | Keys | Purpose |
|--------------------|------|---------|
| `provider-api-keys` (synesis-gateway, synced to consumers) | Provider-specific API key names from the Admin provider catalog | Provider credentials consumed by planner and Yarn for direct upstream calls |
| `webui-api-key` (synesis-webui) | `api-key` | Open WebUI `OPENAI_API_KEY` + `WEBUI_SECRET_KEY` for planner authentication |
| `synesis-internal-service-auth` (Synesis namespaces) | `token` | Service-to-service Bearer token for planner/admin/Yarn/Open WebUI |
| `synesis-admin-db-url` (admin/planner/Yarn namespaces) | `admin-url`, `trace-url` | Admin database and trace database URLs |

Set initial values under `secrets.*` in your Helm values file, then install or upgrade:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml
```

Provider keys should normally be created and rotated from Admin UI -> Providers & API keys. The admin backend updates the provider Secret and restarts direct runtime consumers. Helm `secrets.providerApiKeys` remains available for intentional bootstrap values, but values set there are Helm-managed on upgrade.

Admin archive storage is configured on the Admin API deployment. Set `SYNESIS_ADMIN_ARCHIVE_S3_BUCKET` plus optional `SYNESIS_ADMIN_ARCHIVE_S3_PREFIX` and `SYNESIS_ADMIN_ARCHIVE_S3_ENDPOINT_URL`; provide credentials with IRSA/workload identity or your cluster's normal S3-compatible credential mechanism. See [admin archive storage](admin/ADMIN_ARCHIVE_STORAGE.md).

**Personal Access Tokens** (`syn-*`) are stored in Postgres (`personal_access_tokens`); they are not affected by Kubernetes Secret applies.

## Applying Changes

Change environment variables, images, routes, jobs, and chart-managed Secrets in your Helm values file, then run:

```bash
helm upgrade synesis ./charts/synesis -f my-synesis-values.yaml
```

Use `--reset-then-reuse-values` when moving to a chart version that removed old defaults and you want Helm to drop stale computed values while preserving explicit overrides.
