# Synesis Helm Chart

This chart bootstraps the Synesis API-mode control plane, identity provider,
RAG data plane, coder services, and Redis-compatible KV dependency with
values-driven backend choices across OpenShift, AKS, EKS, GKE, and generic
Kubernetes. API mode means hosted/external model providers are called directly
from Planner using Admin registry routes; the
chart does not render RHOAI, KServe, vLLM, GPU, or model PVC resources.

## Platform Model

The chart keeps shared Kubernetes resources in common templates and switches
platform-specific behavior through values:

- `global.provider`: `openshift`, `aks`, `eks`, `gke`, `kubernetes`, or `auto`.
- `routes.enabled`: OpenShift `Route` resources.
- `ingress.enabled`: standard Kubernetes `Ingress` resources for AKS/EKS/GKE.
- `cloudflared.enabled`: optional Cloudflare Tunnel connector that can reuse
  `ingress.items` as tunnel ingress rules.
- `platform.storage.*`: provider-aware storage class defaults.
- `operators.installWithOLM`: controls OpenShift OLM `Subscription` rendering.
- `operators.customResources.create`: controls rendering for operator-backed
  custom resources such as CloudNativePG `Cluster`, Keycloak, and Valkey.
- `registryCredentials`: optional chart-managed GHCR pull secret, replacing
  the old bootstrap script credential step.
- `jobs.indexer.contentPacks`: enabled by default and claims admin-queued
  Synesis RAG content pack installs. Other indexer jobs remain suspended unless
  explicitly enabled for scheduled ingestion.
- `nornicdb.auth`: chart-managed username/password Secret for NornicDB server
  and client pods. Set `secrets.nornicdbPassword` to pin or rotate the password;
  otherwise Helm generates one on first install and reuses the existing Secret.
- `jobs.qualityRunner`: optional quality CronJob, disabled by default so a
  plain install does not run quality scans until enabled.

`global.provider=auto` does best-effort detection from cluster API/version
metadata. Helm cannot reliably identify every managed Kubernetes distribution,
so production AKS/EKS/GKE installs should set `global.provider` explicitly.

## Backend Modes

Postgres:

- `postgres.mode=cloudnativepg` creates CloudNativePG `Cluster` resources for
  Synesis Admin, Keycloak, and OpenFGA.
- `postgres.mode=external` points Synesis at a cloud or externally managed
  Postgres service.
- `postgres.mode=azureFlexible` builds connection strings for Azure Database
  for PostgreSQL Flexible Server.

KV:

- `kv.mode=redkey` creates a configurable Valkey/RedKey-style custom resource
  and writes the Redis-compatible connection URL to `synesis-redis` Secrets in
  the RAG, planner, and Yarn namespaces.
- `kv.mode=external` writes your managed Redis-compatible/Valkey URL to the
  same namespace-local `synesis-redis` Secrets.
- `kv.mode=azureRedis` builds a TLS `rediss://` URL for Azure Cache for Redis.

The application still uses `redis://` connection strings because Valkey and
RedKey-compatible servers use the same wire protocol and client URI scheme.

## Operators

The chart can create OpenShift OLM `Subscription` resources for:

- CloudNativePG (`operators.cloudnativepg`)
- Red Hat build of Keycloak (`operators.keycloak`)
- RedKey/Valkey-compatible operator (`operators.redkey`)

Disable those blocks when the operators are already managed by your platform
team or by GitOps:

```yaml
operators:
  installWithOLM: false
  cloudnativepg:
    enabled: false
  keycloak:
    enabled: false
  redkey:
    enabled: false
```

On a brand-new OLM cluster, keep `operators.customResources.create=auto`. Helm
cannot render custom resources from CRDs that OLM has not registered yet. For
Keycloak, `keycloak.deferredBootstrap.enabled=true` adds a post-install hook
that waits for the Keycloak CRDs, applies `Keycloak` and
`KeycloakRealmImport`, and waits for the realm import before the install
completes. When `postgres.mode=cloudnativepg`, the same hook also waits for
CloudNativePG and applies the Keycloak database resources first. Azure and
external Postgres modes use the configured database connection instead. Use a
longer first-install timeout, for example `helm upgrade --install ... --timeout
30m`.

If the deferred hook is disabled, rerun the same `helm upgrade --install`
command after OLM installs the CRDs. Set `operators.customResources.create=always`
only when the CRDs are already managed outside this chart or when you
intentionally want offline rendering.

## Examples

CloudNativePG plus in-cluster Valkey/RedKey operator CR:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-values.yaml
```

Managed Postgres and managed KV:

```yaml
postgres:
  mode: external
  external:
    admin:
      host: my-postgres.example.com
      database: synesis_admin
      username: app
      password: replace-me
      sslmode: require
    keycloak:
      host: my-postgres.example.com
      database: keycloak
      username: app
      password: replace-me
    openfga:
      host: my-postgres.example.com
      database: openfga
      username: openfga
      password: replace-me
      sslmode: require

kv:
  mode: external
  external:
    url: redis://managed-valkey.example.com:6379/3
```

AKS with Azure managed Postgres and Redis:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f charts/synesis/examples/values-aks-azure-managed.yaml \
  -f my-secrets.yaml
```

EKS and GKE examples are available under `charts/synesis/examples/`.

Cloudflare Tunnel instead of cloud-provider ingress, using the token Cloudflare
shows for Docker/Kubernetes:

```bash
kubectl -n synesis-gateway create secret generic cloudflared-credentials \
  --from-literal=token='<token-from-cloudflare>'

helm upgrade --install synesis ./charts/synesis \
  -f charts/synesis/examples/values-eks-external.yaml \
  --set ingress.enabled=false \
  --set cloudflared.enabled=true \
  --set cloudflared.tunnel.mode=token \
  --set cloudflared.tunnel.existingSecret=true
```

Token mode is for remotely-managed tunnels. Configure the tunnel's public
hostnames and service URLs in Cloudflare, for example
`http://synesis-admin.synesis-admin.svc.cluster.local:8080`. The chart renders
`TUNNEL_TOKEN` and runs `cloudflared tunnel ... run`, matching Cloudflare's
Docker/Kubernetes bootstrap path.

For locally-managed tunnel config, use credentials mode:

```bash
kubectl -n synesis-gateway create secret generic cloudflared-credentials \
  --from-file=credentials.json=/path/to/<tunnel-id>.json
```

```yaml
cloudflared:
  enabled: true
  tunnel:
    mode: credentials
    id: <tunnel-id>
    existingSecret: true
```

In credentials mode, the chart renders a separate `cloudflared` Deployment and
maps each `ingress.items.*.host` to its internal Kubernetes service. Keep
`ingress.items.*.originPort` numeric, or set
`ingress.items.*.cloudflared.serviceUrl` for custom origins. Tunnel credentials
must be provided inline or explicitly marked as an existing Secret; otherwise
Helm fails before creating broken pods.

Inline credentials for credentials mode are safest in a values file:

```yaml
cloudflared:
  enabled: true
  tunnel:
    mode: credentials
    id: <tunnel-id>
    credentials:
      AccountTag: <account-tag>
      TunnelSecret: <tunnel-secret>
      TunnelID: <tunnel-id>
```

Avoid passing raw JSON with `--set`; Helm can parse JSON-like values as lists or
maps. Use a values file, or escape the value carefully.

## Production Notes

Replace every placeholder in `secrets.*` and `postgres.*.password` before
production use. `secrets.nornicdbPassword` may be left empty for Helm-managed
generation, or set explicitly during planned credential rotation.

Provider-backed role mappings (`synesis-router`, `synesis-planner`,
`synesis-writer`, `synesis-ambiguity-scorer`, `synesis-critic`, coder tiers,
summarizer, and enrichment roles) are seeded into the Admin database on first
startup. Planner and Yarn read those Admin registry routes directly. Change role
providers/models in Admin rather than editing Helm model lists.

The content-pack installer is enabled by default. To enable the broader queued
indexer and quality jobs:

```yaml
jobs:
  indexer:
    enabled: true
    queue:
      suspend: false
  qualityRunner:
    enabled: true
```

For `cloudflared`, two replicas provide availability. Avoid autoscaling
cloudflared pods because downscaling can interrupt active tunnel connections.

If you set an operator `installPlanApproval` to `Manual`, approve the install
plan before expecting CRs such as `Cluster`, `Keycloak`, or `Valkey` to
reconcile.
