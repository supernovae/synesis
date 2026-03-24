# LiteLLM Gateway

LiteLLM is the unified LLM proxy gateway for Synesis. It sits between all
internal services (planner, admin, WebUI) and external LLM providers, handling
model routing, authentication, cost tracking, and rate limiting.

## Architecture

```
                          +------------------+
 Open WebUI  ----------> |                  |
 synesis-planner ------> |   litellm-proxy  | -----> OpenRouter
 synesis-admin ---------> |  (port 4000)     | -----> xAI / Grok
                          |                  | -----> DeepInfra
                          +--------+---------+ -----> Self-hosted vLLM
                                   |
                              Prisma ORM
                                   |
                          +--------+---------+
                          | CNPG PostgreSQL   |
                          | (litellm DB)      |
                          +------------------+
```

**Service address**: `litellm-proxy.synesis-gateway.svc.cluster.local:4000`
**External route**: `https://synesis-api.apps.<cluster-domain>`

## Deployment

LiteLLM is deployed via the **official Helm chart** (`oci://ghcr.io/berriai/litellm-helm`),
pinned to a specific chart version. Everything else in Synesis uses Kustomize.
The Helm release is managed by `deploy.sh`.

### Image

We use `ghcr.io/berriai/litellm-non_root` — the OpenShift-compatible variant
that pre-builds Prisma binaries with the correct OpenSSL target, runs as
`nobody`, and applies the OpenShift group-0 permission pattern.

The image tag is **pinned** to a specific stable release (e.g.
`main-v1.82.3-stable`) in `values-synesis.yaml`. Do not use floating tags
like `main-stable` or `latest` — see *Version Pinning Policy* below.

### Files

| File | Purpose |
|------|---------|
| `base/gateway/helm/values-synesis.yaml` | Primary Helm values (dynamic Prisma mode) |
| `base/gateway/helm/values-synesis-static.yaml` | Static fallback overlay (all models in ConfigMap) |
| `base/gateway/kustomization.yaml` | Only creates the `synesis-gateway` namespace |
| `scripts/deploy.sh` | Orchestrates secrets, DB setup, and `helm upgrade` |

### Deploy commands

```bash
# Full deploy (includes LiteLLM Helm release)
./scripts/deploy.sh api

# Static fallback mode (bypasses Prisma model sync)
SYNESIS_LITELLM_STATIC_FALLBACK=true ./scripts/deploy.sh api

# Manual Helm upgrade (dynamic mode) — chart version must match deploy.sh
helm upgrade --install litellm-proxy oci://ghcr.io/berriai/litellm-helm \
  --version 1.82.3-stable.patch.2 \
  -n synesis-gateway -f base/gateway/helm/values-synesis.yaml \
  --wait --timeout 5m

# Manual Helm upgrade (static fallback)
helm upgrade --install litellm-proxy oci://ghcr.io/berriai/litellm-helm \
  --version 1.82.3-stable.patch.2 \
  -n synesis-gateway \
  -f base/gateway/helm/values-synesis.yaml \
  -f base/gateway/helm/values-synesis-static.yaml \
  --wait --timeout 5m
```

### Secrets (managed by deploy.sh)

| Secret | Namespace | Keys | Purpose |
|--------|-----------|------|---------|
| `litellm-secrets` | synesis-gateway | `master-key`, `salt-key` | Proxy auth + encryption |
| `litellm-db-credentials` | synesis-gateway | `username`, `password` | Prisma DB connection |
| `provider-api-keys` | synesis-gateway | `OPENROUTER_API_KEY`, etc. | LLM provider credentials |

## Admin UI

LiteLLM ships a built-in admin dashboard for managing models, keys, and spend.

### Accessing the Admin UI

The admin UI is served at the root of the LiteLLM proxy route:

```
https://synesis-api.apps.<cluster-domain>/ui
```

Or via port-forward for local access:

```bash
oc port-forward svc/litellm-proxy -n synesis-gateway 4000:4000
# Then open http://localhost:4000/ui
```

### Logging in

The admin UI requires the **master key** for authentication. Retrieve it:

```bash
oc get secret litellm-secrets -n synesis-gateway \
  -o jsonpath='{.data.master-key}' | base64 -d
```

Use this as the password when prompted. The username field can be anything
(the UI only checks the key).

### What you can do in the Admin UI

- **Models**: View, add, edit, and delete model routing entries. Changes are
  persisted to Postgres via Prisma and take effect immediately.
- **Virtual Keys**: Create API keys with per-key spend limits, model access
  controls, and rate limits.
- **Usage / Spend**: View per-model and per-key cost tracking dashboards.
- **Settings > Provider Keys**: Add or rotate provider API keys (OpenRouter,
  xAI, DeepInfra, etc.) without redeploying.
- **Health**: View model endpoint health status and latency.

### Admin UI via synesis-admin

The Synesis admin service (`synesis-admin`) manages model routing through its **Model Registry**. Operators assign models to pipeline roles in the admin UI, and the **Reconcile** action syncs active assignments to LiteLLM. The "Seed from YAML" action re-bootstraps `model_deployments` from `models.yaml` for fresh deployments or resets.

## Model Routing

### Dynamic mode (default)

Models are stored in Postgres via Prisma. The Synesis admin Model Registry
manages role → model assignments and reconciles them to LiteLLM. Changes
made through the admin UI or via the reconcile API are persisted and survive restarts.

`STORE_MODEL_IN_DB=true` is set in the Helm values.

### Static fallback mode

When Prisma or the database is unavailable, deploy with the static overlay
to define all model routes directly in the LiteLLM ConfigMap:

```bash
SYNESIS_LITELLM_STATIC_FALLBACK=true ./scripts/deploy.sh api
```

This mode:
- Disables the Prisma migration job
- Sets `STORE_MODEL_IN_DB=false`
- Defines all pipeline roles (router, general, critic, coder, summarizer,
  thinking) as static model entries

### Pipeline roles

Runtime model routing is managed through the **admin Model Registry** and reconciled to LiteLLM. The table below shows example role assignments for an OpenRouter/cloud overlay — your cluster will differ based on registry configuration.

| Role | Example Model | Example Provider | Use |
|------|---------------|------------------|-----|
| `synesis-agent` | Synesis planner | Internal | End-user conversations |
| `synesis-router` | Qwen2.5-14B-Instruct | Self-hosted vLLM | Intent classification |
| `synesis-general` | Qwen3-32B FP8 | Self-hosted vLLM | General reasoning |
| `synesis-critic` | DeepSeek R1-Distill-Qwen-32B | Self-hosted vLLM | Answer validation |
| `synesis-coder` | Qwen3-Coder-30B-A3B FP8 | Self-hosted vLLM | Code generation |
| `synesis-summarizer` | Qwen2.5-0.5B-Instruct | CPU / KServe | Conversation summaries |

Cloud overlays (OpenRouter, xAI, DeepInfra) swap self-hosted models for API providers. See [OPENROUTER.md](OPENROUTER.md) for the cloud overlay pattern.

## Database

LiteLLM uses a dedicated `litellm` database on the shared CNPG PostgreSQL
cluster (`synesis-admin-db`). The Helm chart runs a pre-install/pre-upgrade
migration Job that applies Prisma schema migrations before the proxy starts.

### Connection

```
Host:     synesis-admin-db-rw.synesis-admin.svc
Database: litellm
User:     app (from CNPG operator secret)
```

### Reset the database

If the Prisma database needs a clean slate (no historical value in spend/key
data), use the deploy-time flag:

```bash
SYNESIS_RESET_LITELLM_DB=true ./scripts/deploy.sh api
```

This drops and recreates the `litellm` database. Prisma migrations re-run
on the next startup.

## OpenShift Compatibility

The deployment is fully compatible with OpenShift's `restricted-v2` SCC:

| Requirement | How it is met |
|-------------|---------------|
| Non-root execution | `litellm-non_root` image runs as `nobody`; OpenShift assigns arbitrary UID |
| No privilege escalation | `allowPrivilegeEscalation: false` in securityContext |
| Capabilities dropped | `drop: ["ALL"]` |
| Seccomp profile | `RuntimeDefault` |
| Writable paths | Image uses `chgrp -R 0` + `chmod g=u,g+w` (group-0 pattern) |
| Prisma offline | `PRISMA_OFFLINE_MODE=true` — no runtime npm/binary downloads |
| OpenSSL compatibility | Pre-built with `PRISMA_CLI_BINARY_TARGETS="debian-openssl-3.0.x"` |

The only emptyDir volume is `/tmp` (200Mi). All other writable paths are
handled by the image's built-in permissions.

**Do NOT set** `runAsUser`, `fsGroup`, or `readOnlyRootFilesystem` in the
Helm values. OpenShift manages UID assignment via the namespace SCC range,
and the image's group-0 pattern handles write access.

## Monitoring

Prometheus scraping is enabled via pod annotations:

```yaml
prometheus.io/scrape: "true"
prometheus.io/port: "4000"
prometheus.io/path: /metrics
```

Key metrics exposed at `/metrics`:

| Metric | Description |
|--------|-------------|
| `litellm_requests_total` | Total requests by model, status |
| `litellm_request_duration_seconds` | Latency histogram by model |
| `litellm_tokens_total` | Token count by model, direction (prompt/completion) |
| `litellm_spend_total` | Estimated cost in USD by model |
| `litellm_deployment_failure_total` | Failed requests by deployment |

To enable a ServiceMonitor (for the Prometheus Operator):

```yaml
# In values-synesis.yaml
serviceMonitor:
  enabled: true
```

## Production Tuning

### Workers

`numWorkers` controls uvicorn worker count. Match this to your CPU allocation:

| CPU limit | Recommended workers |
|-----------|-------------------|
| 1 | 1 |
| 2 | 2 (current) |
| 4 | 3-4 |
| 8+ | 4-6 (diminishing returns beyond 6) |

Each worker maintains its own Prisma connection pool. With
`database_connection_pool_limit: 10` and 2 workers, expect up to
20 Postgres connections.

### Connection pool sizing

```yaml
general_settings:
  database_connection_pool_limit: 10   # per worker (default 10)
  database_connection_timeout: 60      # seconds
```

For high-throughput deployments, increase the pool limit:

| Concurrent users | Pool limit per worker | Workers | Total connections |
|------------------|-----------------------|---------|-------------------|
| < 50 | 10 | 2 | 20 |
| 50-200 | 20 | 4 | 80 |
| 200+ | 30 | 4-6 | 120-180 |

Ensure your CNPG cluster's `max_connections` can accommodate this plus
connections from admin, planner, and other services.

### Memory and CPU

| Workload | CPU request/limit | Memory request/limit |
|----------|-------------------|---------------------|
| Dev/test (< 10 users) | 250m / 1 | 1Gi / 2Gi |
| Light production (< 50 users) | 500m / 2 | 2Gi / 4Gi (current) |
| Medium production (50-200 users) | 1 / 4 | 4Gi / 8Gi |
| Heavy production (200+ users) | 2 / 4 | 4Gi / 8Gi |

LiteLLM is mostly I/O-bound (waiting on upstream LLM APIs). CPU spikes
occur during request parsing, token counting, and response streaming.
Memory grows with concurrent streaming connections.

### Scaling replicas

For horizontal scaling, increase `replicaCount`. Each replica is stateless
(model config is in Postgres, not in memory). All replicas share the same
Prisma database.

```yaml
replicaCount: 3
numWorkers: 2
```

This gives 6 effective workers across 3 pods. Use a PodDisruptionBudget
for zero-downtime upgrades:

```yaml
pdb:
  enabled: true
  minAvailable: 1
```

### Request timeout

The default `request_timeout: 300` (5 minutes) accommodates long reasoning
model responses (DeepSeek R1, etc.). For latency-sensitive deployments,
consider per-model timeouts in the model config rather than lowering the
global default.

### Retries

`num_retries: 2` means up to 3 total attempts per request. LiteLLM
retries on transient HTTP errors (429, 500, 503) with exponential backoff.
For cost-sensitive deployments, set `num_retries: 0` to avoid duplicate
charges on long-running completions.

### Gateway-only reliability checklist

When LiteLLM is the single resilience layer (recommended), validate these per
release:

1. Every active served model has an explicit fallback chain in the admin model registry.
2. `num_retries` and `request_timeout` are set intentionally for the deployment profile.
3. `/health` shows expected healthy endpoints after rollouts.
4. `/metrics` emits `litellm_deployment_failure_total` and request/latency counters.
5. Planner/admin point to the same LiteLLM base URL and environment.

### Rate limiting

Rate limits are managed via virtual keys in the Admin UI. Create a key
with limits:

```bash
curl -X POST https://synesis-api.apps.<cluster>/key/generate \
  -H "Authorization: Bearer <master-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["synesis-general", "synesis-thinking"],
    "max_budget": 10.00,
    "tpm_limit": 100000,
    "rpm_limit": 60
  }'
```

### Resilience

The `allow_requests_on_db_unavailable: true` setting keeps the proxy
serving requests even if Postgres goes down. Models loaded from the
ConfigMap (bootstrap list) remain available; only dynamic model updates
and spend tracking are paused until the DB reconnects.

## Troubleshooting

### Check pod status

```bash
oc get pods -n synesis-gateway
oc logs -f deployment/litellm-proxy -n synesis-gateway
```

### Verify Prisma connectivity

Healthy startup shows:

```
Using cached Prisma CLI at /app/.cache/prisma-python/binaries/node_modules/.bin/prisma
prisma migrate deploy completed
query-engine ac9d7041ed77bcc8a8dbd2ab6616b39013829574
Application startup complete.
```

If you see `NotConnectedError`, check:
1. Database exists: `oc exec` into the CNPG primary and run `\l` to list databases
2. Credentials: `oc get secret litellm-db-credentials -n synesis-gateway -o yaml`
3. Network policy: ensure synesis-gateway can reach synesis-admin namespace

### Verify model routing

```bash
# List registered models
curl -s http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/model/info \
  -H "Authorization: Bearer $(oc get secret litellm-secrets -n synesis-gateway -o jsonpath='{.data.master-key}' | base64 -d)" \
  | python3 -m json.tool

# Health check (no auth required)
curl http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/health/readiness
```

### Helm release status

```bash
helm status litellm-proxy -n synesis-gateway
helm history litellm-proxy -n synesis-gateway
oc get jobs -n synesis-gateway   # migration job status
```

### Emergency: switch to static fallback

If Prisma is down and the proxy can't load models from DB:

```bash
SYNESIS_LITELLM_STATIC_FALLBACK=true ./scripts/deploy.sh api
```

This layers `values-synesis-static.yaml` on top, defining all models in the
ConfigMap and disabling the migration job. Revert by running deploy without
the flag.

## Version Pinning Policy

LiteLLM deployment artifacts are pinned to specific versions to mitigate
supply-chain attacks.

| Artifact | Pinned in | Current version | Override env var |
|----------|-----------|-----------------|------------------|
| Container image tag | `values-synesis.yaml` | `main-v1.82.3-stable` | Edit values file |
| Helm chart version | `scripts/deploy.sh` | `1.82.3-stable.patch.2` | `SYNESIS_LITELLM_CHART_VERSION` |

### Upgrade procedure

1. Verify the new release on the [GitHub releases page](https://github.com/BerriAI/litellm/releases) (never trust PyPI alone).
2. Update the image `tag` in `base/gateway/helm/values-synesis.yaml`.
3. Update the default chart version in `scripts/deploy.sh` (or set `SYNESIS_LITELLM_CHART_VERSION`).
4. Run `./scripts/deploy.sh api` and verify pod health.

### What NOT to do

- Do not use `main-stable`, `latest`, or any other floating tag.
- Do not install `litellm` as a PyPI package in any Synesis application
  image (planner, admin, indexer, yarn). See `ml-service-boundary` rule.
- Do not pull the Helm chart without `--version`.

## Supply-Chain Security

### Background

In March 2026, the `litellm` PyPI package was compromised via maintainer
account hijack ([GitHub #24518](https://github.com/BerriAI/litellm/issues/24518)).
Versions 1.82.7 and 1.82.8 contained credential-stealing malware. The
Trivy scanner ecosystem was also temporarily compromised around the same
time ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).

### Synesis exposure

Synesis does **not** install `litellm` as a Python package. LiteLLM runs
as a standalone container image pulled from `ghcr.io` (GitHub Container
Registry), built by BerriAI's GitHub Actions CI. The compromised PyPI
versions were never published through GitHub CI, so the container images
were not affected. Nevertheless, we pin all artifacts to prevent drift.

### CI guardrails

The `supply-chain-guard` job in `.github/workflows/security.yml` runs on
every push and PR. It fails if any of the following are detected:

- Compromised LiteLLM PyPI versions (`1.82.7`, `1.82.8`) in lockfiles or requirements
- Known IOC strings (`litellm_init.pth`, `models.litellm.cloud`)
- Mutable LiteLLM image tags (`main-stable`, `latest`) in gateway manifests
- Mutable CI action refs (`@master`, `@main`) for `trivy-action`

### Incident response checklist

If a new supply-chain compromise is discovered:

1. **Block**: Add compromised versions/IOCs to the `supply-chain-guard` job.
2. **Audit**: Check running pod image digests against known-safe digests:
   ```bash
   oc get pod -n synesis-gateway -o jsonpath='{.items[*].status.containerStatuses[*].imageID}'
   ```
3. **Rotate**: Treat all secrets on affected systems as compromised and rotate immediately.
4. **Pin**: Update image tag and chart version to the last verified-safe release.
5. **Verify**: Inspect container for IOC artifacts:
   ```bash
   oc exec -n synesis-gateway deploy/litellm-proxy -- \
     find /app -name 'litellm_init.pth' -o -name '*.pth' 2>/dev/null
   ```
