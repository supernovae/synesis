# Helm install and setup

This guide installs Synesis from the repo-local Helm chart at
`charts/synesis`. The chart is values-driven so the same release can use cloud
services or in-cluster operator-managed services.

## Backend choices

Postgres:

- `postgres.mode=external` uses a cloud or externally managed Postgres service.
- `postgres.mode=cloudnativepg` creates CloudNativePG `Cluster` resources for
  Synesis Admin, Keycloak, and OpenFGA.

KV:

- `kv.mode=external` uses a managed Redis-compatible or Valkey service.
- `kv.mode=redkey` creates a configurable Valkey/RedKey-style custom resource
  and stores the Redis-compatible URL in Secret `synesis-redis`.

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
- `keycloak.publicUrl`
- `keycloak.adminUrl`
- `keycloak.realmImport.*RedirectUris`
- `keycloak.realmImport.*WebOrigins`
- every placeholder under `secrets`
- Postgres passwords or external Postgres connection details
- `kv.redkey.url` or `kv.external.url`

## Option A: external cloud services

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

## Option B: in-cluster CloudNativePG and RedKey/Valkey

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
