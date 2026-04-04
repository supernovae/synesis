# Open WebUI

Synesis includes a built-in **Open WebUI** instance that provides a polished chat interface for interacting with the AI assistant. **Manifests set** Open WebUI’s `OPENAI_API_BASE_URL` to **planner-ts** (`synesis-planner-ts:8080/v1`) — the browser talks **only** to the planner on that hop. **LiteLLM** (gateway) is for other clients (for example external tools using `synesis-api`); planner-ts reaches upstream models per its own configuration (often LiteLLM in-cluster), which is **separate** from how Open WebUI connects.

Synesis ships a child image (`ghcr.io/supernovae/synesis/open-webui`, based on upstream `v0.8.12`) that injects a branded light/dark theme via `/static/custom.css` and patches Open WebUI middleware so planner streaming responses persist `synesis_run_id` / `synesis_authz_trace_id` on assistant messages (for **Chat Feedback** trace links). Build with `./scripts/build-images.sh --only open-webui`.

## Zero-Configuration Setup

The deploy script automatically:

1. Generates the LiteLLM API key (or reuses an existing one)
2. Copies the key into the `synesis-webui` namespace as a Secret
3. Deploys Open WebUI with the API URL and key pre-injected as environment variables
4. Creates an OpenShift Route at `synesis.apps.openshiftdemo.dev`

On first visit, create an admin account. The `synesis-agent` model is available immediately.

## Routes by Environment

| Environment | Web UI URL | API URL |
|-------------|-----------|---------|
| **Dev** | `https://synesis.apps.openshiftdemo.dev` | `https://synesis-api.apps.openshiftdemo.dev` |
| **Staging** | `https://synesis-staging.apps.openshiftdemo.dev` | `https://synesis-api-staging.apps.openshiftdemo.dev` |
| **Prod** | `https://synesis.apps.openshiftdemo.dev` | `https://synesis-api.apps.openshiftdemo.dev` |

## Available Models by Profile

### Small Profile (dev)

| Model Name | What It Does |
|------------|-------------|
| `synesis-agent` | Full pipeline: Entry → Planner → Router → Writer → Critic → Respond (via Qwen2.5-14B router + Qwen3-32B general) |

In small profile, Qwen2.5-14B-Instruct handles routing, planning, and critic roles on GPU 0. Qwen3-32B handles general/writer on GPU 1. The Coder model runs on GPU 2 but is accessed directly by IDEs, not through Open WebUI.

### Medium/Large Profile (staging/prod)

| Model Name | What It Does |
|------------|-------------|
| `synesis-agent` | Full pipeline: Router → Planner → Worker → Critic → Respond |
| `synesis-router` | Direct access to Router model (Qwen2.5-14B-Instruct) |
| `synesis-critic` | Direct access to Critic model (R1-Distill, deep thinking) |
| `synesis-thinking` | R1-Distill thinking model — dedicated deep reasoning |
| `synesis-coder` | Direct access to Coder model (Qwen3-Coder-Next-FP8) |

## Important: Do NOT point Open WebUI directly at vLLM

The dev overlay configures Open WebUI to talk to the **planner-ts** endpoint (`synesis-planner-ts:8080/v1`), not directly to vLLM. This is intentional:

- **Through the planner**: Thinking tokens are properly handled — router/planner use `enable_thinking=False` for fast classification, critic uses `enable_thinking=True` for reasoning. vLLM's `--enable-reasoning` parser separates thinking into `reasoning_content` (invisible to the user).
- **Directly to vLLM**: The Qwen3 chat template defaults to `enable_thinking=True`. Every response will include thinking tokens, adding latency and potentially showing raw `<think>` blocks in the UI.

If you accidentally set the API URL to a vLLM endpoint in **Admin → Settings → Connections**, reset it by redeploying:

```bash
./scripts/deploy.sh dev
oc rollout restart deployment/open-webui -n synesis-webui
```

## Code Formatting

Open WebUI renders code blocks with syntax highlighting out of the box. When Synesis returns code in fenced markdown blocks, the UI displays them with language-specific syntax highlighting, copy-to-clipboard, and line numbers.

## Phase/Status Display

The planner emits standard SSE status events during graph execution (e.g. Gathering evidence…, Plan ready: N sections). Open WebUI displays these in its **native** status area; do not use a custom Synesis Progress pipe. See [OPENWEBUI_PHASES.md](OPENWEBUI_PHASES.md) for implementation details, production behavior, and troubleshooting.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `WEBUI_AUTH` | `true` | Require login (first user becomes admin) |
| `ENABLE_SIGNUP` | `true` | Allow new user registration |
| `DEFAULT_MODELS` | `Synesis Auto` | Default chat model (tier “Auto”); IDs match planner-ts |
| `DEFAULT_PINNED_MODELS` | `Synesis Auto,Synesis Pulse,…` | Pinned tiers in the model selector for new accounts |
| `DEFAULT_PROMPT_SUGGESTIONS` | (ConfigMap) | JSON array of new-chat prompt suggestion cards (`title` = two-line label, `content` = prompt text). Synesis merges upstream Open WebUI defaults with platform-specific prompts in [`base/webui/default-prompt-suggestions.json`](../base/webui/default-prompt-suggestions.json); injected via `open-webui-default-prompts` ConfigMap. |
| `ENABLE_PERSISTENT_CONFIG` | `false` | Use Deployment env for defaults; otherwise Open WebUI stores first-boot config in SQLite and ignores later env changes (same class of issue as OAuth) |
| `ENABLE_FOLLOW_UP_GENERATION` | `false` | Disables task-model follow-up “chips” after each assistant message (avoids extra LLM calls and trace noise); default upstream is on |
| `ENABLE_TITLE_GENERATION` | `false` | Disables task-model chat title generation (avoids an extra LLM call); Open WebUI falls back to its default heading from the first message text |
| `ENABLE_OLLAMA_API` | `false` | Disabled — chat goes through planner-ts; planner reaches upstream models per its own config (often LiteLLM or direct vLLM) |

### Keycloak realm roles (SSO)

Production WebUI uses Keycloak OIDC with **`OAUTH_ALLOWED_ROLES`** (see [`base/webui/deployment.yaml`](../../base/webui/deployment.yaml)): users need the **`synesis-user`** or **`synesis-admin`** **realm role** in the **`synesis`** realm. Self-registration normally assigns **`synesis-user`** via realm default roles; **manually created** users may need **`synesis-user`** assigned in Keycloak. For a concise table (WebUI vs Synesis Admin vs in-app admin), see [KEYCLOAK_BOOTSTRAP.md](admin/KEYCLOAK_BOOTSTRAP.md#realm-roles-open-webui-vs-synesis-admin).

**Pending vs active in Open WebUI:** Open WebUI’s own role for new users is controlled by **`DEFAULT_USER_ROLE`** (`pending`, `user`, or `admin`). Synesis sets **`DEFAULT_USER_ROLE=user`** so users who complete OIDC are not left in **pending** awaiting a WebUI admin—Keycloak has already enforced allowed realm roles. To require manual approval inside Open WebUI anyway, you would set **`DEFAULT_USER_ROLE=pending`** (not recommended when using Keycloak as the gate).

**Default model and tier dropdown:** Planner exposes **`Synesis Auto`**, **`Synesis Pulse`**, **`Synesis Core`**, and **`Synesis Horizon`** (see `base/planner-ts/src/model-tiers.ts`). The WebUI deployment sets **`DEFAULT_MODELS=Synesis Auto`** and **`DEFAULT_PINNED_MODELS`** to those four IDs so new users get **Auto** as the default with the Synesis tiers in the selector. **`ENABLE_PERSISTENT_CONFIG=false`** keeps these defaults driven by the manifest instead of freezing empty defaults in the PVC on first boot (if you still see “select a model” for old accounts, set defaults once in **Admin → Settings** or rely on a fresh user after rollout).

## Resource Requirements

| Environment | CPU Request | Memory | Storage |
|-------------|-----------|--------|---------|
| Dev | 100m | 256Mi | 5Gi PVC |
| Staging/Prod | 250m | 512Mi | 5Gi PVC |

Prod scales to 2 replicas. The PVC stores user accounts, chat history, and settings.

## Network Policy

Open WebUI egress is open by policy; it only needs the **planner-ts** API (`synesis-planner-ts:8080`). It does not call the LiteLLM gateway for chat. WebUI has no access to Milvus, sandbox, or the rest of the data plane unless you add routes.

## Theme

The Synesis theme lives in `base/webui/synesis-theme.css` and is copied into the child image as `/app/build/static/custom.css`. On every pod start, Open WebUI's config module copies frontend static assets (including `custom.css`) from the image into `STATIC_DIR` on the PVC, so the theme survives volume mounts.

To rebuild after editing the theme:

```bash
./scripts/build-images.sh --only open-webui --push
oc rollout restart deployment/open-webui -n synesis-webui
```

The CSS uses `html.dark` / `html.light` classes (set by Open WebUI's theme switcher) to define separate variable palettes. Admins can still apply additional customizations through Open WebUI's admin interface settings; the image-baked theme provides the baseline.

## Troubleshooting

### `Permission denied: '/app/backend/open_webui/static/...'` in pod logs

The container runs **non-root**; the image’s bundled static directory is not writable. Set **`STATIC_DIR`** to a writable path on the PVC (e.g. `/app/backend/data/static`) — Synesis does this in `base/webui/deployment.yaml`. Open WebUI copies assets from the read-only build into that directory at startup.

### Auth page shows only “Sign in to Synesis” — no Keycloak button

Open WebUI needs a public **WEBUI_URL** (same origin users use in the browser) so OIDC redirect URIs and the SSO button are built correctly. It is set in `base/webui/deployment.yaml` to match the OpenShift Route host. If you change the Route host, patch `WEBUI_URL` to the same value and restart Open WebUI.

**Still blank after fixing `WEBUI_URL`?** Open WebUI stores OAuth settings in its SQLite DB on first boot. Set **`ENABLE_OAUTH_PERSISTENT_CONFIG=false`** (in the same Deployment) so env vars always win, then restart the pod.

**OIDC not registering (blank `/auth`, redirect churn):** Open WebUI only enables the OIDC client when **`OAUTH_CLIENT_SECRET` is set *or* `OAUTH_CODE_CHALLENGE_METHOD=S256`** (public Keycloak clients need PKCE). Also set **`OPENID_REDIRECT_URI`** to the public callback URL (e.g. `https://<webui-host>/oauth/oidc/callback`) so the redirect URI is not derived as `http://` from in-cluster request URLs behind the OpenShift route.

**“Email or password is incorrect” during Keycloak SSO:** Open WebUI maps **`invalid_scope`** (and other OAuth errors) to that generic message. The usual cause is Keycloak missing **`openid` / `profile` / `email`** client scopes on the `synesis` realm. Run **`./scripts/ensure-keycloak-oidc-scopes.sh`** (or redeploy with `./scripts/deploy.sh`, which runs it after Keycloak is ready).

**“This email is already registered” after Keycloak:** An Open WebUI local user already exists for that email. Set **`OAUTH_MERGE_ACCOUNTS_BY_EMAIL=true`** (in `base/webui/deployment.yaml`) so OIDC sign-in attaches to the existing account instead of failing.

```bash
oc logs -n synesis-webui -l app.kubernetes.io/name=open-webui --tail=200
```

See also: [Open WebUI SSO troubleshooting](https://docs.openwebui.com/troubleshooting/sso/).

### "500: Open WebUI: Server Connection Error"

**Cause:** (a) Open WebUI cannot reach its backend, (b) bad URL persisted in Admin → Settings, or (c) planner's graph execution failed (models down, timeout, etc.).

**If /v1/models works but chat fails:** The planner is reachable; the failure is during graph execution. Check:

```bash
oc logs -n synesis-planner -l app.kubernetes.io/name=synesis-planner --tail=100
```

**Quick fixes:**

1. **Reset persisted config** — dev-webui overlay sets `RESET_CONFIG_ON_START=true` so env vars override DB. Re-apply and restart:
   ```bash
   kustomize build overlays/dev-webui | oc apply -f -
   oc rollout restart deployment/open-webui -n synesis-webui
   ```

2. **Verify planner-ts is reachable**:
   ```bash
   oc get deployment synesis-planner-ts -n synesis-planner
   oc get svc synesis-planner-ts -n synesis-planner
   oc get pods -n synesis-planner -l app.kubernetes.io/name=synesis-planner-ts
   oc run -it --rm debug --image=curlimages/curl --restart=Never -n synesis-webui -- \
     curl -s http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080/v1/models
   ```

3. **Switch to LiteLLM** — if planner path is broken, remove the direct-planner patch and set `OPENAI_API_BASE_URL` to `http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/v1`.

### "Connection error" / "OpenAIException" for synesis-agent

The dev overlay includes `openwebui-direct-planner.yaml`, which pins Open WebUI at planner-ts (same default as `base/webui/deployment.yaml`). Use it when you want to force in-cluster planner URL after overlay experiments.

See [OPENWEBUI_ADMIN_GUIDE.md](OPENWEBUI_ADMIN_GUIDE.md) for admin dashboard import and feedback plugin setup.

**Evaluation / “Submit feedback” in Open WebUI** is stored in Open WebUI’s own database. To see it in **synesis-admin → Chat Feedback**, configure `SYNESIS_OPENWEBUI_URL` and `SYNESIS_OPENWEBUI_ADMIN_TOKEN` on the admin deployment and use **Sync from Open WebUI** (see [FEEDBACK_API.md](FEEDBACK_API.md)). Deploy the Synesis-built `open-webui` image (`./scripts/build-images.sh --only open-webui`) so planner `run_id` is stored on assistant messages for trace correlation after sync.

---

Back to [README](../README.md) | See also: [Open WebUI Phases](OPENWEBUI_PHASES.md), [Admin Guide](OPENWEBUI_ADMIN_GUIDE.md)
