# Production Security Guide

This document covers security configuration required for deploying Synesis in a production, multi-tenant environment. It is the canonical reference for identity trust, service authentication, and API hardening.

---

## 1. Identity Trust Model

### Overview

Synesis uses a layered trust model for identifying callers on the planner's `/v1/chat/completions` endpoint. Understanding this model is critical for preventing identity spoofing.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Planner Auth Gate                                │
│                                                                     │
│  1. Extract Bearer token from Authorization header                  │
│  2. Is it a PAT (syn-…)?                                           │
│     → YES: Identity from admin DB (user_id, org_id, scopes)        │
│            Forwarded headers IGNORED. No 403 risk.                  │
│  3. Is it a trusted service bearer (internal_service_token)?        │
│     → YES: Trust x-openwebui-* and x-synesis-org-* headers         │
│     → NO:  Reject forwarded headers.                                │
│            In strict mode: 403 if forwarded headers present.        │
│            In non-strict mode: headers silently ignored (WARNING).  │
└─────────────────────────────────────────────────────────────────────┘
```

### Token Roles

| Token Type | Environment Variable | Purpose | Grants Identity Trust |
|---|---|---|---|
| **Internal service token** | `SYNESIS_INTERNAL_SERVICE_TOKEN` | Service-to-service auth (Open WebUI, Yarn, admin workers) | Yes |
| **Model API key** | `SYNESIS_MODEL_API_KEY` | Outbound auth to LiteLLM gateway / model endpoints | **No** (production default) |
| **PAT** (`syn-…`) | N/A (per-user, stored in admin DB) | End-user personal access token | No — identity from DB row |

### Critical Principle

**Never use the model API key for identity trust.** The model API key is the LiteLLM master key — it is shared across services and known to any consumer of the gateway. Using it for identity trust means any client with the gateway key can spoof user/org identity, leading to:

- Wrong user/org on traces and billing
- Memory cross-contamination between users
- Unauthorized data access via tenant-scoped retrieval
- Audit log poisoning

---

## 2. Required Production Configuration

### Planner

Set these environment variables on the planner deployment:

```yaml
env:
  # Require Bearer token on all requests
  - name: SYNESIS_PLANNER_REQUIRE_BEARER_AUTH
    value: "true"

  # Trust forwarded identity headers from verified upstreams
  - name: SYNESIS_TRUST_FORWARDED_IDENTITY_HEADERS
    value: "true"

  # CRITICAL: Reject requests with forwarded identity headers
  # from bearers that are not internal service tokens
  - name: SYNESIS_STRICT_FORWARDED_IDENTITY_MODE
    value: "true"

  # CRITICAL: Do not accept model API key for identity trust
  - name: SYNESIS_TRUST_MODEL_API_KEY_FOR_FORWARDED_IDENTITY
    value: "false"

  # Internal service token (from shared secret)
  - name: SYNESIS_INTERNAL_SERVICE_TOKEN
    valueFrom:
      secretKeyRef:
        name: synesis-internal-service-auth
        key: token
```

### Yarn

Yarn must authenticate to the planner using the internal service token for escalation requests:

```yaml
env:
  # Internal service token for planner escalation
  - name: SYNESIS_INTERNAL_SERVICE_TOKEN
    valueFrom:
      secretKeyRef:
        name: synesis-internal-service-auth
        key: token
```

The Yarn escalation bridge reads `SYNESIS_INTERNAL_SERVICE_TOKEN` and includes it as `Authorization: Bearer <token>` when forwarding requests to the planner.

### Open WebUI

Open WebUI must be configured to use the **internal service token** (not the model API key) as its Bearer when calling the planner directly. Set the `OPENAI_API_KEY` in the Open WebUI deployment to the value from `synesis-internal-service-auth`:

```yaml
env:
  - name: OPENAI_API_KEY
    valueFrom:
      secretKeyRef:
        name: synesis-internal-service-auth
        key: token
  - name: ENABLE_FORWARD_USER_INFO_HEADERS
    value: "true"
```

This ensures the planner trusts the `x-openwebui-user-id` and `x-openwebui-user-email` headers from Open WebUI.

### LiteLLM Gateway

The gateway's `forward_client_headers_to_llm_api: false` setting is already correct and must remain so. This prevents client Authorization headers from being forwarded to upstream model APIs.

---

## 3. Internal Service Token Management

### Generation and Distribution

The `scripts/deploy.sh` script manages the internal service auth secret:

1. Checks if `synesis-internal-service-auth` exists in any namespace
2. If not found, generates a new random token: `synesis-internal-$(openssl rand -hex 32)`
3. Syncs the secret to all Synesis namespaces: `synesis-admin`, `synesis-rag`, `synesis-planner`, `synesis-yarn`, `synesis-gateway`

### Manual Rotation

To rotate the internal service token:

```bash
# Generate new token
NEW_TOKEN="synesis-internal-$(openssl rand -hex 32)"

# Update in all namespaces
for ns in synesis-admin synesis-rag synesis-planner synesis-yarn synesis-gateway; do
  oc create secret generic synesis-internal-service-auth \
    -n "$ns" \
    --from-literal=token="$NEW_TOKEN" \
    --dry-run=client -o yaml | oc apply -f -
done

# Restart services to pick up new token
oc rollout restart deployment/synesis-planner -n synesis-planner
oc rollout restart deployment/synesis-yarn -n synesis-yarn
```

### Multiple Service Tokens

For environments where different upstreams need distinct tokens (recommended for audit granularity):

```yaml
# Generate per-service tokens
WEBUI_TOKEN="synesis-webui-$(openssl rand -hex 32)"
YARN_TOKEN="synesis-yarn-$(openssl rand -hex 32)"

# On planner deployment:
- name: SYNESIS_INTERNAL_SERVICE_TOKENS
  value: "${WEBUI_TOKEN},${YARN_TOKEN}"
```

This allows log correlation of which upstream made each request.

---

## 4. PAT (Personal Access Token) Security

### Pepper Enforcement

PATs are hashed with HMAC-SHA256 when a pepper is configured. **Without a pepper, PATs use plain SHA-256** which is vulnerable to offline guessing from a database dump.

```yaml
# REQUIRED in production
- name: SYNESIS_PAT_PEPPER
  valueFrom:
    secretKeyRef:
      name: synesis-pat-pepper
      key: pepper
```

Set the same `SYNESIS_PAT_PEPPER` value on all services that validate PATs: planner, yarn, and admin.

### PAT Scopes

PATs carry scopes that restrict their capabilities:

- `model:readonly` — can call `/v1/chat/completions` (default)
- `coder:execute` — can use Yarn coding endpoints
- `admin:read` / `admin:write` — admin API access

---

## 5. Network Policies

Defense in depth: network policies restrict which pods can reach each service, independent of application-level auth.

### Critical Boundaries

| Service | Allowed Ingress |
|---|---|
| Planner (port 8000) | Open WebUI, Yarn, admin (for health checks) |
| Warm pool (port 8080) | Planner only (namespace deny-all + planner ingress) |
| Sandbox pods | No ingress (ephemeral execution only) |
| Milvus (port 19530) | Planner, indexer |
| Admin API (port 8080) | Yarn (for MCP), Open WebUI (for settings) |

Network policies are the first line of defense. Application-level auth (Bearer tokens, RBAC) is the second.

---

## 6. Startup Security Audit

The planner performs a security configuration audit at startup and logs warnings for insecure settings:

| Condition | Log Level | Message |
|---|---|---|
| `trust_model_api_key_for_forwarded_identity=True` | WARNING | Model API key grants identity trust — spoofing risk |
| `strict_forwarded_identity_mode=False` | WARNING | Untrusted forwarded headers silently ignored, not rejected |
| No `internal_service_token(s)` configured | WARNING | No upstream can be trusted for identity forwarding |
| All settings correct | INFO | `identity_trust_config_ok` |

Monitor planner startup logs for these warnings. Any WARNING in production indicates a security misconfiguration that should be resolved immediately.

---

## 7. Security Checklist

Before deploying to production, verify:

- [ ] `SYNESIS_STRICT_FORWARDED_IDENTITY_MODE=true` on planner
- [ ] `SYNESIS_TRUST_MODEL_API_KEY_FOR_FORWARDED_IDENTITY=false` on planner
- [ ] `SYNESIS_INTERNAL_SERVICE_TOKEN` set from `synesis-internal-service-auth` secret on planner, yarn, and admin
- [ ] `SYNESIS_PAT_PEPPER` set on planner, yarn, and admin
- [ ] Open WebUI uses internal service token (not model API key) as `OPENAI_API_KEY`
- [ ] LiteLLM `forward_client_headers_to_llm_api: false` in gateway config
- [ ] Network policies applied for planner, warm pool, sandbox, and Milvus
- [ ] Planner startup logs show `identity_trust_config_ok` (no security WARNINGs)
- [ ] `synesis-internal-service-auth` secret synced to all namespaces
- [ ] PAT pepper is distinct from any other secret value

---

## 8. Backward Compatibility

### Migration from Pre-Hardening Defaults

If upgrading from a deployment where `trust_model_api_key_for_forwarded_identity=True` and `strict_forwarded_identity_mode=False`:

1. **Ensure the internal service token secret exists** in all namespaces (run `scripts/deploy.sh` or manually create)
2. **Update Open WebUI** to use the internal service token as `OPENAI_API_KEY` instead of the model API key
3. **Update Yarn deployment** to mount `synesis-internal-service-auth` secret
4. **Deploy planner** with the new defaults — strict mode will now reject any requests carrying forwarded headers with non-internal-token bearers
5. **Verify** by checking planner logs for `identity_trust_config_ok` and no 403 errors from legitimate upstreams

### Escape Hatch (Not Recommended)

For temporary backward compatibility during migration, you can explicitly opt in to the old behavior:

```yaml
- name: SYNESIS_TRUST_MODEL_API_KEY_FOR_FORWARDED_IDENTITY
  value: "true"   # INSECURE — remove after migration
- name: SYNESIS_STRICT_FORWARDED_IDENTITY_MODE
  value: "false"  # INSECURE — remove after migration
```

The planner will emit WARNING-level logs at startup for these settings.

---

## 9. Service-to-Service Authentication

### Standard: Two-Tier Auth

All internal Synesis services authenticate callers at the application layer. Network policies are defense-in-depth, not the sole security boundary.

**Tier 1 — Bearer Token** (API services):
Simple shared secret as `Authorization: Bearer <token>`. Used by planner, admin, yarn, indexer.

**Tier 2 — HMAC-Signed Request** (execution services):
Per-request HMAC-SHA256 signature bound to the request body. Prevents replay and tampering even if a static token leaks. Used by the warm pool sandbox.

```
Authorization: Bearer HMAC-SHA256:<hex_sig>:<unix_ts>:<nonce>

sig = HMAC-SHA256(secret, "<timestamp>:<nonce>:<sha256(body)>")
```

### Shared Module

`base/security/synesis_service_auth.py` provides both tiers in a single stdlib-only Python file:

- `verify_bearer(token, secrets)` — Tier 1 server-side validation
- `sign_request(body, secret)` — Tier 2 client-side signing
- `verify_request(header, body, secret)` — Tier 2 server-side validation
- `configured_service_tokens(env, envs)` — reads tokens from environment

For app images: import from venv or PYTHONPATH. For minimal images (sandbox): COPY the file at build time.

### Warm Pool Authentication

The warm pool (`POST /execute`) uses Tier 2 HMAC-signed requests:

```yaml
# Warm pool deployment
- name: WARM_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: synesis-internal-service-auth
      key: token

# Planner deployment
- name: SYNESIS_SANDBOX_WARM_POOL_SECRET
  valueFrom:
    secretKeyRef:
      name: synesis-internal-service-auth
      key: token
```

When `WARM_AUTH_SECRET` is empty, auth is disabled (dev mode). The warm pool logs a startup warning.

### Adding Auth to a New Service

1. Determine the tier: executes untrusted input? Tier 2. Otherwise Tier 1.
2. **Server**: call `verify_bearer()` or `verify_request()` before processing
3. **Client**: send Bearer header (Tier 1) or call `sign_request()` (Tier 2)
4. **Secret**: mount `synesis-internal-service-auth` or a dedicated per-service secret
5. **deploy.sh**: ensure the secret is synced to the service's namespace
6. **Network policy**: deny-all + allow ingress from authorized callers
7. **Tests**: verify 401 on invalid/missing credentials

### Service Auth Checklist

- [ ] Warm pool `WARM_AUTH_SECRET` set from `synesis-internal-service-auth`
- [ ] Planner `SYNESIS_SANDBOX_WARM_POOL_SECRET` set from same secret
- [ ] Warm pool startup logs show "HMAC request auth ENABLED"
- [ ] `synesis-internal-service-auth` synced to `synesis-sandbox` namespace
- [ ] All new services follow the two-tier standard (cursor rule: `service-to-service-auth.mdc`)

---

## 10. Future: Service Mesh Adoption Roadmap

### Current State (Application-Layer Auth)

Synesis uses a lightweight, library-based approach to service-to-service auth:
- ~200 lines of stdlib Python (`synesis_service_auth.py`)
- Two tiers: Bearer tokens for APIs, HMAC-signed requests for execution services
- Shared secret distribution via `synesis-internal-service-auth` Kubernetes secret
- Network policies for L3/L4 access control

This is appropriate for the current fleet (~8 Synesis-owned services) and avoids the operational complexity of a full service mesh.

### When to Consider a Service Mesh

Triggers for re-evaluating:
- Fleet grows to **20+ internal services** where managing individual tokens becomes unwieldy
- Requirement for **mutual TLS on all internal traffic** (zero-trust networking)
- Need for **mesh-level observability** (distributed tracing, golden metrics) without per-service instrumentation
- Compliance requirement for **encrypted east-west traffic** between all pods

### Recommended Path: Istio Ambient Mesh

Traditional Istio (sidecar mode) adds ~100-150Mi RAM per pod — disproportionate for lightweight services like the warm pool. **Ambient mesh** (Istio's sidecar-less mode) is the better fit:

- **L4 mTLS via ztunnel** (node-level proxy): encrypted, authenticated transport with no per-pod sidecar overhead
- **Optional L7 waypoint proxies**: only for services that need HTTP-level policy (rate limiting, L7 auth rules)
- **SPIFFE workload identities**: each pod gets a cryptographic identity from the mesh CA — no shared secrets to rotate
- **AuthorizationPolicy**: declarative YAML controls ("service A can call service B on POST /execute")

### OpenShift Considerations

- OpenShift Service Mesh (Maistra/Istio) is transitioning to the **Istio Sail Operator**
- OpenShift AI includes service mesh components but not fully HA out of the box
- Ambient mode is maturing in upstream Istio (graduated to beta in 1.22) — monitor for GA stability before adopting
- The Sail Operator tracks upstream Istio closely, so ambient support will follow

### Adoption Plan (When Ready)

**Phase 1 — Ambient L4 mTLS** (low risk):
- Install Istio Sail Operator with ambient mode
- Enable `istio.io/dataplane-mode=ambient` on Synesis namespaces
- All east-west traffic gets mTLS automatically via ztunnel
- No code changes required; existing Bearer/HMAC auth continues as defense-in-depth

**Phase 2 — L7 Waypoint for Execution Services** (optional):
- Deploy waypoint proxy for `synesis-sandbox` namespace
- Add `AuthorizationPolicy`: only `synesis-planner` ServiceAccount can `POST /execute`
- HMAC signing remains as application-layer defense-in-depth (belt and suspenders)

**Phase 3 — Migrate Tier 1 to Mesh Identity** (future):
- Replace Bearer token checks with mesh `AuthorizationPolicy` for API services
- `synesis_service_auth.verify_bearer()` becomes a no-op behind mesh identity
- Simplify secret management (mesh CA handles identity, no shared secrets)
- Keep Tier 2 HMAC for execution services (body-binding is not a mesh feature)

### Key Principle

The mesh handles **transport identity** (who is calling). Application-layer HMAC handles **request integrity** (the body hasn't been tampered with). These are complementary, not competing — Tier 2 HMAC signing should persist even with a mesh, because a mesh cannot prove that the request body is the same one the caller intended to send.

---

## 11. CI Security Model (Validation Ring)

### Principles

Quality regression tests (H2) that need a running Synesis cluster execute inside the `synesis-validation` namespace. This provides:

- **No long-lived kube credentials** in GitHub repo or PR context
- **Namespace-scoped SA tokens** for in-cluster execution
- **Deny-all network policy** with explicit egress only to planner and admin
- **Environment-protected secrets** with branch protections in GitHub
- **Non-production data** — validation uses synthetic corpus, never customer PII

### Secret Distribution

The `synesis-internal-service-auth` secret is synced to `synesis-validation` by `scripts/deploy.sh`. The validation runner uses it as a Bearer token for planner/admin API calls.

### GitHub Configuration

1. Create a `validation` environment in GitHub Settings > Environments
2. Restrict to `main` branch (or specific branches for staging)
3. Add variables `SYNESIS_PLANNER_EVAL_URL`, optional `SYNESIS_YARN_EVAL_URL`, secrets `SYNESIS_INTERNAL_SERVICE_TOKEN` (internal app token for RAG) and `SYNESIS_TEST_PAT_TOKEN` (PAT for live chat-style workflows) — see `docs/CI_GITHUB_VALIDATION.md`
4. Add variable: `SYNESIS_VALIDATION_ENABLED=true` when workflows use it
5. Do **not** echo secrets in workflow steps; use `::add-mask::` if intermediate variables are needed

### Testing Labs Execution

Testing Labs replay runs execute as K8s Jobs in `synesis-validation`:

```bash
# Manual trigger
oc create -f base/validation-ring/replay-job.yaml \
  --dry-run=client -o yaml | \
  sed "s/value: \"\"/value: \"tl-abc123\"/" | \
  oc apply -f -
```

For governed promotions (model swap approval flows), use the optional Tekton pipeline at `base/validation-ring/tekton/pipeline.yaml`.
