# Synesis Helm Chart

This chart bootstraps the Synesis control plane, identity provider, data plane,
and Redis-compatible KV dependency with values-driven backend choices across
OpenShift, AKS, EKS, GKE, and generic Kubernetes.

## Platform Model

The chart keeps shared Kubernetes resources in common templates and switches
platform-specific behavior through values:

- `global.provider`: `openshift`, `aks`, `eks`, `gke`, `kubernetes`, or `auto`.
- `routes.enabled`: OpenShift `Route` resources.
- `ingress.enabled`: standard Kubernetes `Ingress` resources for AKS/EKS/GKE.
- `platform.storage.*`: provider-aware storage class defaults.
- `operators.installWithOLM`: controls OpenShift OLM `Subscription` rendering.

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
  and writes the Redis-compatible connection URL to the `synesis-redis` Secret.
- `kv.mode=external` writes your managed Redis-compatible/Valkey URL to the
  same `synesis-redis` Secret.
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

## Production Notes

Replace every placeholder in `secrets.*` and `postgres.*.password` before
production use.

If you set an operator `installPlanApproval` to `Manual`, approve the install
plan before expecting CRs such as `Cluster`, `Keycloak`, or `Valkey` to
reconcile.
