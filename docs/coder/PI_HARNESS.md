# Pi harness with Synesis Coder

This runbook covers connecting an OIDC-capable Pi harness to the Synesis **coder frontend** (`yarn-ts`).

Use this path when Pi can perform OIDC login itself. Use a Synesis PAT only when Pi is configured as a plain API-key client.

## Endpoints

Use the public coder host for model traffic:

```text
https://<coder-host>
```

OpenAI-compatible clients should target:

```text
https://<coder-host>/v1/chat/completions
https://<coder-host>/v1/models
```

Anthropic-compatible clients should target:

```text
https://<coder-host>/v1/messages
```

## OIDC settings

Pi should use the Keycloak `synesis` realm discovery document:

```text
https://<keycloak-host>/realms/synesis/.well-known/openid-configuration
```

Configure Pi with:

| Field | Value |
|-------|-------|
| Issuer / discovery URL | `https://<keycloak-host>/realms/synesis/.well-known/openid-configuration` |
| Client ID | `synesis-harness` |
| Client secret | none |
| Flow | Authorization Code + PKCE (`S256`) or Device Authorization Grant |
| Redirect URI | loopback URI, for example `http://127.0.0.1/<callback>` |
| Token type | access token as `Authorization: Bearer <token>` |
| Required role | one of `synesis-user`, `synesis-org-admin`, or `synesis-admin` |

The chart-created `synesis-harness` client allows loopback redirects by default:

```text
http://127.0.0.1/*
http://localhost/*
```

The token issuer must be exactly:

```text
https://<keycloak-host>/realms/synesis
```

## Yarn deployment requirements

Yarn accepts Pi OIDC bearer tokens only when OIDC validation is enabled:

```yaml
SYNESIS_OIDC_ISSUER_URL: https://<keycloak-host>/realms/synesis
SYNESIS_OIDC_INTERNAL_ISSUER_URL: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080/realms/synesis
SYNESIS_OIDC_ALLOWED_CLIENT_IDS: synesis-harness
SYNESIS_OIDC_REQUIRED_ROLES: synesis-user,synesis-org-admin,synesis-admin
```

`SYNESIS_OIDC_ISSUER_URL` is the public issuer and must match the JWT `iss` claim. `SYNESIS_OIDC_INTERNAL_ISSUER_URL` is optional and is used by Yarn for in-cluster JWKS retrieval.

PAT auth remains available. Tokens starting with `syn-` still use PAT validation; other bearer tokens use OIDC validation when configured.

## Example Pi configuration shape

Pi configuration names may differ by release, but the values should map to this shape:

```json
{
  "provider": "synesis-coder",
  "apiBaseUrl": "https://<coder-host>/v1",
  "chatCompletionsUrl": "https://<coder-host>/v1/chat/completions",
  "modelsUrl": "https://<coder-host>/v1/models",
  "auth": {
    "type": "oidc",
    "discoveryUrl": "https://<keycloak-host>/realms/synesis/.well-known/openid-configuration",
    "clientId": "synesis-harness",
    "pkce": true,
    "deviceFlow": true,
    "scopes": ["openid", "profile", "email"]
  },
  "defaultModel": "synesis-core"
}
```

If Pi expects an API-key field instead of first-class OIDC fields, use the OIDC access token as the bearer token value. Do not use an ID token for coder requests.

## Cloudflare requirements

If Cloudflare fronts Keycloak, do not put a Cloudflare Access browser challenge in front of the public OIDC endpoints Pi needs:

- `/.well-known/openid-configuration`
- `/protocol/openid-connect/auth`
- `/protocol/openid-connect/token`
- `/protocol/openid-connect/userinfo`
- `/protocol/openid-connect/certs`
- `/protocol/openid-connect/auth/device`

It is fine to protect `admin.<domain>` and `auth-admin.<domain>` with Cloudflare Access/MFA. Rate-limit the token and device endpoints, but keep their machine-readable responses available to Pi.

## Verification

Check discovery:

```bash
curl -sS "https://<keycloak-host>/realms/synesis/.well-known/openid-configuration" \
  | jq -r '.issuer, .authorization_endpoint, .token_endpoint, .userinfo_endpoint, .jwks_uri, .device_authorization_endpoint'
```

Expected issuer:

```text
https://<keycloak-host>/realms/synesis
```

Check Yarn model discovery:

```bash
curl -sS \
  -H "Authorization: Bearer $PI_OIDC_ACCESS_TOKEN" \
  "https://<coder-host>/v1/models" \
  | jq .
```

Check a minimal OpenAI-compatible completion:

```bash
curl -sS "https://<coder-host>/v1/chat/completions" \
  -H "Authorization: Bearer $PI_OIDC_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-core",
    "messages": [{"role": "user", "content": "Reply with OK."}],
    "stream": false
  }' | jq .
```

## Troubleshooting

**401 Invalid OIDC token**: Confirm Pi is sending an access token from realm `synesis`, not an ID token or a token from `master`. Verify the `iss` claim matches `SYNESIS_OIDC_ISSUER_URL`.

**401 Invalid client**: Confirm Pi uses client ID `synesis-harness`. Yarn accepts only configured clients from `SYNESIS_OIDC_ALLOWED_CLIENT_IDS`.

**401 Missing role / insufficient scope**: Assign `synesis-user`, `synesis-org-admin`, or `synesis-admin` to the user in Keycloak realm `synesis`.

**Discovery works but token validation fails in Yarn**: Check Yarn can reach the JWKS endpoint. In-cluster deployments should set `SYNESIS_OIDC_INTERNAL_ISSUER_URL` to the Keycloak service URL.

**Cloudflare HTML returned to Pi**: The OIDC endpoint is probably behind a browser challenge or WAF rule. Exempt the public OIDC realm endpoints listed above.
