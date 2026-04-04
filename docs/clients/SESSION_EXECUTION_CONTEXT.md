# Session execution context (Synesis ↔ coder clients)

Frozen contract for **machine-readable** workspace and runtime hints on coder API requests. Yarn-ts merges this into a `<SESSION_EXECUTION_CONTEXT>` system fragment so models anchor paths; optional enforcement can constrain file-tool paths when `project_root` is known.

## Transport

Clients may send **HTTP headers**, **`metadata` on Anthropic `/v1/messages`**, and/or **OpenAI body `metadata`** (passthrough). Precedence for each field is **metadata first**, then header.

### `project_root` (immutable session anchor)

| Source | Key |
|--------|-----|
| Header | `x-synesis-project-root` |
| Header (alias) | `x-synesis-workspace-root` — same meaning; kept for backward compatibility |
| Metadata | `synesis_project_root` (string) |

Resolution order: `synesis_project_root` → `x-synesis-project-root` → `x-synesis-workspace-root`.

### `shell_cwd` (mutable execution directory)

| Source | Key |
|--------|-----|
| Header | `x-synesis-shell-cwd` |
| Metadata | `synesis_shell_cwd` (string) |

### Optional runtime (model tone / debugging)

| Source | Key |
|--------|-----|
| Metadata object | `synesis_runtime` with optional string fields: `platform`, `os_version`, `shell` |

### Optional short strings (truncate client-side; yarn-ts caps length)

| Metadata key | Max length (server) | Purpose |
|----------------|---------------------|---------|
| `synesis_git_summary` | 500 | Short git status / branch summary |
| `synesis_client_model_label` | 256 | Display-only client model name |
| `synesis_knowledge_cutoff` | 128 | Knowledge cutoff label if known |

## Yarn-ts behavior

- When any field resolves non-empty, yarn-ts appends `<SESSION_EXECUTION_CONTEXT>…</SESSION_EXECUTION_CONTEXT>` after `<CLIENT_ADAPTER>` (replacing the legacy standalone `<WORKSPACE_ROOT>` block).
- Path policy lines (no nested duplicate folder names, file tools relative to `project_root`, shell `cd` semantics) are included when `project_root` is set. When only `shell_cwd` is set (no `project_root`), yarn-ts still adds a short duplicate-segment warning.
- For Anthropic `/v1/messages`, if **no** session fields resolve and `x-synesis-client` is `claude-code` (the default when the header is omitted), yarn-ts appends a `<PATH_HYGIENE>` fallback so models still see cwd/nesting/rm-safety nudges until a proxy or hook adds real roots.
- Optional env `SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME=true` (default): `project_root` / `shell_cwd` are also echoed inside `<WORKING_FRAME>` when provided.
- Optional env `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE=true` (default **true**): Read/Write/Edit/Update `file_path` values are constrained to resolve under `project_root` (or `shell_cwd` when `project_root` is absent) across coder routes (string prefix check after `path.resolve`).
- Optional env `SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED=true` (default **true**): blocks risky `mkdir && cd` duplicate-segment drift by rewriting the Bash call to a safe error command.
- Synthetic workspace handshake is disabled in fix-forward strict mode. Clients should provide `project_root` and `shell_cwd` anchors directly via headers or metadata on every request.

## Client implementation notes

- **ACP bridge (`synesis-yarn-acp`):** uses **`POST /v1/chat/completions`** with OpenAI body **`metadata`** (no extra headers required). It sets **`synesis_shell_cwd`** from the ACP session **`cwd`**, **`synesis_project_root`** from the first **`additionalDirectories`** entry or **`cwd`**, **`synesis_client_model_label`** from **`initialize.clientInfo`**, and merges supported **`_meta`** hints (`platform`, `os`, `os_version`, `shell`, nested `synesis_runtime`, optional `synesis_git_summary`) into the same keys as table-driven clients. Request header **`x-synesis-client`: `synesis-acp`** identifies the bridge in logs and adapter resolution.
- **Claude Code:** the stock CLI does not add these fields. Typical pattern: a **small reverse proxy** in front of `ANTHROPIC_BASE_URL` that copies the upstream request and adds `x-synesis-project-root` / `x-synesis-shell-cwd` from the machine environment (or from a sidecar file updated by a [SessionStart hook](https://code.claude.com/docs/en/hooks)). A maintained **hook + proxy** bundle lives at repo root **[`clients/claude-code/`](../../clients/claude-code/)** (see [CLAUDECODE.md](CLAUDECODE.md)). See [CLAUDECODE.md](CLAUDECODE.md) for Bash containment (`PreToolUse`).
- **Other IDEs:** the same header/metadata names apply; many stacks use a small reverse proxy in front of the OpenAI or Anthropic base URL.

### Example proxy sketch (Node.js)

Illustrative only — adapt TLS, auth forwarding, and error handling for production.

```js
// Forward POST /v1/messages to REAL_ANTHROPIC_BASE, adding path headers from env.
import http from "node:http";
import { request as httpRequest } from "node:http";
const UPSTREAM = process.env.REAL_ANTHROPIC_BASE || "http://127.0.0.1:8080";
const ROOT = process.env.SYNESIS_PROJECT_ROOT || "";
const CWD = process.env.SYNESIS_SHELL_CWD || "";
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/")) {
    res.writeHead(404); res.end(); return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, "http://localhost");
    const opt = { hostname: new URL(UPSTREAM).hostname, port: new URL(UPSTREAM).port || 80, path: u.pathname + u.search, method: "POST", headers: { ...req.headers, host: new URL(UPSTREAM).host } };
    if (ROOT) opt.headers["x-synesis-project-root"] = ROOT;
    if (CWD) opt.headers["x-synesis-shell-cwd"] = CWD;
    const p = httpRequest(opt, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(); });
    p.end(body);
  });
});
server.listen(3009, () => console.log("proxy on :3009"));
```

Run with `SYNESIS_PROJECT_ROOT=$(git rev-parse --show-toplevel)` and `SYNESIS_SHELL_CWD=$PWD` before starting Claude Code, and `export ANTHROPIC_BASE_URL=http://127.0.0.1:3009`.
