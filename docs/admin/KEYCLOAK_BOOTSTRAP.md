# Admin authentication: Keycloak and operator bootstrap

Synesis Admin **does not** ship with hardcoded users, HS256 “dev” JWTs, or `POST /api/v1/auth/login` username/password. That path was removed to avoid weak defaults being mistaken for production-safe auth.

**There is no** `SYNESIS_JWT_SECRET` or default `admin` / `viewer` password on the admin API anymore. After install, you **must** complete Keycloak steps below before anyone can use the Synesis Admin UI or mint Personal Access Tokens (PATs) for scripts.

---

## First-time install: recommended operator story

Follow this order after Helm has applied Keycloak and the `synesis` realm. The chart renders the realm import from `charts/synesis`; the realm defines roles **`synesis-admin`**, **`synesis-org-admin`**, **`synesis-user`**, and the public OIDC client **`synesis-admin`** for the dashboard.

### 1. Confirm the `synesis` realm exists

The **KeycloakRealmImport** resource (e.g. `synesis-realm-import` in namespace `synesis-auth`) imports realm **`synesis`**. In the Keycloak Admin Console you should see that realm in the realm dropdown. It is **not** the same as the **`master`** realm Keycloak uses for its own administration.

Realm discovery for browser clients, Pi-style harnesses, and other OIDC-capable tools is:

```text
https://<keycloak-host>/realms/synesis/.well-known/openid-configuration
```

The discovery document must advertise `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, and `jwks_uri`. When device login is enabled for the harness client, it should also advertise `device_authorization_endpoint`.

### 2. Sign in as Keycloak’s bootstrap (master) administrator

Use your platform’s documented Keycloak admin credentials (often a Kubernetes **Secret** created by the Keycloak operator on first boot, or a one-time password from install logs). That account lives in the **`master`** realm and is for **operating Keycloak** (users, clients, realms). It is **not** used directly by the Synesis Admin SPA OIDC flow, which targets realm **`synesis`**.

### 3. Create a real user in realm `synesis` and grant platform admin

If Helm was installed with `keycloak.realmImport.bootstrapAdmin.enabled=true`,
the chart has already seeded a temporary realm user with `synesis-admin` and
`synesis-user`. Retrieve its password from the Secret named
`synesis-keycloak-bootstrap-admin` in namespace `synesis-auth`, sign in, then
rotate or replace that account.

Still in the Keycloak Admin Console:

1. Switch the realm dropdown from **`master`** to **`synesis`**.
2. Go to **Users** → **Create new user**. Set username and email; turn **Email verified** on if you want smoother OIDC behavior.
3. Open the **Credentials** tab and set a password (or use your org’s password policy flow).
4. Open the **Role mapping** tab → **Assign role** → filter by realm roles → assign **`synesis-admin`**.

Synesis maps the Keycloak realm role **`synesis-admin`** to **platform admin** in the admin API (full dashboard and privileged routes). Use **`synesis-org-admin`** or **`synesis-user`** for lesser roles as needed.

If you use **Organizations** in Keycloak (enabled in the realm import), add the user to the appropriate organization and roles there as well; the admin API reads organization claims when present.

### Realm roles (Open WebUI vs Synesis Admin)

Synesis uses **Keycloak realm roles**, not arbitrary “groups,” for browser SSO. The imported realm defines **`synesis-user`**, **`synesis-org-admin`**, and **`synesis-admin`**, and sets **`defaultRoles`** to **`synesis-user`** so self-registered users can use chat without extra assignment.

| Surface | Realm roles that allow access | Notes |
|--------|-------------------------------|--------|
| **Open WebUI** (chat) | **`synesis-user`** or **`synesis-admin`** | Deployment sets `OAUTH_ALLOWED_ROLES` to these values. If Keycloak login works but Open WebUI still rejects the user, open **Users → _user_ → Role mapping** in realm **`synesis`** and assign **`synesis-user`**. |
| **Open WebUI** (in-app admin features) | **`synesis-admin`** | Matches `OAUTH_ADMIN_ROLES` on the WebUI deployment. |
| **Synesis Admin** (dashboard / API) | **`synesis-admin`** for full platform admin; lesser roles as mapped in the admin API | Same realm role name as WebUI admin; see step 3 above. |
| **Agent harness OIDC** (Pi, local CLIs, hosted MCP/Yarn bearer auth) | **`synesis-user`**, **`synesis-org-admin`**, or **`synesis-admin`** | Tokens must be issued by realm **`synesis`** for client **`synesis-harness`**. Synesis validates the token signature through Keycloak JWKS before accepting it. |

**Manually created** users in Keycloak may not receive **`synesis-user`** automatically. Assign it explicitly if they cannot complete Open WebUI OAuth.

### 4. Match client redirect URIs and Web origins to your admin URL

Client **`synesis-admin`** must allow your real Synesis Admin URL:

- **Valid redirect URIs**: `https://<your-admin-host>/*`
- **Web origins**: `https://<your-admin-host>` (no path)

The checked-in realm example uses a demo host; production overlays or a one-time edit in Keycloak must match the Route or ingress you expose.

### 5. Point the Synesis Admin deployment at Keycloak

On the **admin API** deployment, set:

- **`SYNESIS_KEYCLOAK_ISSUER_URL`** — public issuer, e.g. `https://<keycloak-host>/realms/synesis` (must be **`synesis`**, not `master`).
- Optional: **`SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL`** — in-cluster token endpoint base for server-side code exchange from the admin pod.
- Optional: **`SYNESIS_KEYCLOAK_EXPECTED_AZP`** — defaults to `synesis-admin` (binds tokens to that OAuth client when audience verification is off).

### 6. First login to Synesis Admin

Open the Synesis Admin SPA in the browser. It loads `/api/v1/auth/oidc-config`; when OIDC is enabled it redirects to Keycloak. Sign in as the **`synesis`** realm user you created in step 3 (not the `master` bootstrap user unless you deliberately duplicated that account in `synesis`, which is discouraged).

### 7. Automation after a human can log in

- **Personal Access Tokens (PATs)** — prefix `syn-...`, created in the admin UI. Required for `scripts/load-bootstrap.sh` and similar (`SYNESIS_ADMIN_TOKEN` or `-t`).
- **Keycloak access tokens** — alternative for scripts if obtained from Keycloak directly for client `synesis-admin` / realm `synesis` (not via the removed admin login API).

```http
Authorization: Bearer <token>
```

Example:

```bash
export SYNESIS_ADMIN_TOKEN='syn-...'
./scripts/load-bootstrap.sh -a "https://your-admin-host"
```

### Harness OIDC client (`synesis-harness`)

The realm import also creates public client **`synesis-harness`** for non-browser agent harnesses such as Pi, local CLIs, and hosted MCP/Yarn bearer-token auth.

Use these client settings when configuring a harness:

- **Issuer / discovery**: `https://<keycloak-host>/realms/synesis/.well-known/openid-configuration`
- **Client ID**: `synesis-harness`
- **Client secret**: none; this is a public client.
- **Flows**: Authorization Code + PKCE (`S256`) and Device Authorization Grant.
- **Redirect URIs**: loopback redirects such as `http://127.0.0.1/*` and `http://localhost/*` are allowed by default.
- **Required token role**: at least one of `synesis-user`, `synesis-org-admin`, or `synesis-admin`.

Yarn and hosted MCP accept these JWTs only when their OIDC issuer env is configured. PATs remain supported and unchanged.

```yaml
SYNESIS_OIDC_ISSUER_URL: https://<keycloak-host>/realms/synesis
SYNESIS_OIDC_INTERNAL_ISSUER_URL: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080/realms/synesis
SYNESIS_OIDC_ALLOWED_CLIENT_IDS: synesis-harness
SYNESIS_OIDC_REQUIRED_ROLES: synesis-user,synesis-org-admin,synesis-admin
```

The public issuer must match the JWT `iss` claim exactly. The optional internal issuer is used only for server-side JWKS retrieval inside the cluster.

### 8. Hardening (recommended)

- Rotate the Keycloak **bootstrap / master** admin password from any factory default; store it in a **Secret** and restrict who can read it. Prefer break-glass procedures over long-lived shared “temp” passwords.
- In production, consider disabling **self-registration** in realm **`synesis`** if the imported realm allows it and you want only provisioned users.
- After you have at least one dedicated operator account in **`synesis`** with **`synesis-admin`**, avoid day-to-day use of the **`master`** realm admin for application work.

---

## Interactive UI (browser) — summary

1. Deploy **Keycloak** and realm **`synesis`** (see `base/keycloak/`).
2. Set **`SYNESIS_KEYCLOAK_ISSUER_URL`** on the admin API as above.
3. Open the admin SPA; OIDC redirect runs when `oidc-config` returns `enabled: true`.

## Injecting secrets (OpenShift / Kubernetes)

Prefer **Secrets** (`secretKeyRef`, `envFrom`) for Keycloak admin credentials, PAT material, and any client secrets. Manage deployment environment through Helm values after Keycloak Routes or Ingress hosts and the issuer URL are stable.

---

## Troubleshooting

### User registered or signed in under the wrong realm (`master` vs `synesis`)

Self-registration and normal application login must happen in realm **`synesis`**, not **`master`**. The **`master`** realm is for Keycloak operators only.

- In the Keycloak Admin Console, use the realm dropdown and select **`synesis`** before creating users or enabling self-registration.
- For the account console (password, profile), use the URL under your **`synesis` issuer**, e.g. `https://<keycloak-host>/realms/synesis/account` (match `SYNESIS_KEYCLOAK_ISSUER_URL` on the admin deployment).
- If someone created an account only in **`master`**, create them again in **`synesis`** (or invite them through your IdP flow for that realm) and assign the appropriate realm roles.

### Logout returns to admin but Keycloak session issues, or blank page after logout

In Keycloak, client **`synesis-admin`** (realm **`synesis`**) must allow:

- **Valid post logout redirect URIs** — include `https://<your-admin-host>/*` (see [`base/keycloak/realm-import.yaml`](../../base/keycloak/realm-import.yaml) for examples). If production was configured manually, align with the live admin URL; a mismatch can block or drop the post-logout redirect.

### Session length and “unexpected” re-login

Browser SSO duration is controlled in Keycloak realm **`synesis`** (not in the admin SPA): **Realm settings → Sessions** (e.g. SSO Session Idle, SSO Session Max) and **Clients → synesis-admin → Advanced** (client session idle/timeouts). Increasing these reduces how often users must sign in again at Keycloak when refresh tokens expire. Tune to your org’s policy.
