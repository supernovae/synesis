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
  and stores the Redis-compatible URL in namespace-local `synesis-redis`
  Secrets for RAG, planner, and Yarn.
- `kv.mode=azureRedis` generates a TLS `rediss://` URL for Azure Cache for
  Redis.

Synesis does not deploy Redis. The app still uses `redis://` URLs because Valkey
and RedKey-compatible servers use the same client protocol and URI scheme.

## Prerequisites

- Kubernetes or OpenShift cluster.
- `helm` and `kubectl` or `oc`.
- Container registry access for the Synesis images.
- Provider API keys for hosted model providers. Configure these after install
  in Admin -> Providers & API keys; use Helm bootstrap values only when your
  platform requires non-interactive first boot.
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
release. By default `operators.customResources.create=auto` defers those
custom resources until Helm discovery can see the CRDs, so a new cluster can
create subscriptions first and then create CRs on the next upgrade. For a clean
bootstrap with no dependent workloads starting early, preinstall the operators
or run the operators-only two-pass flow below.

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

## Secrets and provider keys

Helm owns deployment bootstrap secrets and namespace-local runtime Secrets. Use
your values file for infrastructure credentials and service tokens that must
exist before the Admin service starts.

| Secret | Namespace(s) | Source of truth | Purpose |
|--------|--------------|-----------------|---------|
| `synesis-internal-service-auth` | Synesis service namespaces | Helm `secrets.internalServiceToken` | Service-to-service bearer token |
| `webui-api-key` | `synesis-webui` | Helm `secrets.webuiSecretKey` | Open WebUI secret/API key used for planner authentication |
| `synesis-admin-session-token-key` | `synesis-admin` | Helm generated or `secrets.adminSessionTokenKey` | Admin session signing key |
| `synesis-pat-pepper` | Admin, planner, Yarn namespaces | Helm generated or `secrets.patPepper` | Personal access token hashing pepper |
| `synesis-admin-db-url` | Admin, planner, Yarn namespaces | Helm Postgres values | Admin and trace database URLs |
| `synesis-redis` | RAG, planner, Yarn namespaces | Helm KV values | Redis/Valkey URL |
| `synesis-nornicdb-auth` | Admin, planner, RAG namespaces | Helm generated or `secrets.nornicdbPassword` | NornicDB credentials |
| `provider-api-keys` | Gateway, planner, Yarn namespaces | Admin -> Providers & API keys | Hosted model provider credentials |

Provider API keys are intentionally separate from normal deployment secrets.
The chart creates the `provider-api-keys` Secret so planner and Yarn can mount
it, but the default `secrets.providerApiKeys` value is empty. Add and rotate
provider keys in Admin -> Providers & API keys; the Admin backend updates the
Secret and refreshes direct runtime consumers.

Use `secrets.providerApiKeys` only for intentional bootstrap automation. Values
placed there are Helm-managed and can be reconciled back onto the cluster on
future `helm upgrade` runs.

Personal access tokens (`syn-*`) are application data in Postgres, not
Kubernetes Secrets. They are not changed by Helm upgrades.

Admin archive storage is configured on the Admin API deployment. Set
`SYNESIS_ADMIN_ARCHIVE_S3_BUCKET` plus optional
`SYNESIS_ADMIN_ARCHIVE_S3_PREFIX` and
`SYNESIS_ADMIN_ARCHIVE_S3_ENDPOINT_URL`; provide credentials with workload
identity, IRSA, or the cluster's normal S3-compatible credential mechanism. See
[admin archive storage](admin/ADMIN_ARCHIVE_STORAGE.md).

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
  customResources:
    create: auto
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
subscriptions, run operators first, wait for CRDs, then install Synesis. This
keeps application workloads from starting before their databases and Keycloak
custom resources exist. If you skip this operators-only pass, the default
`operators.customResources.create=auto` still prevents Helm from failing on
missing CRDs. Keycloak can also complete in that first install through the
deferred bootstrap hook described below.

Create `operators-only-values.yaml`:

```yaml
postgres:
  mode: external

kv:
  mode: external
  redkey:
    createCustomResource: false

operators:
  customResources:
    create: never

keycloak:
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

If the operators are installed outside this chart and Helm discovery already
sees the CRDs, the default `auto` mode renders the custom resources. For
offline `helm template` output, pass the CR APIs with `--api-versions` or set
`operators.customResources.create=always`.

## Single-pass Keycloak bootstrap

Helm cannot render `Keycloak` or `KeycloakRealmImport` normally until the
operator CRDs exist. With the default `keycloak.deferredBootstrap.enabled=true`,
the chart renders a post-install/post-upgrade Job when those CRDs are missing.
The Job waits for OLM, applies the CloudNativePG database resources when
`postgres.mode=cloudnativepg`, applies the Keycloak resources, then waits for
Keycloak and the realm import to report ready.

Use a first-install timeout long enough for OLM, database startup, and Keycloak:

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml \
  --timeout 30m
```

For a seeded first login account in realm `synesis`, provide an explicit
temporary password:

```yaml
keycloak:
  realmImport:
    bootstrapAdmin:
      enabled: true
      username: synesis-admin
      email: admin@example.com
      password: replace-me-temporary-password
      temporaryPassword: true
```

Helm notes print the username and a `kubectl get secret` command for retrieving
the bootstrap password. Rotate or replace this account after first login; the
password is necessarily present in the one-time `KeycloakRealmImport` spec.

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

## Production safety defaults

The chart is intended to make unsafe production renders fail before anything is
applied:

- `global.imageTag` and enabled workload image tags must not be `latest`.
- Required bootstrap secrets such as `secrets.internalServiceToken`,
  `secrets.webuiSecretKey`, `secrets.openfgaAuthToken`, and Postgres passwords
  must be non-placeholder values.
- `global.allowInsecureDefaults=true` is only for disposable local/demo renders.

Production-facing auth and authorization defaults are set in chart values:

- Planner bearer auth is required with
  `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH=true`.
- Forwarded identity is trusted only when the request bearer matches the
  internal service token.
- `SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE=true` rejects untrusted
  forwarded identity headers.
- `SYNESIS_RAG_AUTHZ_MODE=enforce` enables RAG authorization enforcement.
- `SYNESIS_REQUIRE_PAT_PEPPER=true` and `SYNESIS_PAT_PEPPER` are set on
  services that validate personal access tokens.
- `SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER=false` and
  `SYNESIS_YARN_ALLOW_OPAQUE_BEARER=false` keep public entrypoints on PAT or
  OIDC identities.

Before exposing a release, validate the rendered manifests with your production
values:

```bash
helm template synesis ./charts/synesis -f my-synesis-values.yaml >/tmp/synesis.yaml
rg -n 'SYNESIS_RAG_AUTHZ_MODE|SYNESIS_.*ALLOW_OPAQUE_BEARER|SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH' /tmp/synesis.yaml
kubectl apply --dry-run=server -f /tmp/synesis.yaml
```

The `rg` output should show `SYNESIS_RAG_AUTHZ_MODE=enforce`,
`SYNESIS_*_ALLOW_OPAQUE_BEARER=false`, and
`SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH=true`. Use
`docs/CLOUDFLARE_EDGE_HARDENING.md` or your ingress controller's rate-limit
annotations for internet-facing edge throttling.

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
