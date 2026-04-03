import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../components/auth/useAuth";
import {
  Building2,
  Check,
  Coins,
  Code2,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Shield,
  User,
} from "lucide-react";

/** Keycloak Account Console — password, email, 2FA (realm synesis). */
function keycloakAccountUrl(): string {
  return `${window.location.origin.replace("synesis-admin", "synesis-auth")}/realms/synesis/account`;
}

function hostUrl(host: string): string {
  return `${window.location.protocol}//${host}`;
}

function openWebUiUrl(): string {
  return hostUrl("chat.kybern.dev");
}

function openAiApiUrl(): string {
  return hostUrl("api.kybern.dev");
}

function yarnUrl(): string {
  return hostUrl("coder.kybern.dev");
}

export default function AccountHome() {
  const { user } = useAuth();
  if (!user) return null;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const kcUrl = keycloakAccountUrl();
  const webUiUrl = openWebUiUrl();
  const openAiUrl = openAiApiUrl();
  const yarnBase = yarnUrl();
  const claudeEnvSnippet = `export ANTHROPIC_BASE_URL="${yarnBase}"
export ANTHROPIC_AUTH_TOKEN="<your-synesis-pat>"
export ENABLE_TOOL_SEARCH=true

# Optional model picker entry in Claude Code
export ANTHROPIC_CUSTOM_MODEL_OPTION="synesis-core"
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Synesis Core"
export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Synesis balanced coder tier"`;

  function copyText(key: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1200);
    });
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Account
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your identity, organization, and credentials for the Synesis Admin API
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
              <User className="h-5 w-5 text-gray-600 dark:text-gray-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Profile & sign-in
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Managed in Keycloak
              </p>
            </div>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500 dark:text-gray-400">Username</dt>
              <dd className="text-right text-gray-900 dark:text-gray-100">
                {user.username}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500 dark:text-gray-400">Dashboard role</dt>
              <dd className="flex items-center gap-1.5">
                {user.role === "admin" ? (
                  <Shield className="h-3.5 w-3.5 text-blue-500" />
                ) : null}
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  {user.role}
                </span>
              </dd>
            </div>
            {user.user_id && (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500 dark:text-gray-400">User ID</dt>
                <dd className="font-mono text-xs text-gray-600 dark:text-gray-400">
                  {user.user_id.slice(0, 12)}…
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Password, email, and security settings are not stored in Synesis.
            Use Keycloak&apos;s account console to change your password or update
            your profile.
          </p>
          <a
            href={kcUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Open Keycloak account
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
              <Building2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Organization
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Membership and org roles from Keycloak
              </p>
            </div>
          </div>
          {user.org_name ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">{user.org_name}</span>
              {user.org_roles && user.org_roles.length > 0 && (
                <span className="text-gray-500 dark:text-gray-400">
                  {" "}
                  · {user.org_roles.join(", ")}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No organization membership on your account.
            </p>
          )}
          <Link
            to="/account/organization"
            className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            View organization details →
          </Link>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-900/20">
              <Coins className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Usage & costs
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Token consumption and spend
              </p>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            View your token usage, estimated costs, and latency broken down by
            time period. Compares estimated pricing-model costs against
            provider-reported actuals when available.
          </p>
          <Link
            to="/account/usage"
            className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            View usage dashboard →
          </Link>
        </div>

        <div className="md:col-span-2 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-900/20">
              <KeyRound className="h-5 w-5 text-amber-700 dark:text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                API tokens (Synesis Admin)
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Programmatic access to this admin service
              </p>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Personal access tokens are issued by the <strong>Synesis Admin API</strong>{" "}
            (<code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">syn-…</code>
            ). Use them in <code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">Authorization: Bearer</code>{" "}
            for scripts (e.g. bootstrap), <code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">curl</code>, and
            automation. They are <strong>not</strong> a separate &quot;Cursor-only&quot;
            product — the same tokens work wherever the docs say to send a PAT to
            Synesis Admin. Other products (IDEs, Yarn) may accept the same format
            when documented.
          </p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Note: token role is captured when the token is created. If your org
            role changes (for example, promoted to org admin), revoke old tokens
            and create a new one.
          </p>
          <Link
            to="/account/tokens"
            className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Create and manage tokens →
          </Link>
        </div>

        <div className="md:col-span-2 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-900/20">
              <Code2 className="h-5 w-5 text-violet-700 dark:text-violet-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Front-end & coder connectivity
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Endpoints and Claude Code setup for Synesis models
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Globe className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                Open WebUI
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Front-end chat interface for Synesis models.
              </p>
              <a
                href={webUiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 break-all text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                {webUiUrl}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => copyText("webui", webUiUrl)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                type="button"
              >
                {copiedKey === "webui" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedKey === "webui" ? "Copied" : "Copy URL"}
              </button>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Globe className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
                OpenAI API
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                OpenAI-compatible API endpoint for Synesis clients.
              </p>
              <a
                href={openAiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 break-all text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                {openAiUrl}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => copyText("openai-api", openAiUrl)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                type="button"
              >
                {copiedKey === "openai-api" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedKey === "openai-api" ? "Copied" : "Copy URL"}
              </button>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Code2 className="h-4 w-4 text-violet-700 dark:text-violet-400" />
                Coder API (Yarn)
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Claude-compatible endpoint for coding agents and IDE integrations,
                including Roo, VS Code extensions, OpenCode, OpenClaw, and other
                OpenAI-compatible clients.
              </p>
              <a
                href={yarnBase}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 break-all text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                {yarnBase}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => copyText("yarn-api", yarnBase)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                type="button"
              >
                {copiedKey === "yarn-api" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedKey === "yarn-api" ? "Copied" : "Copy URL"}
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Client environment setup (Claude Code example)
              </h3>
              <button
                onClick={() => copyText("claude-env", claudeEnvSnippet)}
                className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                type="button"
              >
                {copiedKey === "claude-env" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedKey === "claude-env" ? "Copied" : "Copy snippet"}
              </button>
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Use your Synesis PAT (coder scope) and point your client/agent to the
              Coder API. The snippet below shows a Claude Code example.
              Synesis maps Claude model families to tiers:
              <code className="mx-1 rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">haiku -&gt; synesis-pulse</code>
              <code className="mx-1 rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">sonnet -&gt; synesis-core</code>
              <code className="mx-1 rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">opus -&gt; synesis-horizon</code>.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-gray-950 p-3 text-xs text-gray-100">{claudeEnvSnippet}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
