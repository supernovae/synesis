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
