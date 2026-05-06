# Helm install and setup

This guide installs Synesis from the repo-local Helm chart at
`charts/synesis`. The chart is values-driven so the same release can use cloud
services or in-cluster operator-managed services. The shared chart supports
OpenShift, AKS, EKS, GKE, and generic Kubernetes through provider values.

## Platform choices

Set the provider explicitly for managed Kubernetes:

```yaml
global:
  provider: aks        # openshift | aks | eks | gke | kubernetes | auto
  openshift: false    # compatibility switch; set false off OpenShift
```

`global.provider=auto` performs best-effort detection using available API
groups and Kubernetes version metadata. Helm cannot reliably distinguish every
managed service, so production AKS/EKS/GKE installs should set the provider.

Provider-aware behavior:

- OpenShift: renders `Route` resources when `routes.enabled=true`.
- AKS/EKS/GKE/generic Kubernetes: renders `Ingress` resources when
  `ingress.enabled=true`.
- Storage defaults come from `platform.<provider>.storageClass` when PVC or
  CloudNativePG storage classes are not set explicitly.
- OLM subscriptions are controlled by `operators.installWithOLM`; set it false
  on AKS/EKS/GKE unless OLM is installed and intentionally managed by Helm.

## Backend choices

Postgres:

- `postgres.mode=external` uses a cloud or externally managed Postgres service.
- `postgres.mode=cloudnativepg` creates CloudNativePG `Cluster` resources for
  Synesis Admin, Keycloak, and OpenFGA.
- `postgres.mode=azureFlexible` uses Azure Database for PostgreSQL Flexible
  Server and generates SSL-enabled URLs.

KV:

- `kv.mode=external` uses a managed Redis-compatible or Valkey service.
- `kv.mode=redkey` creates a configurable Valkey/RedKey-style custom resource
  and stores the Redis-compatible URL in Secret `synesis-redis`.
- `kv.mode=azureRedis` generates a TLS `rediss://` URL for Azure Cache for
  Redis.

Synesis does not deploy Redis. The app still uses `redis://` URLs because Valkey
and RedKey-compatible servers use the same client protocol and URI scheme.

## Prerequisites

- Kubernetes or OpenShift cluster.
- `helm` and `kubectl` or `oc`.
- Container registry access for the Synesis images.
- Provider keys for any hosted model providers you enable, for example
  `OPENROUTER_API_KEY`.
- For OpenShift routes, a real route domain and hostnames for API, admin, chat,
  coder, and Keycloak.

For in-cluster backends, the required operators must be installed before the
chart applies their custom resources:

- CloudNativePG for `postgres.mode=cloudnativepg`.
- Red Hat build of Keycloak operator for `keycloak.enabled=true`.
- Your selected Valkey/RedKey operator for `kv.mode=redkey` with
  `kv.redkey.createCustomResource=true`.

The chart can render OLM `Subscription` resources for those operators, but a
single first-time Helm install cannot depend on CRDs created later in that same
release. For a new cluster, either preinstall the operators or run a two-pass
install.

## Create values

Start with a local values file:

```bash
cp charts/synesis/values.yaml my-synesis-values.yaml
```

At minimum, change:

- `global.routeDomain`
- `routes.items.*.host`
- `ingress.items.*.host` when deploying outside OpenShift
- `keycloak.publicUrl`
- `keycloak.adminUrl`
- `keycloak.realmImport.*RedirectUris`
- `keycloak.realmImport.*WebOrigins`
- every placeholder under `secrets`
- Postgres passwords or external Postgres connection details
- `kv.redkey.url` or `kv.external.url`

## Option A: AKS with Azure managed services

Start from the AKS example:

```bash
cp charts/synesis/examples/values-aks-azure-managed.yaml my-aks-values.yaml
```

Important fields:

```yaml
global:
  provider: aks
  openshift: false

operators:
  installWithOLM: false
  cloudnativepg:
    enabled: false
  redkey:
    enabled: false

postgres:
  mode: azureFlexible
  azureFlexible:
    host: synesis-postgres.postgres.database.azure.com
    sslmode: require
    admin:
      username: app
      password: replace-me

kv:
  mode: azureRedis
  azureRedis:
    host: synesis-cache.redis.cache.windows.net
    port: 6380
    password: replace-me
    tls: true

ingress:
  enabled: true
  className: webapprouting.kubernetes.azure.com
```

The AKS example also sets Keycloak `additionalOptions` with
`db-url-properties=?sslmode=require` so the Red Hat build of Keycloak can reach
Azure PostgreSQL over SSL, and sets `keycloak.operatorIngress.enabled=false`
because the chart-owned Kubernetes Ingress exposes Keycloak. The Keycloak
operator/CRDs must already exist on non-OpenShift clusters, or
`keycloak.enabled` must be disabled and an external issuer wired in separately.

Install:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-aks-values.yaml
```

## Option B: external cloud services

Use this when Postgres and KV are managed outside the cluster.

```yaml
postgres:
  mode: external
  external:
    admin:
      host: postgres.example.com
      port: 5432
      database: synesis_admin
      username: app
      password: replace-me
      sslmode: require
    keycloak:
      host: postgres.example.com
      port: 5432
      database: keycloak
      username: app
      password: replace-me
    openfga:
      host: postgres.example.com
      port: 5432
      database: openfga
      username: openfga
      password: replace-me
      sslmode: require

kv:
  mode: external
  external:
    url: redis://managed-valkey.example.com:6379/3

operators:
  cloudnativepg:
    enabled: false
  redkey:
    enabled: false
```

Install:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml
```

EKS and GKE starting points are available at:

- `charts/synesis/examples/values-eks-external.yaml`
- `charts/synesis/examples/values-gke-external.yaml`

## Option C: in-cluster CloudNativePG and RedKey/Valkey

Use this when the cluster should run Postgres and KV services.

Preinstall or enable the required operators. If your platform team already
manages them, disable the corresponding `operators.*.enabled` values and keep
the CR sections enabled.

```yaml
postgres:
  mode: cloudnativepg
  cloudnativepg:
    admin:
      password: replace-me
    keycloak:
      password: replace-me
    openfga:
      password: replace-me

kv:
  mode: redkey
  redkey:
    createCustomResource: true
    apiVersion: cache.cs.sap.com/v1alpha1
    kind: Valkey
    name: synesis-valkey
    url: redis://synesis-valkey.synesis-rag.svc.cluster.local:6379/3
    spec:
      replicas: 1
      sentinel:
        enabled: false
      metrics:
        enabled: true
      tls:
        enabled: false
```

Install:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml
```

## Two-pass operator bootstrap

For a brand-new OpenShift cluster where you want this chart to create OLM
subscriptions, run operators first, wait for CRDs, then install Synesis.

Create `operators-only-values.yaml`:

```yaml
postgres:
  mode: external

kv:
  mode: external
  redkey:
    createCustomResource: false

keycloak:
  enabled: false

litellm:
  enabled: false

routes:
  enabled: false

persistence:
  webui:
    enabled: false
  nornicdb:
    enabled: false

workloads:
  admin: { enabled: false }
  plannerTs: { enabled: false }
  yarn: { enabled: false }
  mcpTs: { enabled: false }
  adminMcpTs: { enabled: false }
  webui: { enabled: false }
  search: { enabled: false }
  nornicdb: { enabled: false }
  embedder: { enabled: false }
  keywordService: { enabled: false }
  preprocessService: { enabled: false }
  spamService: { enabled: false }
  glinerService: { enabled: false }
  openfga: { enabled: false }
```

Apply subscriptions with the same release name you will use for the final
install. Keeping the release name the same avoids Helm ownership conflicts on
resources created during the bootstrap pass.

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml \
  -f operators-only-values.yaml
```

Wait for the CRDs you need:

```bash
kubectl get crd clusters.postgresql.cnpg.io
kubectl get crd keycloaks.k8s.keycloak.org
kubectl get crd keycloakrealmimports.k8s.keycloak.org
```

Also wait for your selected Valkey/RedKey CRD if using `kv.mode=redkey`.

Then upgrade the same release to the full stack:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml
```

## Validate before applying

Render and lint locally:

```bash
helm lint ./charts/synesis
helm template synesis ./charts/synesis -f my-synesis-values.yaml >/tmp/synesis.yaml
```

For server-side schema checks:

```bash
kubectl apply --dry-run=server -f /tmp/synesis.yaml
```

If CRDs are not installed yet, server-side dry-run will fail on those custom
resources. Install or disable the relevant operator-backed resources first.

## Verify the install

Check pods:

```bash
kubectl get pods -n synesis-admin
kubectl get pods -n synesis-auth
kubectl get pods -n synesis-authz
kubectl get pods -n synesis-gateway
kubectl get pods -n synesis-planner
kubectl get pods -n synesis-rag
kubectl get pods -n synesis-webui
kubectl get pods -n synesis-yarn
```

Check backend custom resources when using in-cluster services:

```bash
kubectl get cluster -n synesis-admin
kubectl get cluster -n synesis-auth
kubectl get cluster -n synesis-authz
kubectl get keycloak -n synesis-auth
```

On OpenShift, check routes:

```bash
oc get route -A | grep synesis
```

## First admin login

After Keycloak and the `synesis` realm are ready:

1. Open the Keycloak admin console.
2. Select realm `synesis`.
3. Create a user for the Synesis administrator.
4. Assign realm role `synesis-admin`.
5. Assign `synesis-user` if the user should also use chat.
6. Open the Synesis Admin route and sign in with that realm user.

See [admin/KEYCLOAK_BOOTSTRAP.md](admin/KEYCLOAK_BOOTSTRAP.md) for the detailed
Keycloak role and login flow.

## Upgrade

Update values or image tags, then run:

```bash
helm upgrade synesis ./charts/synesis -f my-synesis-values.yaml
```

For production, set operator subscriptions to manual approval or manage
operators outside this chart so database and Keycloak operator upgrades are
reviewed before rollout.

## Uninstall

```bash
helm uninstall synesis
```

Persistent volumes, external databases, and OLM-installed operators may remain
after uninstall. Review PVCs and operator subscriptions before deleting data.
