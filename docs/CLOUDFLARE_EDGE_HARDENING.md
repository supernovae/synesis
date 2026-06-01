# Cloudflare Edge Hardening Guide

This guide provides a practical baseline for exposing Synesis services to the public internet behind Cloudflare.

It complements in-cluster controls (NetworkPolicy, service auth tokens, RBAC). Keep both.

## Target Surface

Recommended host split:

- `api.<your-domain>` -> Synesis planner-ts (`/v1/*`)
- `admin.<your-domain>` -> Synesis admin UI/API
- `chat.<your-domain>` -> Open WebUI
- `auth.<your-domain>` -> Keycloak
- `coder.<your-domain>` -> Synesis Yarn UI/API

Keep internal-only services private (no public DNS/route):

- Planner internal service URL
- Yarn internal service URL
- RAG microservices (`embedder`, `keyword-service`, `preprocess-service`, `spam-service`)
- Admin worker/control-plane endpoints (`/api/v1/ingestion/staged/*`, internal ingestion claim/status/sync endpoints)

## Baseline Cloudflare Settings

For each public host:

1. **DNS**
   - Use proxied records (orange cloud).
2. **SSL/TLS**
   - Mode: `Full (strict)`
   - Minimum TLS: `1.2` (prefer `1.3`)
   - Enable `Always Use HTTPS`.
3. **HTTP Security**
   - Enable HSTS (start with low max-age, then raise).
   - Enable `X-Content-Type-Options: nosniff`.
   - Enable `Referrer-Policy: no-referrer` or `strict-origin-when-cross-origin`.
4. **WAF**
   - Enable Cloudflare Managed Ruleset (default action: block/challenge where appropriate).
5. **Bot Protection**
   - Enable Bot Fight Mode or Super Bot Fight Mode (if plan supports it).

## Recommended Cloudflare Rules (Examples)

Adjust hostnames to your environment.

### 1) Block internal control-plane paths from internet

Create a custom WAF rule:

- **Expression**
  - `(http.host eq "admin.example.com" and starts_with(http.request.uri.path, "/api/v1/ingestion/staged/"))`
- **Action**
  - `Block`

Add a second rule for non-staged internal queue APIs:

- **Expression**
  - `(http.host eq "admin.example.com" and http.request.uri.path in {"/api/v1/ingestion/items/claim" "/api/v1/ingestion/schema-sync"} )`
- **Action**
  - `Block`

### 2) Block metrics and docs on public edge

- **Expression**
  - `(http.host eq "admin.example.com" and (http.request.uri.path eq "/metrics" or starts_with(http.request.uri.path, "/api/docs") or starts_with(http.request.uri.path, "/api/openapi")))`
- **Action**
  - `Block`

### 3) Lock down admin to trusted users/IPs

Prefer Cloudflare Access for `admin.example.com`.

If Access is not available, use a temporary IP allowlist rule:

- **Expression**
  - `(http.host eq "admin.example.com" and not ip.src in {203.0.113.10 198.51.100.0/24})`
- **Action**
  - `Block`

### 4) Rate limit auth/token endpoints

Create rate limiting rules for:

- `POST /api/v1/auth/oauth/token`
- `POST /api/v1/auth/oauth/refresh`

Suggested starting threshold:

- `10 requests / 1 minute / IP` -> managed challenge or block for 10 minutes.

### 5) Rate limit chat completions

For public API host:

- Endpoint: `POST /v1/chat/completions`
- Start with `60 requests / minute / IP` (tune to your workload and tenants).

## Cloudflare Access (Recommended for Admin)

Protect `admin.<your-domain>` with Access policies:

- Require IdP login (Keycloak/Okta/Google/etc.)
- Require MFA
- Limit by email domain/group
- Optional: require device posture

This prevents direct unauthenticated exposure even before app auth is evaluated.

## CORS and Origin Hygiene

- Keep app `SYNESIS_CORS_ORIGINS` strict (no broad wildcard origins in production).
- At Cloudflare, avoid adding permissive response header overrides.
- Ensure browser-facing hosts do not expose internal API origins.

## Verification Checklist

After rollout, verify:

1. `GET https://admin.<domain>/metrics` returns blocked/challenged.
2. `GET https://admin.<domain>/api/docs` is blocked unless intentionally enabled.
3. `POST https://admin.<domain>/api/v1/ingestion/staged/items/claim-fetch` is blocked at edge.
4. Planner trusted identity still works (Open WebUI → planner-ts and Yarn → planner preserve forwarded headers as configured).
5. Rate limits trigger on repeated auth attempts.
6. Cloudflare security events show expected matches for new rules.

## Notes for This Repository

- Admin now supports internal service token auth for worker control-plane APIs.
- Planner supports trusted forwarded identity header handling, plus optional strict mode.
- Helm manages `synesis-internal-service-auth` token secrets through chart values.

Cloudflare should be treated as the outer guardrail; these service-level controls remain required defense in depth.

## Three-Layer Rate Limiting Architecture

Synesis uses three independent rate limiting layers, each with a different purpose:

### Layer 1: Cloudflare (edge)

Enforced before traffic reaches the cluster. Configured in the Cloudflare dashboard as custom rate limiting rules. Protects against volumetric abuse and credential stuffing. See "Example rate limit rules" section below.

### Layer 2: Ingress (cluster boundary)

NGINX ingress annotations can enforce rate limits at the cluster edge. Add annotations per-ingress in `charts/synesis/values.yaml` under `ingress.items.<service>.annotations`:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "30"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "3"
    nginx.ingress.kubernetes.io/limit-connections: "20"
```

### Layer 3: Origin (per-pod, in-memory)

Each service enforces its own rate limits at the application layer. These are per-pod counters, so effective limits scale linearly with replica count.

| Service | Global env | Per-user env | Chart defaults |
|---------|-----------|--------------|----------------|
| planner-ts | `SYNESIS_PLANNER_TS_GLOBAL_RATE_LIMIT_MAX` / `_WINDOW` | `SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS` / `_WINDOW_MS` | 1200/min global, 30/min user |
| yarn-ts | `SYNESIS_YARN_GLOBAL_RATE_LIMIT_MAX` / `_WINDOW` | `SYNESIS_YARN_RATE_LIMIT_MAX_REQUESTS` / `_WINDOW_MS` | 1200/min global, 30/min user |
| synesis-mcp | `SYNESIS_MCP_GLOBAL_RATE_LIMIT_MAX` / `_WINDOW` | (per-route in code) | 1200/min global |
| admin | `SYNESIS_ADMIN_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` | `SYNESIS_ADMIN_AUTH_RATE_LIMIT_MAX`, `SYNESIS_ADMIN_RAG_RATE_LIMIT_MAX` | 120/min global, 20/min auth, 30/min RAG |

For multi-replica deployments: per-pod limits mean the effective per-user limit is `limit * replicas`. Compensate with stricter Cloudflare rules or migrate to Redis-backed rate limiting (planner already supports `SYNESIS_PLANNER_TS_REDIS_URL`).

## Go-Live Checklist (Short)

Use this as a final pre-exposure runbook.

1. **Deploy and reconcile secrets**
   - Run `helm upgrade --install synesis ./charts/synesis -f my-synesis-values.yaml`.
   - Confirm internal auth secret exists:
     - `oc get secret synesis-internal-service-auth -n synesis-admin`
     - `oc get secret synesis-internal-service-auth -n synesis-planner`
     - `oc get secret synesis-internal-service-auth -n synesis-rag`
2. **Confirm no internal-only services are publicly routed**
   - Check routes:
     - `oc get route -A | rg "planner|embedder|keyword|preprocess|spam"`
   - Expect only intended public hosts (`api`, `admin`, `chat`, `auth`, `coder`).
3. **Enable Cloudflare baseline controls**
   - DNS proxied, `Full (strict)`, WAF managed rules, bot protection, HTTPS redirect.
4. **Apply Cloudflare custom WAF rules**
   - Block admin internal/control-plane paths (`/api/v1/ingestion/staged/*`, claim/sync endpoints).
   - Block `/metrics` and docs/openapi on public admin host.
5. **Apply Cloudflare rate limits**
   - Auth/token endpoints: start at `10 req/min/IP`.
   - `POST /v1/chat/completions`: start at `60 req/min/IP`, tune later.
6. **Protect admin with Cloudflare Access**
   - Require IdP login + MFA for `admin.<domain>`.
7. **Smoke-test blocked endpoints from external network**
   - `curl -i https://admin.<domain>/metrics`
   - `curl -i https://admin.<domain>/api/docs`
   - `curl -i -X POST https://admin.<domain>/api/v1/ingestion/staged/items/claim-fetch`
   - Expect block/challenge responses.
8. **Smoke-test normal user paths**
   - Log in via WebUI/admin and run a normal chat/API request.
   - Verify no breakage to intended flows.
9. **(Optional) Enable strict planner forwarded-identity mode**
   - Set `SYNESIS_STRICT_FORWARDED_IDENTITY_MODE=true` after validating trusted upstream caller behavior.
10. **Observe and tune for 24-72h**
   - Review Cloudflare Security Events and app logs.
   - Tighten thresholds and allowlists after real traffic patterns are clear.

## Copy/Paste Examples (Synesis Route Pattern)

These examples follow the route naming convention currently used in this repo:

- `synesis-api.apps.<cluster-domain>`
- `synesis-admin.apps.<cluster-domain>`
- `synesis-auth.apps.<cluster-domain>`
- `synesis.apps.<cluster-domain>` (Open WebUI default route)
- `synesis-yarn.apps.<cluster-domain>` (Yarn route, if explicitly assigned)

Use your real cluster domain in place of `<cluster-domain>`.

### Example host map

- API: `synesis-api.apps.<cluster-domain>`
- Admin: `synesis-admin.apps.<cluster-domain>`
- Auth: `synesis-auth.apps.<cluster-domain>`
- Chat/WebUI: `synesis.apps.<cluster-domain>`
- Coder/Yarn: `synesis-yarn.apps.<cluster-domain>`

### Example WAF custom rules

1) Block staged ingestion control-plane from internet

```text
(http.host eq "synesis-admin.apps.<cluster-domain>" and starts_with(http.request.uri.path, "/api/v1/ingestion/staged/"))
```

Action: `Block`

2) Block non-staged internal queue control-plane endpoints

```text
(http.host eq "synesis-admin.apps.<cluster-domain>" and (
  http.request.uri.path eq "/api/v1/ingestion/items/claim" or
  http.request.uri.path eq "/api/v1/ingestion/schema-sync" or
  http.request.uri.path eq "/api/v1/ingestion/runs" or
  starts_with(http.request.uri.path, "/api/v1/ingestion/items/") or
  starts_with(http.request.uri.path, "/api/v1/ingestion/runs/")
))
```

Action: `Block`

3) Block metrics and OpenAPI/docs on admin edge

```text
(http.host eq "synesis-admin.apps.<cluster-domain>" and (http.request.uri.path eq "/metrics" or starts_with(http.request.uri.path, "/api/docs") or starts_with(http.request.uri.path, "/api/openapi") or starts_with(http.request.uri.path, "/api/redoc")))
```

Action: `Block`

4) Optional admin IP allowlist

```text
(http.host eq "synesis-admin.apps.<cluster-domain>" and not ip.src in {203.0.113.10 198.51.100.0/24})
```

Action: `Block`

### Example rate limit rules

1) Admin OAuth proxy endpoints

- Host: `synesis-admin.apps.<cluster-domain>`
- Paths:
  - `/api/v1/auth/oauth/token`
  - `/api/v1/auth/oauth/refresh`
- Method: `POST`
- Start threshold: `10 requests / 1 minute / IP`
- Mitigation: `Managed challenge` (or `Block`) for `10 minutes`

2) Public chat completions

- Host: `synesis-api.apps.<cluster-domain>`
- Path: `/v1/chat/completions`
- Method: `POST`
- Start threshold: `60 requests / 1 minute / IP`
- Mitigation: `Managed challenge` or `Block` (tune by tenant traffic)

## Advanced Hardening: Cloudflare Tunnel (`cloudflared`)

For stronger origin protection, run `cloudflared` in-cluster and route traffic through a Cloudflare Tunnel instead of exposing public OpenShift Routes directly.

### Why use this

- Removes direct public origin exposure (no public LB/route needed for app services).
- Forces internet traffic to traverse Cloudflare security controls first.
- Simplifies mapping short public hostnames to internal Kubernetes/OpenShift service DNS.

### Recommended architecture

1. Deploy `cloudflared` in cluster (or per environment namespace).
2. Configure tunnel ingress to internal services:
   - `synesis-planner-ts.synesis-planner.svc.cluster.local:8080`
   - `synesis-admin.synesis-admin.svc.cluster.local:8080`
   - `open-webui.synesis-webui.svc.cluster.local:8080`
   - `synesis-keycloak-service.synesis-auth.svc.cluster.local:8080`
   - `synesis-yarn.synesis-yarn.svc.cluster.local:8000`
3. Create Cloudflare DNS records as proxied CNAMEs pointing to `<tunnel-uuid>.cfargotunnel.com`.
4. Apply WAF/Access/rate-limit policies on those public hostnames.

### Example `cloudflared` ingress config

```yaml
tunnel: synesis-prod
credentials-file: /etc/cloudflared/credentials/credentials.json
ingress:
  - hostname: api.example.com
    service: http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080
  - hostname: admin.example.com
    service: http://synesis-admin.synesis-admin.svc.cluster.local:8080
  - hostname: chat.example.com
    service: http://open-webui.synesis-webui.svc.cluster.local:8080
  - hostname: auth.example.com
    service: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080
  - hostname: coder.example.com
    service: http://synesis-yarn.synesis-yarn.svc.cluster.local:8000
  - service: http_status:404
```

### DNS mapping pattern

For each public hostname:

- Type: `CNAME`
- Name: `api` / `admin` / `chat` / `auth` / `coder`
- Target: `<tunnel-uuid>.cfargotunnel.com`
- Proxy status: `Proxied` (orange cloud)

Cloudflare supports CNAME flattening at apex, so `example.com` can also point to the tunnel target if desired.

### Short domain strategy

You can keep short public names while preserving internal service naming:

- Public: `api.example.com` -> Tunnel -> `synesis-planner-ts.synesis-planner.svc...`
- Public: `admin.example.com` -> Tunnel -> `synesis-admin.synesis-admin.svc...`
- Public: `coder.example.com` -> Tunnel -> `synesis-yarn.synesis-yarn.svc...`

This avoids exposing long service/route hostnames externally and decouples public DNS from cluster internals.

### Coder frontend: HTTPS vs Agent Client Protocol (ACP)

- **Normal IDE traffic** to the coder host (`coder.example.com`) uses **HTTPS** (`POST /v1/messages`, `POST /v1/chat/completions`, SSE). Cloudflare proxying, WAF rules, and rate limits apply to these paths as documented above.
- **ACP subprocess agents** (for example [`synesis-yarn-acp`](../base/yarn-ts/src/acp/synesis-yarn-acp.ts)) speak **JSON-RPC over stdio** to the editor locally. They do **not** terminate TLS at Cloudflare; they call **`SYNESIS_YARN_URL`** (your `https://coder.example.com`) via the Node `fetch` client. Ensure:
  - The public hostname resolves and the origin is reachable from the developer machine.
  - **WAF** rules do not block legitimate `POST` bodies to `/v1/messages` (JSON size, content-type `application/json`).
  - If you add a **future** WebSocket or alternate JSON-RPC path on the same host, enable **WebSocket** proxying on Cloudflare and raise **proxy/read timeouts** for long agent turns; `cloudflared` ingress must preserve `Upgrade` on that route.
- **Split horizon:** Edge hardening (Cloudflare + tunnel) protects **browser and IDE HTTPS** clients. **Local ACP** only needs outbound HTTPS to the same `SYNESIS_YARN_URL`.

### Access + Tunnel (recommended combo)

With tunnel hostnames in place:

- Put `admin.example.com` behind Cloudflare Access (IdP + MFA).
- Keep API host public but rate-limited and WAF-protected.
- Keep internal-only endpoints blocked by WAF expressions (as shown above).

### Go-live checks for tunnel mode

1. Confirm app hosts resolve to proxied Cloudflare records.
2. Confirm no direct public route exists for internal services.
3. Test expected 404 from tunnel fallback rule on unknown host/path.
4. Verify Access challenge appears for admin hostname.
5. Verify blocked internal control-plane paths still return blocked/challenged at edge.
6. Verify existing `*.apps.openshiftdemo.dev` route hosts still answer during staged cutover (fallback only).

## Appendix: `cloudflared` Kubernetes/OpenShift Template

Use this as a starting template. Replace placeholder values before apply.

### 1) Namespace + Secret + ConfigMap + Deployment

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: synesis-edge
---
apiVersion: v1
kind: Secret
metadata:
  name: cloudflared-credentials
  namespace: synesis-edge
type: Opaque
stringData:
  # Paste tunnel credentials JSON content from Cloudflare Zero Trust
  credentials.json: |
    {
      "AccountTag": "REPLACE_ACCOUNT_TAG",
      "TunnelSecret": "REPLACE_TUNNEL_SECRET",
      "TunnelID": "REPLACE_TUNNEL_ID"
    }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloudflared-config
  namespace: synesis-edge
data:
  config.yaml: |
    tunnel: REPLACE_TUNNEL_NAME
    credentials-file: /etc/cloudflared/credentials/credentials.json
    ingress:
      - hostname: api.example.com
        service: http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080
      - hostname: admin.example.com
        service: http://synesis-admin.synesis-admin.svc.cluster.local:8080
      - hostname: chat.example.com
        service: http://open-webui.synesis-webui.svc.cluster.local:8080
      - hostname: auth.example.com
        service: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080
      - hostname: coder.example.com
        service: http://synesis-yarn.synesis-yarn.svc.cluster.local:8000
      - service: http_status:404
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: synesis-edge
  labels:
    app.kubernetes.io/name: cloudflared
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: cloudflared
  template:
    metadata:
      labels:
        app.kubernetes.io/name: cloudflared
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          args:
            - tunnel
            - --config
            - /etc/cloudflared/config/config.yaml
            - run
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          volumeMounts:
            - name: config
              mountPath: /etc/cloudflared/config
              readOnly: true
            - name: credentials
              mountPath: /etc/cloudflared/credentials
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: cloudflared-config
        - name: credentials
          secret:
            secretName: cloudflared-credentials
```

### 2) Apply

```bash
oc apply -f cloudflared.yaml
oc rollout status deployment/cloudflared -n synesis-edge
```

### 3) DNS records in Cloudflare

Create proxied CNAMEs:

- `api.example.com` -> `<tunnel-uuid>.cfargotunnel.com`
- `admin.example.com` -> `<tunnel-uuid>.cfargotunnel.com`
- `chat.example.com` -> `<tunnel-uuid>.cfargotunnel.com`
- `auth.example.com` -> `<tunnel-uuid>.cfargotunnel.com`
- `coder.example.com` -> `<tunnel-uuid>.cfargotunnel.com`

### 4) Basic verification

```bash
oc get pods -n synesis-edge -l app.kubernetes.io/name=cloudflared
oc logs -n synesis-edge deployment/cloudflared --tail=200
curl -I https://api.example.com/v1/models
curl -I https://admin.example.com/api/v1/health
```

### 5) Optional tighten-ups

- Pin `cloudflared` image to a known version instead of `latest`.
- Add NetworkPolicy in `synesis-edge` to only allow egress needed for tunnel operation.
- Add PodDisruptionBudget for HA if using replicas >1.

## Optional: Managed by Helm

The Helm chart supports optional cloudflared deployment from values.

Enable with values:

```yaml
cloudflared:
  enabled: true
  tunnel:
    mode: token
    credentialsSecretName: cloudflared-credentials
```

Optional hostname overrides (otherwise derived from existing Routes):

- `ingress.items.synesis-api.host`
- `ingress.items.synesis-admin.host`
- `ingress.items.synesis-webui.host`
- `ingress.items.synesis-auth.host`
- `ingress.items.synesis-yarn.host`

Example:

```bash
helm upgrade synesis ./charts/synesis -f my-synesis-values.yaml
```

Post-deploy non-breaking verification sequence:

```bash
./scripts/verify-cloudflared.sh --check-hosts

# Cloudflare-facing hosts
curl -Ik https://api.kybern.dev/v1/models
curl -Ik https://admin.kybern.dev/api/v1/health
curl -Ik https://chat.kybern.dev
curl -Ik https://auth.kybern.dev/realms/synesis/.well-known/openid-configuration
curl -Ik https://coder.kybern.dev/health

# Keep existing OpenShift routes available as fallback during rollout
oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}{"\n"}'
oc get route synesis-admin -n synesis-admin -o jsonpath='{.spec.host}{"\n"}'
oc get route synesis-webui -n synesis-webui -o jsonpath='{.spec.host}{"\n"}'
oc get route synesis-auth -n synesis-auth -o jsonpath='{.spec.host}{"\n"}'
oc get route synesis-yarn -n synesis-yarn -o jsonpath='{.spec.host}{"\n"}'
```

OIDC edge requirements:

- Keep `https://auth.<domain>/realms/synesis/.well-known/openid-configuration`, `/protocol/openid-connect/auth`, `/protocol/openid-connect/token`, `/protocol/openid-connect/userinfo`, `/protocol/openid-connect/certs`, and `/protocol/openid-connect/auth/device` reachable without a Cloudflare Access browser challenge. Browser SSO, PKCE, device flow, and JWKS validation need machine-readable responses.
- Protect `admin.<domain>` and `auth-admin.<domain>` with Cloudflare Access and MFA where possible. Do not put an Access challenge in front of public OIDC discovery or token endpoints used by clients.
- Rate-limit the Keycloak token and device authorization endpoints at the edge, but allow normal OAuth redirects and polling intervals.
- Yarn and hosted MCP verify OIDC bearer tokens with Keycloak JWKS. They do not need Cloudflare Access service tokens for those bearer checks; they need network reachability to the issuer's JWKS endpoint or the configured in-cluster issuer URL.

Canonical OIDC validation for kybern auth pivot:

```bash
# Admin API must advertise kybern issuer (drives browser login redirect target).
curl -sS https://admin.kybern.dev/api/v1/auth/oidc-config | jq -r '.issuer'
# Expected: https://auth.kybern.dev/realms/synesis

# Keycloak discovery issuer must also be kybern.
curl -sS https://auth.kybern.dev/realms/synesis/.well-known/openid-configuration | jq -r '.issuer'
# Expected: https://auth.kybern.dev/realms/synesis

# Harness/Pi discovery must include core OIDC endpoints.
curl -sS https://auth.kybern.dev/realms/synesis/.well-known/openid-configuration \
  | jq -r '.authorization_endpoint, .token_endpoint, .userinfo_endpoint, .jwks_uri, .device_authorization_endpoint'

# Optional: verify token iss claim from a login token.
TOKEN="<paste-jwt-here>"
python - <<'PY'
import base64, json, os
t = os.environ["TOKEN"].split(".")[1]
t += "=" * (-len(t) % 4)
print(json.loads(base64.urlsafe_b64decode(t))["iss"])
PY
# Expected: https://auth.kybern.dev/realms/synesis
```

Behavior:

- Reconciles `synesis-edge/cloudflared-credentials` secret.
- Renders and applies `synesis-edge/cloudflared-config` from current route hosts.
- Applies `base/edge/cloudflared` deployment.
- Supports both token mode (`SYNESIS_CF_TUNNEL_TOKEN`) and credentials-file mode.
- Rolls `cloudflared` only when config/credentials hash changes.

Verify helper:

```bash
./scripts/verify-cloudflared.sh --check-hosts
```
