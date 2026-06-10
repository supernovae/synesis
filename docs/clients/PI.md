# Pi With Synesis Coder

Use this guide to connect an OIDC-capable Pi harness to the Synesis **coder frontend** (`yarn-ts`).

Pi should authenticate with the identity provider, not with a long-lived Synesis PAT, when it supports OIDC. Synesis validates Pi's OIDC access token against the Keycloak `synesis` realm and the public client `synesis-harness`.

## Prerequisites

- Synesis coder frontend reachable at `https://<coder-host>`.
- Keycloak realm `synesis` reachable at `https://<keycloak-host>/realms/synesis`.
- A user assigned at least one accepted Synesis realm role:
  - `synesis-user`
  - `synesis-org-admin`
  - `synesis-admin`
- Yarn configured with OIDC validation.

## Endpoints

Coder base URL:

```text
https://<coder-host>
```

OpenAI-compatible Pi clients should use:

```text
https://<coder-host>/v1/chat/completions
https://<coder-host>/v1/models
```

If Pi can speak Anthropic Messages, the Anthropic-compatible route is:

```text
https://<coder-host>/v1/messages
```

## Identity Provider Settings

Configure Pi with the Synesis Keycloak discovery document:

```text
https://<keycloak-host>/realms/synesis/.well-known/openid-configuration
```

| Pi Setting | Value |
|------------|-------|
| Issuer / discovery URL | `https://<keycloak-host>/realms/synesis/.well-known/openid-configuration` |
| Client ID | `synesis-harness` |
| Client secret | none |
| Flow | Authorization Code + PKCE (`S256`) or Device Authorization Grant |
| Redirect URI | Loopback URI, for example `http://127.0.0.1/<callback>` |
| Token sent to Yarn | Access token as `Authorization: Bearer <token>` |
| Required role | `synesis-user`, `synesis-org-admin`, or `synesis-admin` |

Do not send an ID token to Yarn. Yarn expects an access token whose issuer is:

```text
https://<keycloak-host>/realms/synesis
```

The Helm-managed `synesis-harness` client allows loopback redirects by default:

```text
http://127.0.0.1/*
http://localhost/*
```

## Yarn OIDC Requirements

Yarn accepts Pi OIDC bearer tokens only when OIDC validation is enabled.

```yaml
SYNESIS_OIDC_ISSUER_URL: https://<keycloak-host>/realms/synesis
SYNESIS_OIDC_INTERNAL_ISSUER_URL: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080/realms/synesis
SYNESIS_OIDC_ALLOWED_CLIENT_IDS: synesis-harness
SYNESIS_OIDC_REQUIRED_ROLES: synesis-user,synesis-org-admin,synesis-admin
```

`SYNESIS_OIDC_ISSUER_URL` must match the JWT `iss` claim exactly. `SYNESIS_OIDC_INTERNAL_ISSUER_URL` is optional and lets in-cluster Yarn fetch JWKS from the internal Keycloak service while still validating the public issuer.

PAT authentication remains available for clients that cannot do OIDC, but Pi should prefer the identity-provider flow.

## Example Pi Configuration Shape

Pi configuration names can differ by release, but the values should map to this shape:

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

If Pi exposes only an API-key field after completing OIDC login, place the OIDC access token in the bearer-token field. Do not store a long-lived PAT unless Pi cannot support identity-provider login.

## Cloudflare And Edge Requirements

If Cloudflare fronts Keycloak, do not place a browser challenge in front of the OIDC endpoints Pi must call:

- `/.well-known/openid-configuration`
- `/protocol/openid-connect/auth`
- `/protocol/openid-connect/token`
- `/protocol/openid-connect/userinfo`
- `/protocol/openid-connect/certs`
- `/protocol/openid-connect/auth/device`

It is fine to protect admin-only hosts such as `admin.<domain>` or `auth-admin.<domain>` separately. Rate-limit token and device endpoints, but keep their JSON responses available to Pi.

## Verification

Check discovery:

```bash
curl -sS "https://<keycloak-host>/realms/synesis/.well-known/openid-configuration" \
  | jq -r '.issuer, .authorization_endpoint, .token_endpoint, .userinfo_endpoint, .jwks_uri, .device_authorization_endpoint'
```

Check model discovery with Pi's OIDC access token:

```bash
curl -sS \
  -H "Authorization: Bearer $PI_OIDC_ACCESS_TOKEN" \
  "https://<coder-host>/v1/models" | jq .
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

**401 Invalid OIDC token**: Confirm Pi is sending an access token from realm `synesis`, not an ID token or a token from `master`.

**401 Invalid client**: Confirm the token was issued to client ID `synesis-harness`, and Yarn includes `synesis-harness` in `SYNESIS_OIDC_ALLOWED_CLIENT_IDS`.

**401 Missing role**: Assign one of the accepted realm roles to the user in Keycloak realm `synesis`.

**Discovery works but Yarn token validation fails**: Confirm Yarn can reach the JWKS endpoint. In Kubernetes, set `SYNESIS_OIDC_INTERNAL_ISSUER_URL` to the internal Keycloak service URL when public DNS is not reachable from the pod.

**Cloudflare returns HTML to Pi**: The OIDC endpoint is probably behind a browser challenge or WAF rule. Exempt the public OIDC realm endpoints listed above.
