import { useState } from "react";
import { Link } from "react-router-dom";
import { useUpdateUserRuntimePreferences, useUserRuntimePreferences } from "../../api/hooks";
import { useAuth } from "../../components/auth/useAuth";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import type { UserRuntimePreferences } from "../../types";
import {
  buildKeycloakAccountUrl,
  buildKeycloakPasswordUrl,
  getKeycloakRealmName,
} from "../../utils/keycloakUrls";
import {
  Building2,
  Check,
  Coins,
  Code2,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  SlidersHorizontal,
  Shield,
  User,
} from "lucide-react";

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

const DEFAULT_RUNTIME_DRAFT: UserRuntimePreferences = {
  loopBreakMode: "standard",
  cachePolicyBias: "auto",
  synesisMemoryMode: "adapt",
  allowAggressiveCompactionWithoutCacheHits: true,
  maxToolLoopSoftFails: null,
  updatedAt: 0,
};

export default function AccountHome() {
  const { user, oidcConfig } = useAuth();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { data: runtimePrefs, isError: runtimePrefsError, error: runtimePrefsLoadError } = useUserRuntimePreferences(Boolean(user));
  const updateRuntimePrefs = useUpdateUserRuntimePreferences();
  const [runtimeDraftOverride, setRuntimeDraftOverride] = useState<Partial<UserRuntimePreferences> | null>(null);
  const runtimeDraft: UserRuntimePreferences = {
    ...(runtimePrefs?.preferences ?? DEFAULT_RUNTIME_DRAFT),
    ...(runtimeDraftOverride ?? {}),
  };

  if (!user) return null;

  const kcUrl = buildKeycloakAccountUrl(oidcConfig?.issuer);
  const kcPasswordUrl = buildKeycloakPasswordUrl(oidcConfig?.issuer);
  const keycloakRealm = getKeycloakRealmName(oidcConfig?.issuer);
  const webUiUrl = openWebUiUrl();
  const openAiBase = openAiApiUrl();
  const openAiUrl = `${openAiBase}/v1`;
  const yarnBase = yarnUrl();
  const yarnApiUrl = `${yarnBase}/v1`;
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

  function updateRuntimeDraft<K extends keyof UserRuntimePreferences>(key: K, value: UserRuntimePreferences[K]) {
    setRuntimeDraftOverride((curr) => ({ ...(curr ?? {}), [key]: value }));
  }

  function saveRuntimePreferences() {
    updateRuntimePrefs.mutate(
      { ...runtimeDraft, updatedAt: Date.now() },
      { onSuccess: (response) => setRuntimeDraftOverride(response.preferences) },
    );
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
            Use the Synesis realm account console in Keycloak to change your
            password or update your profile.
          </p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
            <span className="uppercase tracking-wide">Realm</span>
            <code className="rounded bg-white/80 px-1.5 py-0.5 text-[11px] dark:bg-indigo-950/40">
              {keycloakRealm}
            </code>
          </div>
          <div className="mt-4 flex flex-col items-start gap-2">
            <a
              href={kcUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Open Keycloak account
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <a
              href={kcPasswordUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Change/reset password in Keycloak
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
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
                Usage & pricing
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Token consumption and usage price
              </p>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            View your token usage, rate-card price, cache discounts, and latency
            broken down by time period and API key.
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
            Synesis Admin. Other products (IDEs, Coder API clients) may accept the
            same format when documented.
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
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 dark:bg-sky-900/20">
              <SlidersHorizontal className="h-5 w-5 text-sky-700 dark:text-sky-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Coder runtime controls
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Advanced loop and token-economics behavior for your Coder sessions
              </p>
            </div>
          </div>
          <ApiErrorBanner error={runtimePrefsError ? runtimePrefsLoadError : undefined} />
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Loop break mode</span>
              <select
                value={runtimeDraft.loopBreakMode}
                onChange={(event) => updateRuntimeDraft("loopBreakMode", event.target.value as UserRuntimePreferences["loopBreakMode"])}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                <option value="standard">Standard</option>
                <option value="assertive">Assertive</option>
                <option value="hands_off">Hands off</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Cache policy bias</span>
              <select
                value={runtimeDraft.cachePolicyBias}
                onChange={(event) => updateRuntimeDraft("cachePolicyBias", event.target.value as UserRuntimePreferences["cachePolicyBias"])}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                <option value="auto">Auto</option>
                <option value="cache_first">Cache first</option>
                <option value="balanced">Balanced</option>
                <option value="efficiency_first">Efficiency first</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Synesis memory</span>
              <select
                value={runtimeDraft.synesisMemoryMode}
                onChange={(event) => updateRuntimeDraft("synesisMemoryMode", event.target.value as UserRuntimePreferences["synesisMemoryMode"])}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                <option value="off">Off</option>
                <option value="observe">Observe</option>
                <option value="adapt">Adapt</option>
                <option value="strict">Strict</option>
              </select>
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                Controls durable work packet replay for models that benefit from recent task state near the prompt tail.
              </span>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Loop soft-fail limit</span>
              <input
                type="number"
                min={1}
                max={20}
                value={runtimeDraft.maxToolLoopSoftFails ?? ""}
                placeholder="Default"
                onChange={(event) => {
                  const value = event.target.value.trim();
                  updateRuntimeDraft("maxToolLoopSoftFails", value ? Number(value) : null);
                }}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              />
            </label>
            <label className="flex items-start gap-3 rounded border border-gray-200 p-3 text-sm dark:border-gray-700">
              <input
                type="checkbox"
                checked={runtimeDraft.allowAggressiveCompactionWithoutCacheHits}
                onChange={(event) => updateRuntimeDraft("allowAggressiveCompactionWithoutCacheHits", event.target.checked)}
                className="mt-1"
              />
              <span className="text-gray-700 dark:text-gray-300">
                Allow aggressive compaction when provider cache hits are unavailable and loop risk is low
              </span>
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={saveRuntimePreferences}
              disabled={updateRuntimePrefs.isPending}
              className="inline-flex items-center gap-2 rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Check className="h-4 w-4" />
              {updateRuntimePrefs.isPending ? "Saving" : "Save controls"}
            </button>
            {updateRuntimePrefs.isSuccess ? (
              <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>
            ) : null}
          </div>
          <ApiErrorBanner error={updateRuntimePrefs.isError ? updateRuntimePrefs.error : undefined} />
        </div>

        <div className="md:col-span-2 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-900/20">
              <Code2 className="h-5 w-5 text-violet-700 dark:text-violet-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Chat &amp; Coder connectivity
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Chat API, Coder API, and Claude Code setup for Synesis models
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
                Chat API
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                OpenAI-compatible chat endpoint (Synesis Chat / pipeline front-door).
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
                Coder API
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Claude-compatible endpoint for coding agents and IDE integrations,
                including Roo, VS Code extensions, OpenCode, OpenClaw, and other
                OpenAI-compatible clients.
              </p>
              <a
                href={yarnApiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 break-all text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                {yarnApiUrl}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => copyText("yarn-api", yarnApiUrl)}
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
              Use your Synesis PAT (Coder API scope) and point your client/agent to
              the Coder API. The snippet below shows a Claude Code example.
              Some clients append <code className="mx-1 rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">/v1</code>{" "}
              automatically, so if requests fail check for a double suffix like{" "}
              <code className="mx-1 rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">/v1/v1</code>{" "}
              and remove one.
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
