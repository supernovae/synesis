# Admin authentication: Keycloak and operator bootstrap

Synesis Admin **does not** ship with hardcoded users, HS256 “dev” JWTs, or `POST /api/v1/auth/login` username/password. That path was removed to avoid weak defaults being mistaken for production-safe auth.

**There is no** `SYNESIS_JWT_SECRET` or default `admin` / `viewer` password on the admin API anymore. After install, you **must** complete Keycloak steps below before anyone can use the Synesis Admin UI or mint Personal Access Tokens (PATs) for scripts.

---

## First-time install: recommended operator story

Follow this order after `deploy.sh` (or equivalent) has applied Keycloak and the `synesis` realm. Manifests live under [`base/keycloak/`](../../base/keycloak/); the realm defines roles **`synesis-admin`**, **`synesis-org-admin`**, **`synesis-user`**, and the public OIDC client **`synesis-admin`** for the dashboard.

### 1. Confirm the `synesis` realm exists

The **KeycloakRealmImport** resource (e.g. `synesis-realm-import` in namespace `synesis-auth`) imports realm **`synesis`**. In the Keycloak Admin Console you should see that realm in the realm dropdown. It is **not** the same as the **`master`** realm Keycloak uses for its own administration.

### 2. Sign in as Keycloak’s bootstrap (master) administrator

Use your platform’s documented Keycloak admin credentials (often a Kubernetes **Secret** created by the Keycloak operator on first boot, or a one-time password from install logs). That account lives in the **`master`** realm and is for **operating Keycloak** (users, clients, realms). It is **not** used directly by the Synesis Admin SPA OIDC flow, which targets realm **`synesis`**.

### 3. Create a real user in realm `synesis` and grant platform admin

Still in the Keycloak Admin Console:

1. Switch the realm dropdown from **`master`** to **`synesis`**.
2. Go to **Users** → **Create new user**. Set username and email; turn **Email verified** on if you want smoother OIDC behavior.
3. Open the **Credentials** tab and set a password (or use your org’s password policy flow).
4. Open the **Role mapping** tab → **Assign role** → filter by realm roles → assign **`synesis-admin`**.

Synesis maps the Keycloak realm role **`synesis-admin`** to **platform admin** in the admin API (full dashboard and privileged routes). Use **`synesis-org-admin`** or **`synesis-user`** for lesser roles as needed.

If you use **Organizations** in Keycloak (enabled in the realm import), add the user to the appropriate organization and roles there as well; the admin API reads organization claims when present.

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

Prefer **Secrets** (`secretKeyRef`, `envFrom`) for Keycloak admin credentials, PAT material, and any client secrets. Patch the admin deployment after Keycloak Routes and the issuer URL are stable (see `scripts/deploy.sh` patterns for other services).
